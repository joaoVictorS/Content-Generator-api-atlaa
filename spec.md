# Spec — AI Content Generator API

Plano de implementação para o desafio técnico backend sênior. Este documento é o
contrato de arquitetura antes de começar a escrever código.

## 1. Stack e decisões de bibliotecas

| Requisito         | Escolha                                                              |
|--------------------|-----------------------------------------------------------------------|
| Linguagem          | Node.js 20 + TypeScript (`strict: true`)                              |
| Web framework      | Fastify 4                                                             |
| Validação          | Zod + `fastify-type-provider-zod` (gera schemas Fastify e OpenAPI a partir dos mesmos schemas Zod, sem duplicar) |
| ORM                | Prisma + PostgreSQL                                                    |
| Fila               | BullMQ + Redis (ioredis)                                              |
| Storage            | Minio via AWS SDK v3 (`@aws-sdk/client-s3`), endpoint configurável — troca para S3 real só mudando env vars |
| Docs               | `@fastify/swagger` + `@fastify/swagger-ui` em `/docs`                  |
| Logger             | Pino (embutido no Fastify)                                             |
| Testes             | Vitest                                                                 |
| Container          | Docker + docker-compose                                                |

## 2. Modelo de domínio (Prisma)

```prisma
model User {
  id        String    @id @default(uuid())
  name      String
  credits   Int       @default(10)
  contents  Content[]
  createdAt DateTime  @default(now())
}

enum ContentStatus {
  PENDING
  PROCESSING
  COMPLETED
  CANCELED
  FAILED
}

model Content {
  id           String        @id @default(uuid())
  topic        String
  status       ContentStatus @default(PENDING)
  fileUrl      String?
  errorMessage String?
  userId       String
  user         User          @relation(fields: [userId], references: [id])
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt

  @@index([userId])
}
```

**Assunção**: não há endpoint de cadastro/autenticação de usuário no escopo do
desafio. Vamos incluir um `prisma/seed.ts` que cria 2-3 usuários com créditos
para permitir testar `generate` de ponta a ponta. Isso vai para o README como
"usuários de teste".

## 3. Estrutura de pastas (Clean Architecture / camadas)

```
src/
  domain/
    entities/            // Content, User (tipos puros, sem Prisma)
    repositories/         // interfaces: IContentRepository, IUserRepository
    errors/               // AppError, NotFoundError, InsufficientCreditsError, InvalidStateError
  application/
    services/
      content.service.ts  // regras de negócio: generate/get/cancel
    dto/
      content.schemas.ts  // Zod schemas (request/response) — únicos, reusados por rotas e Swagger
  infrastructure/
    prisma/
      client.ts
      content.repository.prisma.ts
      user.repository.prisma.ts
    queue/
      connection.ts
      content.queue.ts     // producer
      content.worker.ts    // consumer (processo separado)
    storage/
      s3.client.ts
      s3.service.ts        // upload(buffer, key) -> url
    ai/
      ai-simulator.ts       // função fake, 5s, 20% falha
  interfaces/
    http/
      server.ts
      plugins/
        error-handler.ts
        swagger.ts
      routes/
        content.routes.ts
  config/
    env.ts                 // parse de process.env com Zod
main.ts                    // bootstrap API
worker.ts                  // bootstrap worker (entrypoint separado)
```

Rotas não têm lógica de negócio — só validam (Zod), chamam
`ContentService` e traduzem o resultado/erro em resposta HTTP.

## 4. Endpoints

### `POST /api/content/generate`
- Body: `{ topic: string (min 3), userId: string (uuid) }`
- Fluxo (dentro de uma **transação Prisma**):
  1. `UPDATE users SET credits = credits - 1 WHERE id = :userId AND credits > 0 RETURNING credits` (via `$queryRaw` ou `updateMany` + checar `count`).
  2. Se nenhuma linha afetada → rollback implícito, lança `InsufficientCreditsError` (402/400).
  3. Cria `Content` com status `PENDING`.
- **Após o commit da transação** (não antes — para não enfileirar um job de uma transação que pode falhar), enfileira job no BullMQ com `{ contentId }`.
- Se o enqueue falhar (Redis fora do ar), a rota responde 503 e o conteúdo fica `PENDING` órfão — mitigação: um reconciliador simples (ou reaproveitar `attempts`/eventos do BullMQ) fica anotado como *nice-to-have*, não obrigatório para o escopo.
- Resposta `201`: `{ contentId, status: "PENDING" }`.

### `GET /api/content/:id`
- Retorna `{ id, topic, userId, status, fileUrl, createdAt, updatedAt }`.
- 404 se não existir.

### `POST /api/content/:id/cancel`
- Update condicional: `UPDATE content SET status='CANCELED' WHERE id=:id AND status IN ('PENDING','PROCESSING') RETURNING *`.
- Se 0 linhas afetadas → já estava `COMPLETED`/`CANCELED`/`FAILED`: responde 409 (conflito de estado), não é erro genérico.
- Não estorna crédito (a geração já foi consumida ao criar o job; regra não pedida no desafio, mas vale citar no README como decisão consciente).

## 5. Pontos críticos de concorrência (o que vai pesar na avaliação)

### 5.1 Créditos (evitar race condition read-then-write)
Nunca fazer `SELECT credits` seguido de `UPDATE credits - 1` em passos separados
(dois requests simultâneos leriam o mesmo valor). Em vez disso, um único
`UPDATE ... WHERE credits > 0` é atômico no Postgres — a linha é bloqueada
durante o próprio comando, então duas requisições concorrentes serializam
naturalmente e apenas uma consegue decrementar quando o saldo é 1.

### 5.2 Worker vs Cancel (o Worker não pode "ressuscitar" um job cancelado)
Modelo de estado como **compare-and-swap** via `UPDATE ... WHERE status = X`,
nunca um `UPDATE` incondicional:

```
Worker ao iniciar:
  UPDATE content SET status='PROCESSING'
  WHERE id=:id AND status='PENDING'
  RETURNING *
  -> se 0 linhas: job foi cancelado antes de começar. Aborta (retorna sem erro,
     não deixa o BullMQ reprocessar).

Worker após a IA (5s) responder com sucesso e o upload no S3 concluído:
  UPDATE content SET status='COMPLETED', fileUrl=:url
  WHERE id=:id AND status='PROCESSING'
  RETURNING *
  -> se 0 linhas: o /cancel rodou durante os 5s de espera. Descarta o
     resultado (loga que o upload foi feito "à toa"), NÃO sobrescreve
     CANCELED com COMPLETED.
```

Isso garante que não existe janela em que o Worker sobrescreve um cancelamento
concorrente: cada escrita de transição de estado é condicionada ao estado
esperado, e o Postgres garante atomicidade linha-a-nível por padrão — sem
precisar de lock explícito (`SELECT FOR UPDATE`) ou de coluna de versão.

### 5.3 Retry da IA (20% de falha simulada)
- BullMQ job options: `attempts: 3`, `backoff: { type: 'exponential', delay: 2000 }`.
- Antes de cada tentativa (inclusive retries), o processor deve checar o status atual: se já é `CANCELED`, sai sem tentar de novo (senão o BullMQ ficaria retry-ando um job morto).
- Se as 3 tentativas falharem, o processor grava `status='FAILED'` (condicional em `status='PROCESSING'`) com `errorMessage`.

## 6. IA simulada

```ts
async function simulateAIGeneration(topic: string): Promise<string> {
  await sleep(5000);
  if (Math.random() < 0.2) throw new Error('AI generation failed');
  return `Conteúdo gerado sobre: ${topic}...`;
}
```

## 7. Upload S3/Minio
- Bucket criado no bootstrap do docker-compose (serviço `createbuckets` rodando `mc mb`).
- `S3Service.upload(contentId, text)` → grava `contents/{contentId}.txt`, retorna URL pública/presigned conforme configuração do Minio.

## 8. Erros e resposta HTTP
- `AppError` base com `statusCode` e `message` públicos.
- `error-handler.ts` (Fastify `setErrorHandler`): se for `AppError`, responde com seu `statusCode`/mensagem; qualquer outro erro → loga stack completo via Pino e responde `500 { message: "Internal server error" }` genérico, sem vazar stack/trace ao cliente.

## 9. Docker Compose (serviços)
`postgres`, `redis`, `minio` + `minio-init` (cria bucket), `api` (Fastify), `worker` (mesmo build, `CMD` diferente: `node dist/worker.js`). Um único `docker-compose up --build` sobe tudo, com `depends_on` + healthchecks para Postgres/Redis/Minio antes de subir `api`/`worker`.

## 10. Testes (diferencial)
Unitários com Vitest, mockando os repositórios (interfaces do domínio):
- `ContentService`: decremento de crédito sem saldo → erro; transição cancel em estado inválido → 409; guard do worker não sobrescreve `CANCELED`.
- Sem infra real — testam só a lógica de service com repositórios fake in-memory.

## 11. README (itens obrigatórios)
1. Como rodar (`docker-compose up --build`, comandos de migration/seed).
2. Onde acessar o Swagger (`http://localhost:3000/docs`).
3. Parágrafo dedicado às decisões de concorrência/resiliência (seções 5.1–5.3 acima resumidas).

## 12. Checklist de conformidade com o desafio

- [x] Node + TS estrito, Fastify, Prisma/Postgres, BullMQ/Redis, Minio/S3, Zod
- [x] 3 endpoints com contrato definido
- [x] Worker: PROCESSING → IA (20% falha, retry) → upload S3 → COMPLETED
- [x] Créditos: update atômico condicional, sem race condition
- [x] Cancel vs Worker: CAS em cada transição de estado, sem "ressuscitar" cancelado
- [x] docker-compose sobe tudo com 1 comando
- [x] Swagger em `/docs` gerado a partir dos schemas Zod (sem duplicação)
- [x] Separação em camadas (domain/application/infrastructure/interfaces)
- [x] Testes unitários das regras críticas
- [x] Error handler global sem vazar stack trace

## 13. Ordem de implementação sugerida
1. Setup do projeto (TS, Fastify, Prisma schema + migration, env config com Zod).
2. Domain + Application (`ContentService`, erros, schemas Zod) — sem infra ainda.
3. Repositórios Prisma implementando as interfaces.
4. Rotas HTTP + Swagger + error handler global.
5. Fila (producer) integrada ao `generate` endpoint.
6. Worker + IA simulada + guards de estado (CAS).
7. S3Service (Minio) + integração no worker.
8. Docker-compose completo (postgres/redis/minio/api/worker) + seed de usuários.
9. Testes unitários das regras de negócio.
10. README final.

---

**Pronto para implementação.** Nenhum requisito do desafio ficou sem cobertura
na arquitetura acima; as únicas suposições assumidas (seed de usuários sem
endpoint de cadastro, não estorno de crédito em cancelamento) estão marcadas
explicitamente e valem uma linha no README.
