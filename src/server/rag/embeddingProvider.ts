import type { ProviderSettings } from "../../shared/types";

export interface EmbeddingResult {
  embeddings: number[][];
  model: string;
  usage?: unknown;
}

const retryableErrorPattern = /(fetch failed|other side closed|terminated|timeout|econnreset|etimedout|socket)/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function endpointUrl(settings: ProviderSettings, defaultPath: string): string {
  const path = settings.endpointPath || defaultPath;
  return `${settings.baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export async function embedTexts(settings: ProviderSettings, input: string[]): Promise<EmbeddingResult> {
  if (settings.provider === "disabled") {
    throw new Error("Embedding provider is disabled");
  }
  if (!settings.baseUrl || !settings.model) {
    throw new Error("Embedding provider base URL and model are required");
  }

  let response: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(endpointUrl(settings, "/embeddings"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${settings.apiKey ?? ""}`
        },
        body: JSON.stringify({ model: settings.model, input }),
        signal: AbortSignal.timeout(settings.timeoutMs)
      });
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!retryableErrorPattern.test(message) || attempt === 2) {
        throw error;
      }
      await sleep(500 * (attempt + 1));
    }
  }

  if (!response) {
    throw lastError instanceof Error ? lastError : new Error("Embedding provider failed");
  }
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "Embedding provider failed");
  }

  const data = Array.isArray(payload?.data) ? payload.data : [];
  const embeddings = data
    .sort((a: { index?: number }, b: { index?: number }) => (a.index ?? 0) - (b.index ?? 0))
    .map((item: { embedding?: number[] }) => item.embedding)
    .filter((embedding: unknown): embedding is number[] => Array.isArray(embedding));

  if (embeddings.length !== input.length) {
    throw new Error(`Embedding provider returned ${embeddings.length} embeddings for ${input.length} inputs`);
  }

  return {
    embeddings,
    model: payload?.model ?? settings.model,
    usage: payload?.usage
  };
}
