import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProviderSettings } from "../../shared/types";
import { config } from "../config";
import { redactSecret } from "../crypto";
import { updateCredentials } from "../auth/authService";
import { store } from "../store";
import { validateVaultPath } from "../vault/vaultService";
import { endpointUrl } from "../rag/embeddingProvider";

const providerSchema = z.object({
  provider: z.enum(["openai-compatible", "disabled"]),
  apiMode: z.enum(["embeddings", "chat-completions", "responses", "custom"]).optional(),
  endpointPath: z.string().optional(),
  reasoningMode: z.enum(["disabled", "provider-default"]).optional(),
  reasoningDetected: z.boolean().optional(),
  baseUrl: z.string().optional().default(""),
  model: z.string().optional().default(""),
  apiKey: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000)
});

const ragSchema = z.object({
  embedding: providerSchema,
  qa: providerSchema,
  retrieval: z.object({
    topK: z.number().int().min(1).max(30),
    chunkSize: z.number().int().min(300).max(6000),
    chunkOverlap: z.number().int().min(0).max(1000)
  }),
  indexing: z
    .object({
      embeddingBatchSize: z.number().int().min(1).max(128),
      embeddingRequestsPerMinute: z.number().int().min(0).max(6000)
    })
    .default({ embeddingBatchSize: 16, embeddingRequestsPerMinute: 0 })
});

const httpsSchema = z.object({
  enabled: z.boolean(),
  certificate: z.string().optional(),
  privateKey: z.string().optional()
});

function redactedSettings(data: Awaited<ReturnType<typeof store.load>>) {
  return {
    ...data.settings,
    https: {
      enabled: data.settings.https?.enabled ?? false,
      hasCertificate: Boolean(data.settings.https?.certificate?.trim()),
      hasPrivateKey: Boolean(data.settings.https?.privateKey?.trim())
    },
    rag: {
      ...data.settings.rag,
      embedding: {
        ...data.settings.rag.embedding,
        apiKey: redactSecret(data.settings.rag.embedding.apiKey)
      },
      qa: {
        ...data.settings.rag.qa,
        apiKey: redactSecret(data.settings.rag.qa.apiKey)
      }
    },
    runtime: {
      allowedVaultRoots: config.allowedVaultRoots,
      dataDir: config.dataDir
    }
  };
}

function resolveSubmittedSecret(submitted: string | undefined, existing: string | undefined): string | undefined {
  if (!submitted || submitted.includes("...") || submitted === "********") {
    return existing;
  }
  return submitted;
}

function resolveSubmittedPem(submitted: string | undefined, existing: string | undefined): string {
  if (submitted === undefined || submitted.trim().length === 0) {
    return existing ?? "";
  }
  return submitted.replace(/\r\n/g, "\n").trim();
}

function validateHttpsPem(enabled: boolean, certificate: string, privateKey: string): void {
  if (!enabled) {
    return;
  }
  if (!certificate.includes("BEGIN CERTIFICATE") || !certificate.includes("END CERTIFICATE")) {
    throw new Error("HTTPS certificate must be a PEM certificate");
  }
  if (!/BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY/.test(privateKey) || !/END (RSA |EC |ENCRYPTED )?PRIVATE KEY/.test(privateKey)) {
    throw new Error("HTTPS private key must be a PEM private key");
  }
}

async function testOpenAiCompatibleEmbedding(settings: { baseUrl: string; model: string; apiKey?: string; timeoutMs: number; endpointPath?: string }) {
  const started = Date.now();
  const response = await fetch(endpointUrl({ ...settings, provider: "openai-compatible" }, "/embeddings"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey ?? ""}`
    },
    body: JSON.stringify({ model: settings.model, input: "Obsidian Web Docs provider test" }),
    signal: AbortSignal.timeout(settings.timeoutMs)
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "Embedding provider test failed");
  }
  return {
    ok: true,
    latencyMs: Date.now() - started,
    dimensions: payload?.data?.[0]?.embedding?.length ?? 0,
    model: payload?.model ?? settings.model
  };
}

function extractResponsesText(payload: any): string {
  const fromOutput = Array.isArray(payload?.output)
    ? payload.output
        .flatMap((item: { content?: Array<{ text?: string }>; text?: string }) => item.content ?? (item.text ? [{ text: item.text }] : []))
        .map((content: { text?: string }) => content.text)
        .filter((text: unknown): text is string => typeof text === "string" && text.trim().length > 0)
        .join("\n")
    : "";

  return typeof payload?.output_text === "string" && payload.output_text.trim().length > 0 ? payload.output_text : fromOutput;
}

function getReasoningTokens(payload: any): number {
  const reasoningTokens = payload?.usage?.output_tokens_details?.reasoning_tokens;
  return typeof reasoningTokens === "number" ? reasoningTokens : 0;
}

function shouldDisableReasoning(settings: { model: string; reasoningMode?: ProviderSettings["reasoningMode"]; reasoningDetected?: boolean }): boolean {
  return settings.reasoningMode !== "provider-default";
}

function isUnsupportedThinkingError(payload: any): boolean {
  const message = payload?.error?.message ?? "";
  return typeof message === "string" && /unknown field ["']?thinking|thinking.*unsupported|invalid.*thinking/i.test(message);
}

async function testOpenAiCompatibleQa(settings: {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  apiMode?: ProviderSettings["apiMode"];
  endpointPath?: string;
  reasoningMode?: ProviderSettings["reasoningMode"];
  reasoningDetected?: boolean;
}) {
  const started = Date.now();
  const isResponsesMode = settings.apiMode === "responses" || settings.endpointPath === "/responses";
  let disableReasoning = isResponsesMode && shouldDisableReasoning(settings);
  const buildBody = () =>
    JSON.stringify(
      isResponsesMode
        ? {
            model: settings.model,
            input: "Reply with: provider ok",
            ...(disableReasoning ? { thinking: { type: "disabled" } } : {}),
            temperature: 0,
            max_output_tokens: 80
          }
        : {
            model: settings.model,
            messages: [{ role: "user", content: "Reply with: provider ok" }],
            temperature: 0,
            max_tokens: 20
          }
    );
  const callProvider = async () => {
    const response = await fetch(endpointUrl({ ...settings, provider: "openai-compatible" }, isResponsesMode ? "/responses" : "/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.apiKey ?? ""}`
      },
      body: buildBody(),
      signal: AbortSignal.timeout(settings.timeoutMs)
    });
    return { response, payload: await response.json().catch(() => null) };
  };

  let { response, payload } = await callProvider();
  if (!response.ok && disableReasoning && isUnsupportedThinkingError(payload)) {
    disableReasoning = false;
    ({ response, payload } = await callProvider());
  }
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "Q&A provider test failed");
  }
  const answer = isResponsesMode ? extractResponsesText(payload) : payload?.choices?.[0]?.message?.content ?? "";
  if (!answer) {
    throw new Error(`Q&A provider returned no final text${payload?.status ? ` (status: ${payload.status})` : ""}`);
  }
  return {
    ok: true,
    latencyMs: Date.now() - started,
    answer,
    model: payload?.model ?? settings.model,
    reasoningMode: settings.reasoningMode ?? "disabled",
    reasoningDisabledForTest: disableReasoning,
    reasoningTokens: getReasoningTokens(payload)
  };
}

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", async () => redactedSettings(await store.load()));

  app.put("/api/settings/auth", async (request) => {
    const body = z.object({ username: z.string().min(1), password: z.string().min(8) }).parse(request.body);
    await updateCredentials(body.username, body.password);
    return { ok: true };
  });

  app.post("/api/settings/vault/validate", async (request) => {
    const body = z.object({ path: z.string().min(1) }).parse(request.body);
    return validateVaultPath(path.resolve(body.path));
  });

  app.put("/api/settings/vault", async (request, reply) => {
    const body = z.object({ path: z.string().min(1), allowPlainMarkdownFolder: z.boolean().default(true) }).parse(request.body);
    const validation = await validateVaultPath(path.resolve(body.path));
    if (!validation.ok) {
      reply.code(400);
      return validation;
    }
    const data = await store.load();
    data.settings.vault = { path: path.resolve(body.path), allowPlainMarkdownFolder: body.allowPlainMarkdownFolder, validation };
    await store.save();
    return redactedSettings(data);
  });

  app.put("/api/settings/https", async (request, reply) => {
    const body = httpsSchema.parse(request.body);
    const data = await store.load();
    const certificate = resolveSubmittedPem(body.certificate, data.settings.https?.certificate);
    const privateKey = resolveSubmittedPem(body.privateKey, data.settings.https?.privateKey);
    try {
      validateHttpsPem(body.enabled, certificate, privateKey);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Invalid HTTPS certificate settings" };
    }
    data.settings.https = {
      enabled: body.enabled,
      certificate,
      privateKey,
      hasCertificate: Boolean(certificate.trim()),
      hasPrivateKey: Boolean(privateKey.trim())
    };
    await store.save();
    return redactedSettings(data);
  });

  app.put("/api/settings/rag", async (request) => {
    const body = ragSchema.parse(request.body);
    const data = await store.load();
    data.settings.rag = {
      embedding: { ...body.embedding, apiKey: resolveSubmittedSecret(body.embedding.apiKey, data.settings.rag.embedding.apiKey) },
      qa: { ...body.qa, apiKey: resolveSubmittedSecret(body.qa.apiKey, data.settings.rag.qa.apiKey) },
      retrieval: body.retrieval,
      indexing: body.indexing
    };
    await store.save();
    return redactedSettings(data);
  });

  app.post("/api/settings/rag/test-embedding", async (_request, reply) => {
    const data = await store.load();
    if (data.settings.rag.embedding.provider === "disabled") {
      reply.code(400);
      return { error: "Embedding provider is disabled" };
    }
    try {
      return await testOpenAiCompatibleEmbedding(data.settings.rag.embedding);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Embedding provider test failed" };
    }
  });

  app.post("/api/settings/rag/test-qa", async (_request, reply) => {
    const data = await store.load();
    if (data.settings.rag.qa.provider === "disabled") {
      reply.code(400);
      return { error: "Q&A provider is disabled" };
    }
    try {
      return await testOpenAiCompatibleQa(data.settings.rag.qa);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Q&A provider test failed" };
    }
  });

  app.get("/api/settings/rag/export", async () => {
    const data = await store.load();
    return {
      schemaVersion: 1,
      rag: {
        ...data.settings.rag,
        embedding: { ...data.settings.rag.embedding, apiKey: undefined },
        qa: { ...data.settings.rag.qa, apiKey: undefined }
      }
    };
  });

  app.post("/api/settings/rag/import", async (request) => {
    const body = z.object({ schemaVersion: z.literal(1), rag: ragSchema }).parse(request.body);
    const data = await store.load();
    data.settings.rag = {
      embedding: { ...body.rag.embedding, apiKey: resolveSubmittedSecret(body.rag.embedding.apiKey, data.settings.rag.embedding.apiKey) },
      qa: { ...body.rag.qa, apiKey: resolveSubmittedSecret(body.rag.qa.apiKey, data.settings.rag.qa.apiKey) },
      retrieval: body.rag.retrieval,
      indexing: body.rag.indexing
    };
    await store.save();
    return redactedSettings(data);
  });
}
