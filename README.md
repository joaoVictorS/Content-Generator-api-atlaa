# AI Content Generator API

API para geração assíncrona de conteúdo via IA (simulada), construída como
desafio técnico backend sênior. Fastify + TypeScript estrito, PostgreSQL via
Prisma, fila BullMQ/Redis para processamento em background e upload do
resultado em S3 (Minio localmente).

## Stack

- Node.js 20 + TypeScript (`strict`)
- Fastify + Zod (`fastify-type-provider-zod`) + Swagger/OpenAPI
- PostgreSQL + Prisma ORM
- Redis + BullMQ (fila e worker)
- Minio (S3-compatible) via AWS SDK v3
- Vitest para testes unitários

## Como rodar

Pré-requisito: Docker e Docker Compose.

```bash
docker-compose up --build
```

Isso sobe Postgres, Redis, Minio (+ criação automática do bucket) e os dois
processos da aplicação: `api` (Fastify, porta `3000`) e `worker` (consumer
BullMQ). A migration do Prisma é aplicada automaticamente pelo comando de
start do serviço `api` (`prisma migrate deploy`).

### Popular usuários de teste

Não há endpoint de cadastro de usuário no escopo do desafio (fora do
requisitado). Para poder chamar `POST /api/content/generate` é preciso um
`userId` existente, então rode o seed depois do `docker-compose up`:

```bash
docker-compose exec api node dist/infrastructure/prisma/seed.js
```

Isso cria 3 usuários (`Alice` com 5 créditos, `Bob` com 1 crédito, `Sem
Creditos` com 0 créditos) e imprime os UUIDs gerados no console — use um
desses IDs no `userId` das chamadas de teste.

### Documentação (Swagger)

Com a API no ar: **http://localhost:3000/docs**

### Exemplo de uso

```bash
curl -X POST http://localhost:3000/api/content/generate \
  -H "Content-Type: application/json" \
  -d '{"topic":"Inteligencia Artificial","userId":"<uuid do usuario>"}'

curl http://localhost:3000/api/content/<contentId>

curl -X POST http://localhost:3000/api/content/<contentId>/cancel
```

## Rodando localmente sem Docker (dev)

```bash
npm install
cp .env.example .env   # ajuste as portas/credenciais se necessário
npx prisma migrate dev
npm run prisma:seed
npm run dev             # API em watch mode
npm run dev:worker       # em outro terminal
```

## Testes

```bash
npm test
```

Testes unitários cobrem a lógica de negócio isolada de infraestrutura
(repositórios/fila/S3 são fakes/mocks): créditos insuficientes, transições
de estado do `cancel`, e principalmente os guards de concorrência do worker
(seção abaixo).

## Decisões arquiteturais: concorrência e resiliência

O projeto segue uma separação por camadas (`domain` → `application` →
`infrastructure`/`interfaces`): as rotas Fastify não contêm regra de
negócio, apenas validam (Zod) e delegam para `ContentService`; a
persistência é abstraída por interfaces de repositório (`IContentRepository`,
`IUserRepository`) implementadas com Prisma.

Os dois pontos de concorrência pedidos no desafio foram resolvidos assim:

**Créditos.** O desconto de crédito nunca faz um `SELECT` seguido de um
`UPDATE` (o que permitiria duas requisições concorrentes lerem o mesmo saldo
e ambas decrementarem). Em vez disso, é um único `UPDATE users SET credits =
credits - 1 WHERE id = :userId AND credits > 0`, atômico no Postgres — duas
requisições simultâneas para o mesmo usuário serializam nessa linha, e
apenas uma consegue decrementar quando o saldo é exatamente 1. Essa
atualização e a criação do `Content` (`PENDING`) acontecem na mesma
transação Prisma; o job só é enfileirado no BullMQ **depois** do commit,
para nunca enfileirar trabalho de uma transação que pode ter revertido.

**Worker vs. `/cancel`.** Cada transição de status do `Content` é um
`UPDATE ... WHERE status = <estado_esperado> RETURNING *` (compare-and-swap
a nível de linha, também atômico no Postgres) — nunca um `UPDATE`
incondicional. Isso cobre exatamente o cenário do enunciado: se o usuário
chama `/cancel` enquanto o worker está nos 5s de espera da IA, o worker, ao
tentar finalizar, roda `UPDATE ... SET status='COMPLETED' WHERE status=
'PROCESSING'`; como o `/cancel` já mudou o status para `CANCELED`, essa
atualização afeta 0 linhas, o worker descarta o resultado gerado (loga e
segue) e o `CANCELED` permanece como estado final — o job nunca é
"ressuscitado". O mesmo guard existe na outra ponta: se o `/cancel` for
chamado antes mesmo do worker pegar o job, o `UPDATE ... WHERE
status='PENDING'` que tentaria marcar `PROCESSING` também falha e o worker
aborta sem chamar a IA. Esse comportamento está coberto por testes
unitários (`test/infrastructure/queue/content.worker.spec.ts`).

**Retry da IA simulada.** A função fake de IA falha ~20% das vezes; o job
BullMQ é configurado com `attempts: 3` e backoff exponencial. Numa
retentativa, o worker não tenta marcar `PENDING -> PROCESSING` de novo (o
conteúdo já está `PROCESSING` desde a primeira tentativa) — ele checa o
status atual primeiro e, se já não for mais `PENDING`/`PROCESSING`
(por exemplo, foi cancelado entre tentativas), aborta sem nova chamada à
IA. Se as 3 tentativas se esgotarem, o evento `failed` do BullMQ marca o
conteúdo como `FAILED` (também via CAS, não sobrescrevendo um cancelamento).

**Erros HTTP.** Um error handler global (`setErrorHandler`) traduz erros de
domínio conhecidos (`AppError`) e de validação (Zod) em respostas 4xx com
mensagem clara; qualquer erro não mapeado vira `500 { message: "Internal
server error" }` genérico, com o stack completo apenas no log do servidor
(Pino) — nunca exposto ao cliente.

## Estrutura de pastas

```
src/
  domain/            # entidades, interfaces de repositório, erros de domínio
  application/        # ContentService, schemas Zod (DTOs), portas (fila)
  infrastructure/      # Prisma, BullMQ (fila + worker), S3/Minio, IA simulada
  interfaces/http/     # rotas Fastify, Swagger, error handler
  main.ts              # bootstrap da API
  worker.ts            # bootstrap do worker
```
