import type { ProviderSettings } from "../../shared/types";

export interface EmbeddingResult {
  embeddings: number[][];
  model: string;
  usage?: unknown;
}

const retryableErrorPattern = /(fetch failed|other side closed|terminated|timeout|econnreset|etimedout|socket|html instead of json|bad gateway|service unavailable|gateway timeout|too many requests|rate limit)/i;
type EmbeddingInputType = "query" | "passage";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function endpointUrl(settings: ProviderSettings, defaultPath: string): string {
  const path = settings.endpointPath || defaultPath;
  return `${settings.baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function supportsInputType(settings: ProviderSettings): boolean {
  return /nvidia/i.test(settings.baseUrl) || /^nvidia\//i.test(settings.model);
}

export async function embedTexts(settings: ProviderSettings, input: string[], options: { inputType?: EmbeddingInputType } = {}): Promise<EmbeddingResult> {
  if (settings.provider === "disabled") {
    throw new Error("Embedding provider is disabled");
  }
  if (!settings.baseUrl || !settings.model) {
    throw new Error("Embedding provider base URL and model are required");
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const body = {
        model: settings.model,
        input,
        ...(options.inputType && supportsInputType(settings) ? { input_type: options.inputType } : {})
      };
      const response = await fetch(endpointUrl(settings, "/embeddings"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${settings.apiKey ?? ""}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(settings.timeoutMs)
      });
      const rawPayload = await response.text();
      let payload: any;
      try {
        payload = rawPayload ? JSON.parse(rawPayload) : {};
      } catch {
        const preview = rawPayload.replace(/\s+/g, " ").slice(0, 180);
        throw new Error(`Embedding provider returned HTML instead of JSON (${response.status} ${response.statusText}): ${preview}`);
      }

      if (!response.ok) {
        const message = payload?.error?.message ?? payload?.message ?? `Embedding provider failed (${response.status} ${response.statusText})`;
        throw new Error(message);
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
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!retryableErrorPattern.test(message) || attempt === 2) {
        throw error;
      }
      await sleep(500 * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Embedding provider failed");
}
