import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { store } from "../store";
import { listDocuments, readDocument, renderPreview } from "../vault/vaultService";
import { chunkMarkdownByHeading, formatChunkForEmbedding } from "./chunker";
import { embedTexts, endpointUrl } from "./embeddingProvider";
import { getIndexJob, latestIndexJob, requestIndexJobCancel, requestIndexJobSkipCurrentFile, startIndexJob } from "./indexJobs";
import { getNamespaceChunks, getNamespaceStats, searchVectors, type VectorNamespace } from "./vectorStore";

interface Chunk {
  path: string;
  title: string;
  text: string;
  tags?: string[];
  aliases?: string[];
  score: number;
}

interface RetrievalResult {
  chunks: Chunk[];
  namespace: string;
  warning?: string;
}

const maxQaChunks = 4;
const maxQaChunkChars = 1600;
const maxQaContextChars = 6000;
const retryableProviderErrorPattern = /(fetch failed|other side closed|terminated|timeout|econnreset|etimedout|socket)/i;

interface QaAttemptOptions {
  maxChunks: number;
  maxChunkChars: number;
  maxContextChars: number;
  maxOutputTokens: number;
}

function tokenize(input: string): string[] {
  const normalized = input.toLowerCase();
  const asciiTokens = normalized.match(/[a-z0-9_-]{2,}/g) ?? [];
  const cjkSequences = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? [];
  const cjkTokens = cjkSequences.flatMap((sequence) => {
    if (sequence.length <= 2) {
      return [sequence];
    }
    const grams = [sequence];
    for (let index = 0; index < sequence.length - 1; index += 1) {
      grams.push(sequence.slice(index, index + 2));
    }
    return grams;
  });
  return Array.from(new Set([...asciiTokens, ...cjkTokens]));
}

function keywordScore(question: string, chunk: Pick<Chunk, "path" | "title" | "text">): number {
  const haystack = `${chunk.path}\n${chunk.title}\n${chunk.text}`.toLowerCase();
  const normalizedQuestion = question.toLowerCase().trim();
  const tokens = tokenize(question);
  let score = 0;

  if (normalizedQuestion && haystack.includes(normalizedQuestion)) {
    score += 20;
  }

  for (const token of tokens) {
    let offset = haystack.indexOf(token);
    while (offset !== -1) {
      score += token.length >= 3 ? 3 : 1;
      offset = haystack.indexOf(token, offset + token.length);
    }
  }

  return score;
}

function metadataBoost(question: string, input: { path: string; title: string; tags?: string[]; aliases?: string[] }): number {
  const normalized = question.toLowerCase();
  const tagTerms = Array.from(normalized.matchAll(/#([\p{Letter}\p{Number}/_-]+)/gu)).map((match) => match[1]);
  let score = 0;

  if (normalized.includes(input.title.toLowerCase())) {
    score += 40;
  }
  if (normalized.includes(input.path.toLowerCase())) {
    score += 25;
  }

  for (const alias of input.aliases ?? []) {
    if (alias && normalized.includes(alias.toLowerCase())) {
      score += 35;
    }
  }

  for (const tag of input.tags ?? []) {
    const normalizedTag = tag.replace(/^#/, "").toLowerCase();
    if (tagTerms.includes(normalizedTag) || normalized.includes(normalizedTag)) {
      score += 30;
    }
  }

  return score;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && "cause" in error && error.cause instanceof Error ? error.cause.message : "";
  return cause && !message.includes(cause) ? `${message} (${cause})` : message;
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

function shouldDisableReasoning(settings: { reasoningMode?: "disabled" | "provider-default" }): boolean {
  return settings.reasoningMode !== "provider-default";
}

function isUnsupportedThinkingError(payload: any): boolean {
  const message = payload?.error?.message ?? "";
  return typeof message === "string" && /unknown field ["']?thinking|thinking.*unsupported|invalid.*thinking/i.test(message);
}

async function retrieveFallback(question: string, limit?: number): Promise<Chunk[]> {
  const data = await store.load();
  const docs = await listDocuments("updatedAt", "desc");
  const chunks: Chunk[] = [];
  const selected = typeof limit === "number" ? docs.slice(0, limit) : docs;

  for (const doc of selected) {
    const full = await readDocument(doc.path);
    const docBoost = metadataBoost(question, full);
    for (const chunk of chunkMarkdownByHeading(full.content, data.settings.rag.retrieval.chunkSize, data.settings.rag.retrieval.chunkOverlap)) {
      const text = formatChunkForEmbedding({
        title: full.title,
        path: full.path,
        tags: full.tags,
        aliases: full.aliases,
        frontmatter: full.frontmatter,
        heading: chunk.heading,
        text: chunk.text
      });
      const score = docBoost + keywordScore(question, { path: full.path, title: full.title, text });
      chunks.push({ path: full.path, title: chunk.heading ? `${full.title} > ${chunk.heading}` : full.title, text, score });
    }
  }

  return chunks
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .filter((chunk, index) => chunk.score > 0 || index < data.settings.rag.retrieval.topK)
    .slice(0, data.settings.rag.retrieval.topK);
}

async function retrieveIndexedKeyword(namespace: VectorNamespace, question: string, topK: number): Promise<Chunk[]> {
  const chunks = await getNamespaceChunks(namespace);
  return chunks
    .map((chunk) => ({
      path: chunk.path,
      title: chunk.title,
      text: chunk.text,
      tags: chunk.tags,
      aliases: chunk.aliases,
      score: keywordScore(question, chunk) + metadataBoost(question, chunk)
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .filter((chunk, index) => chunk.score > 0 || index < topK)
    .slice(0, topK);
}

async function retrieve(question: string): Promise<RetrievalResult> {
  const data = await store.load();
  const productionStats = await getNamespaceStats("production");
  const testStats = await getNamespaceStats("test");
  const namespace: VectorNamespace | null =
    productionStats.chunkCount > 0 ? "production" : testStats.chunkCount > 0 ? "test" : null;

  if (namespace) {
    if (data.settings.rag.embedding.provider !== "disabled") {
      try {
        const result = await embedTexts(data.settings.rag.embedding, [question]);
        const vectorMatches = await searchVectors(namespace, result.embeddings[0], data.settings.rag.retrieval.topK);
        const keywordMatches = await retrieveIndexedKeyword(namespace, question, data.settings.rag.retrieval.topK);
        const merged = new Map<string, Chunk>();

        for (const match of vectorMatches) {
          merged.set(match.id, {
            path: match.path,
            title: match.title,
            text: match.text,
            tags: match.tags,
            aliases: match.aliases,
            score: match.score + keywordScore(question, match) + metadataBoost(question, match)
          });
        }
        for (const match of keywordMatches) {
          const key = `${match.path}:${match.text}`;
          const existing = merged.get(key);
          merged.set(key, existing ? { ...existing, score: existing.score + match.score } : match);
        }

        return {
          namespace,
          chunks: Array.from(merged.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, data.settings.rag.retrieval.topK)
        };
      } catch (error) {
        const warning = error instanceof Error ? error.message : "Embedding query failed";
        const indexedKeyword = await retrieveIndexedKeyword(namespace, question, data.settings.rag.retrieval.topK);
        if ((indexedKeyword[0]?.score ?? 0) <= 0) {
          return {
            namespace: "vault-keyword",
            warning,
            chunks: await retrieveFallback(question)
          };
        }
        return {
          namespace: `${namespace}-keyword`,
          warning,
          chunks: indexedKeyword
        };
      }
    }

    const indexedKeyword = await retrieveIndexedKeyword(namespace, question, data.settings.rag.retrieval.topK);
    if ((indexedKeyword[0]?.score ?? 0) <= 0) {
      return {
        namespace: "vault-keyword",
        chunks: await retrieveFallback(question)
      };
    }

    return {
      namespace: `${namespace}-keyword`,
      chunks: indexedKeyword
    };
  }

  return {
    namespace: "keyword",
    chunks: await retrieveFallback(question)
  };
}

function buildQaPrompt(question: string, chunks: Chunk[], options: QaAttemptOptions): { userPrompt: string; systemPrompt: string } {
  let usedChars = 0;
  const context = chunks
    .slice(0, options.maxChunks)
    .map((chunk, index) => {
      const remaining = Math.max(0, options.maxContextChars - usedChars);
      const text = chunk.text.slice(0, Math.min(options.maxChunkChars, remaining));
      usedChars += text.length;
      return `<retrieved_document id="${index + 1}">\nTITLE: ${chunk.title}\nPATH: ${chunk.path}\n\n${text}\n</retrieved_document>`;
    })
    .filter((entry) => entry.trim().length > 0)
    .join("\n\n");
  const sourceCatalog = chunks
    .slice(0, options.maxChunks)
    .map((chunk, index) => `[${index + 1}] ${chunk.title} - ${chunk.path}`)
    .join("\n");

  return {
    userPrompt: `Question: ${question}\n\nSource catalog:\n${sourceCatalog}\n\nContext:\n${context}`,
    systemPrompt:
      "Answer only from the supplied Markdown context. If the context is insufficient, say so. Cite sources with bracket numbers like [1] and mention document paths when useful."
  };
}

async function answerWithProviderAttempt(question: string, chunks: Chunk[], options: QaAttemptOptions): Promise<string | null> {
  const data = await store.load();
  const settings = data.settings.rag.qa;
  const { userPrompt, systemPrompt } = buildQaPrompt(question, chunks, options);
  const apiMode = settings.apiMode ?? "chat-completions";
  const isResponsesMode = apiMode === "responses" || settings.endpointPath === "/responses";
  const disableReasoning = isResponsesMode && shouldDisableReasoning(settings);
  const buildBody = (includeThinking: boolean) =>
    JSON.stringify(
      isResponsesMode
        ? {
            model: settings.model,
            instructions: systemPrompt,
            input: userPrompt,
            ...(includeThinking ? { thinking: { type: "disabled" } } : {}),
            temperature: 0.2,
            max_output_tokens: options.maxOutputTokens
          }
        : {
            model: settings.model,
            temperature: 0.2,
            max_tokens: options.maxOutputTokens,
            messages: [
              {
                role: "system",
                content: systemPrompt
              },
              {
                role: "user",
                content: userPrompt
              }
            ]
          }
    );

  const callProvider = async (includeThinking: boolean) => {
    const response = await fetch(endpointUrl(settings, isResponsesMode ? "/responses" : "/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.apiKey ?? ""}`
      },
      body: buildBody(includeThinking),
      signal: AbortSignal.timeout(settings.timeoutMs)
    });
    return {
      response,
      payload: await response.json().catch(() => null)
    };
  };

  let { response, payload } = await callProvider(disableReasoning);
  if (!response.ok && disableReasoning && isUnsupportedThinkingError(payload)) {
    ({ response, payload } = await callProvider(false));
  }

  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Q&A provider failed with HTTP ${response.status}`);
  }
  if (isResponsesMode) {
    const text = extractResponsesText(payload);
    if (!text) {
      throw new Error(`Q&A provider returned no final text${payload?.status ? ` (status: ${payload.status})` : ""}`);
    }
    return text;
  }
  const text = payload?.choices?.[0]?.message?.content ?? "";
  if (!text) {
    throw new Error("Q&A provider returned no final text");
  }
  return text;
}

async function answerWithProvider(question: string, chunks: Chunk[]): Promise<string | null> {
  const data = await store.load();
  const settings = data.settings.rag.qa;
  if (settings.provider === "disabled") {
    return null;
  }

  const attempts: QaAttemptOptions[] = [
    { maxChunks: maxQaChunks, maxChunkChars: maxQaChunkChars, maxContextChars: maxQaContextChars, maxOutputTokens: 1200 },
    { maxChunks: 2, maxChunkChars: 900, maxContextChars: 1800, maxOutputTokens: 800 },
    { maxChunks: 1, maxChunkChars: 700, maxContextChars: 700, maxOutputTokens: 500 }
  ];
  let lastError: unknown;

  for (const [index, attempt] of attempts.entries()) {
    try {
      return await answerWithProviderAttempt(question, chunks, attempt);
    } catch (error) {
      lastError = error;
      const message = describeError(error);
      const shouldRetry = index < attempts.length - 1 && retryableProviderErrorPattern.test(message);
      if (!shouldRetry) {
        throw new Error(message);
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * (index + 1)));
    }
  }

  throw new Error(describeError(lastError));
}

export async function registerRagRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/settings/rag/test-index", async (request, reply) => {
    const body = z.object({ sampleSize: z.number().int().min(1).max(100).default(20) }).parse(request.body ?? {});
    try {
      return await startIndexJob({ mode: "test", sampleSize: body.sampleSize });
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to start test index" };
    }
  });

  app.post("/api/rag/reindex", async (_request, reply) => {
    try {
      return await startIndexJob({ mode: "full" });
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to start full index" };
    }
  });

  app.post("/api/rag/reindex/incremental", async (_request, reply) => {
    try {
      return await startIndexJob({ mode: "incremental" });
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to start incremental index" };
    }
  });

  app.get("/api/rag/index-jobs/latest", async () => latestIndexJob() ?? null);

  app.get("/api/rag/index-jobs/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const job = getIndexJob(params.id);
    if (!job) {
      reply.code(404);
      return { error: "Index job not found" };
    }
    return job;
  });

  app.post("/api/rag/index-jobs/:id/cancel", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const job = requestIndexJobCancel(params.id);
    if (!job) {
      reply.code(404);
      return { error: "Index job not found" };
    }
    return job;
  });

  app.post("/api/rag/index-jobs/:id/skip-current-file", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const job = requestIndexJobSkipCurrentFile(params.id);
    if (!job) {
      reply.code(404);
      return { error: "Index job not found" };
    }
    return job;
  });

  app.get("/api/rag/index-stats", async () => ({
    production: await getNamespaceStats("production"),
    test: await getNamespaceStats("test")
  }));

  app.post("/api/rag/query", async (request, reply) => {
    const body = z.object({ question: z.string().min(1) }).parse(request.body);
    let retrieval: RetrievalResult;
    try {
      retrieval = await retrieve(body.question);
    } catch (error) {
      app.log.warn(error, "Vector retrieval failed; falling back to keyword retrieval");
      retrieval = {
        namespace: "keyword",
        chunks: await retrieveFallback(body.question)
      };
    }

    const citations = retrieval.chunks.map((chunk) => ({
      path: chunk.path,
      title: chunk.title,
      score: chunk.score,
      snippet: chunk.text.slice(0, 320)
    }));

    try {
      const providerAnswer = await answerWithProvider(body.question, retrieval.chunks);
      const answer =
        providerAnswer ??
        `Q&A provider is disabled. Showing the most relevant ${retrieval.namespace} Markdown snippets for: "${body.question}".`;
      return {
        answer,
        answerHtml: await renderPreview(answer),
        indexNamespace: retrieval.namespace,
        retrievalWarning: retrieval.warning,
        citations
      };
    } catch (error) {
      const providerError = error instanceof Error ? error.message : "Q&A provider failed";
      app.log.warn({ err: error }, "Q&A provider failed; returning retrieved citations");
      const answer = `The Q&A provider failed (${providerError}). I found these relevant ${retrieval.namespace} snippets, but could not generate a final answer.`;
      return {
        answer,
        answerHtml: await renderPreview(answer),
        indexNamespace: retrieval.namespace,
        retrievalWarning: retrieval.warning,
        providerError,
        citations
      };
    }
  });
}
