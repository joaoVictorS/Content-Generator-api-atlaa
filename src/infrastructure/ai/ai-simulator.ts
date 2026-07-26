const AI_PROCESSING_TIME_MS = 5000;
const AI_FAILURE_RATE = 0.2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fakes an expensive LLM call: takes 5s and fails ~20% of the time to
 * exercise the worker's retry/resilience path.
 */
export async function simulateAIGeneration(topic: string): Promise<string> {
  await sleep(AI_PROCESSING_TIME_MS);

  if (Math.random() < AI_FAILURE_RATE) {
    throw new Error(`AI generation failed for topic "${topic}"`);
  }

  return [
    `Conteudo gerado sobre: ${topic}`,
    '',
    `Este e um texto ficticio produzido pelo simulador de IA para demonstrar `
      + 'o pipeline assincrono de geracao de conteudo, incluindo enfileiramento, '
      + 'processamento em background e upload do resultado para o storage S3.',
    '',
    `Gerado em: ${new Date().toISOString()}`,
  ].join('\n');
}
