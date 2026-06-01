import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { UserRecord } from "../store";
import { listDocuments, readDocument, renderPreview } from "../vault/vaultService";
import { RAG_CHUNKING_VERSION, chunkMarkdownByHeading, formatChunkForContext } from "./chunker";
import { embedTexts, endpointUrl } from "./embeddingProvider";
import { getIndexJob, latestIndexJob, requestIndexJobCancel, requestIndexJobSkipCurrentFile, startIndexJob } from "./indexJobs";
import { getNamespaceChunks, getNamespaceStats, searchVectors, type VectorIndexCompatibility, type VectorNamespace } from "./vectorStore";

function authedUser(request: FastifyRequest, reply: FastifyReply): UserRecord | null {
  const user = request.user;
  if (!user) {
    reply.code(401).send({ error: "Authentication required" });
    return null;
  }
  return user;
}

interface Chunk {
  id?: string;
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

const maxQaChunks = 6;
const maxQaChunkChars = 1800;
const maxQaContextChars = 9000;
const minCandidateK = 20;
const candidateMultiplier = 5;
const maxLiveKeywordDocs = 80;
const retryableProviderErrorPattern = /(fetch failed|other side closed|terminated|timeout|econnreset|etimedout|socket)/i;
const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with"
]);

interface QaAttemptOptions {
  maxChunks: number;
  maxChunkChars: number;
  maxContextChars: number;
  maxOutputTokens: number;
  timeoutMs: number;
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
  return Array.from(new Set([...asciiTokens, ...cjkTokens])).filter((token) => token.length > 1 && !stopWords.has(token));
}

function keywordScore(question: string, chunk: Pick<Chunk, "path" | "title" | "text">): number {
  const title = chunk.title.toLowerCase();
  const path = chunk.path.toLowerCase().replace(/[/._-]+/g, " ");
  const text = chunk.text.toLowerCase();
  const haystack = `${path}\n${title}\n${text}`;
  const normalizedQuestion = question.toLowerCase().trim();
  const tokens = tokenize(question);
  let score = 0;

  if (normalizedQuestion && haystack.includes(normalizedQuestion)) {
    score += 35;
  }
  if (normalizedQuestion && title.includes(normalizedQuestion)) {
    score += 45;
  }
  if (normalizedQuestion && path.includes(normalizedQuestion)) {
    score += 40;
  }

  let matchedTokens = 0;
  for (const token of tokens) {
    const titleMatches = countMatches(title, token);
    const pathMatches = countMatches(path, token);
    const textMatches = countMatches(text, token);
    if (titleMatches + pathMatches + textMatches > 0) {
      matchedTokens += 1;
    }
    score += titleMatches * 12;
    score += pathMatches * 10;
    score += textMatches * (token.length >= 3 ? 3 : 1);
  }

  if (tokens.length > 0) {
    const coverage = matchedTokens / tokens.length;
    score += coverage * 18;
    if (coverage === 1) {
      score += 20;
    }
  }

  return score;
}

function countMatches(input: string, token: string): number {
  let count = 0;
  let offset = input.indexOf(token);
  while (offset !== -1) {
    count += 1;
    offset = input.indexOf(token, offset + token.length);
  }
  return count;
}

function exactQuestionMatch(question: string, chunk: Pick<Chunk, "path" | "title" | "text">): boolean {
  const normalizedQuestion = question.toLowerCase().trim();
  if (!normalizedQuestion) {
    return false;
  }
  const haystack = `${chunk.path}\n${chunk.title}\n${chunk.text}`.toLowerCase();
  return haystack.includes(normalizedQuestion);
}

function chunkKey(chunk: Pick<Chunk, "path" | "text">): string {
  return "id" in chunk && typeof chunk.id === "string" ? chunk.id : `${chunk.path}:${chunk.text.slice(0, 120)}`;
}

function mergeChunks(target: Map<string, Chunk>, chunks: Chunk[], sourceWeight = 1): void {
  for (const chunk of chunks) {
    const key = chunkKey(chunk);
    const weighted = { ...chunk, score: chunk.score * sourceWeight };
    const existing = target.get(key);
    if (!existing) {
      target.set(key, weighted);
      continue;
    }
    target.set(key, {
      ...existing,
      score: Math.max(existing.score, weighted.score) + Math.min(existing.score, weighted.score) * 0.25
    });
  }
}

function selectDiverseTopK(chunks: Chunk[], question: string, topK: number): Chunk[] {
  const selected: Chunk[] = [];
  const perPath = new Map<string, number>();
  const sorted = chunks.sort((a, b) => {
    const exactDiff = Number(exactQuestionMatch(question, b)) - Number(exactQuestionMatch(question, a));
    return exactDiff || b.score - a.score || a.path.localeCompare(b.path);
  });

  for (const chunk of sorted) {
    const count = perPath.get(chunk.path) ?? 0;
    if (count >= 2 && selected.length < Math.max(3, topK - 1)) {
      continue;
    }
    selected.push(chunk);
    perPath.set(chunk.path, count + 1);
    if (selected.length >= topK) {
      break;
    }
  }

  return selected;
}

function scoreVectorMatch(question: string, match: Chunk): number {
  return match.score * 25 + keywordScore(question, match) + metadataBoost(question, match);
}

function scoreLexicalMatch(question: string, match: Pick<Chunk, "path" | "title" | "text" | "tags" | "aliases">): number {
  return keywordScore(question, match) + metadataBoost(question, match);
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

function vectorCompatibility(user: UserRecord): VectorIndexCompatibility {
  return {
    chunkingVersion: RAG_CHUNKING_VERSION,
    ...(user.rag.embedding.provider !== "disabled" && user.rag.embedding.model ? { embeddingModel: user.rag.embedding.model } : {})
  };
}

function shouldDisableReasoning(settings: { reasoningMode?: "disabled" | "provider-default" }): boolean {
  return settings.reasoningMode !== "provider-default";
}

function isUnsupportedThinkingError(payload: any): boolean {
  const message = payload?.error?.message ?? "";
  return typeof message === "string" && /unknown field ["']?thinking|thinking.*unsupported|invalid.*thinking/i.test(message);
}

async function retrieveFallback(user: UserRecord, question: string, limit?: number): Promise<Chunk[]> {
  const docs = await listDocuments(user, "updatedAt", "desc");
  const chunks: Chunk[] = [];
  const selectedDocs = docs
    .map((doc) => ({ doc, score: metadataBoost(question, doc) + keywordScore(question, { path: doc.path, title: doc.title, text: doc.headings.join("\n") }) }))
    .sort((a, b) => b.score - a.score || a.doc.path.localeCompare(b.doc.path))
    .slice(0, Math.max(maxLiveKeywordDocs, limit ?? user.rag.retrieval.topK))
    .map((entry) => entry.doc);

  for (const doc of selectedDocs) {
    const full = await readDocument(user, doc.path);
    const docBoost = metadataBoost(question, full);
    for (const chunk of chunkMarkdownByHeading(full.content, user.rag.retrieval.chunkSize, user.rag.retrieval.chunkOverlap, {
      path: full.path,
      title: full.title
    })) {
      const title = chunk.heading ? `${full.title} > ${chunk.heading}` : full.title;
      const text = formatChunkForContext({ title: full.title, path: full.path, heading: chunk.heading, text: chunk.text });
      const score = docBoost + keywordScore(question, { path: full.path, title, text: chunk.text });
      chunks.push({ id: chunk.id, path: full.path, title, text, tags: full.tags, aliases: full.aliases, score });
    }
  }

  return chunks
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .filter((chunk, index) => chunk.score > 0 || index < user.rag.retrieval.topK)
    .slice(0, limit ?? user.rag.retrieval.topK);
}

async function retrieveIndexedKeyword(user: UserRecord, namespace: VectorNamespace, question: string, topK: number): Promise<Chunk[]> {
  const chunks = await getNamespaceChunks(user.username, namespace, vectorCompatibility(user));
  return chunks
    .map((chunk) => ({
      id: chunk.id,
      path: chunk.path,
      title: chunk.title,
      text: chunk.text,
      tags: chunk.tags,
      aliases: chunk.aliases,
      score: scoreLexicalMatch(question, chunk)
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .filter((chunk, index) => chunk.score > 0 || index < topK)
    .slice(0, topK);
}

async function retrieve(user: UserRecord, question: string): Promise<RetrievalResult> {
  const compatibility = vectorCompatibility(user);
  const productionStats = await getNamespaceStats(user.username, "production", compatibility);
  const testStats = await getNamespaceStats(user.username, "test", compatibility);
  const namespace: VectorNamespace | null =
    productionStats.chunkCount > 0 ? "production" : testStats.chunkCount > 0 ? "test" : null;
  const topK = user.rag.retrieval.topK;
  const candidateK = Math.max(minCandidateK, topK * candidateMultiplier);

  if (namespace) {
    if (user.rag.embedding.provider !== "disabled") {
      try {
        const result = await embedTexts(user.rag.embedding, [question], { inputType: "query" });
        const vectorMatches = await searchVectors(user.username, namespace, result.embeddings[0], candidateK, compatibility);
        const keywordMatches = await retrieveIndexedKeyword(user, namespace, question, candidateK);
        const merged = new Map<string, Chunk>();

        mergeChunks(
          merged,
          vectorMatches.map((match) => ({
            id: match.id,
            path: match.path,
            title: match.title,
            text: match.text,
            tags: match.tags,
            aliases: match.aliases,
            score: scoreVectorMatch(question, match)
          }))
        );
        mergeChunks(merged, keywordMatches.filter((match) => match.score > 0), 1.15);

        return {
          namespace,
          chunks: selectDiverseTopK(Array.from(merged.values()), question, topK)
        };
      } catch (error) {
        const warning = error instanceof Error ? error.message : "Embedding query failed";
        const indexedKeyword = await retrieveIndexedKeyword(user, namespace, question, candidateK);
        const merged = new Map<string, Chunk>();
        mergeChunks(merged, indexedKeyword.filter((match) => match.score > 0), 1.1);
        const chunks = selectDiverseTopK(Array.from(merged.values()), question, topK);
        if ((chunks[0]?.score ?? 0) <= 0) {
          return {
            namespace: "vault-keyword",
            warning,
            chunks: await retrieveFallback(user, question, topK)
          };
        }
        return {
          namespace: `${namespace}-keyword`,
          warning,
          chunks
        };
      }
    }

    const indexedKeyword = await retrieveIndexedKeyword(user, namespace, question, candidateK);
    const merged = new Map<string, Chunk>();
    mergeChunks(merged, indexedKeyword.filter((match) => match.score > 0), 1.1);
    const chunks = selectDiverseTopK(Array.from(merged.values()), question, topK);
    if ((chunks[0]?.score ?? 0) <= 0) {
      return {
        namespace: "vault-keyword",
        chunks: await retrieveFallback(user, question, topK)
      };
    }

    return {
      namespace: `${namespace}-keyword`,
      chunks
    };
  }

  return {
    namespace: "keyword",
    chunks: await retrieveFallback(user, question, topK)
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

function linkCitationReferences(answer: string, citationCount: number): string {
  if (citationCount <= 0) {
    return answer;
  }

  return answer.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (match, rawReferences: string) => {
    const references = rawReferences
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= citationCount);
    return references.length > 0 ? references.map((value) => `[${value}](#source-${value})`).join(", ") : match;
  });
}

async function answerWithProviderAttempt(user: UserRecord, question: string, chunks: Chunk[], options: QaAttemptOptions): Promise<string | null> {
  const settings = user.rag.qa;
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
      signal: AbortSignal.timeout(Math.min(settings.timeoutMs || options.timeoutMs, options.timeoutMs))
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

async function answerWithProvider(user: UserRecord, question: string, chunks: Chunk[]): Promise<string | null> {
  const settings = user.rag.qa;
  if (settings.provider === "disabled") {
    return null;
  }

  const attempts: QaAttemptOptions[] = [
    { maxChunks: maxQaChunks, maxChunkChars: maxQaChunkChars, maxContextChars: maxQaContextChars, maxOutputTokens: 1200, timeoutMs: 18000 },
    { maxChunks: 2, maxChunkChars: 900, maxContextChars: 1800, maxOutputTokens: 800, timeoutMs: 12000 },
    { maxChunks: 1, maxChunkChars: 700, maxContextChars: 700, maxOutputTokens: 500, timeoutMs: 8000 }
  ];
  let lastError: unknown;

  for (const [index, attempt] of attempts.entries()) {
    try {
      return await answerWithProviderAttempt(user, question, chunks, attempt);
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
    const user = authedUser(request, reply);
    if (!user) return;
    const body = z.object({ sampleSize: z.number().int().min(1).max(100).default(20) }).parse(request.body ?? {});
    try {
      return await startIndexJob(user, { mode: "test", sampleSize: body.sampleSize });
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to start test index" };
    }
  });

  app.post("/api/rag/reindex", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    try {
      return await startIndexJob(user, { mode: "full" });
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to start full index" };
    }
  });

  app.post("/api/rag/reindex/incremental", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    try {
      return await startIndexJob(user, { mode: "incremental" });
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to start incremental index" };
    }
  });

  app.get("/api/rag/index-jobs/latest", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    return latestIndexJob(user.username) ?? null;
  });

  app.get("/api/rag/index-jobs/:id", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const job = getIndexJob(user.username, params.id);
    if (!job) {
      reply.code(404);
      return { error: "Index job not found" };
    }
    return job;
  });

  app.post("/api/rag/index-jobs/:id/cancel", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const job = requestIndexJobCancel(user.username, params.id);
    if (!job) {
      reply.code(404);
      return { error: "Index job not found" };
    }
    return job;
  });

  app.post("/api/rag/index-jobs/:id/skip-current-file", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const job = requestIndexJobSkipCurrentFile(user.username, params.id);
    if (!job) {
      reply.code(404);
      return { error: "Index job not found" };
    }
    return job;
  });

  app.get("/api/rag/index-stats", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const compatibility = vectorCompatibility(user);
    return {
      production: await getNamespaceStats(user.username, "production", compatibility),
      test: await getNamespaceStats(user.username, "test", compatibility)
    };
  });

  app.post("/api/rag/query", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const body = z.object({ question: z.string().min(1) }).parse(request.body);
    let retrieval: RetrievalResult;
    try {
      retrieval = await retrieve(user, body.question);
    } catch (error) {
      app.log.warn(error, "Vector retrieval failed; falling back to keyword retrieval");
      retrieval = {
        namespace: "keyword",
        chunks: await retrieveFallback(user, body.question)
      };
    }

    const citations = retrieval.chunks.map((chunk) => ({
      path: chunk.path,
      title: chunk.title,
      score: chunk.score,
      snippet: chunk.text.slice(0, 320)
    }));

    try {
      const providerAnswer = await answerWithProvider(user, body.question, retrieval.chunks);
      const answer =
        providerAnswer ??
        `Q&A provider is disabled. Showing the most relevant ${retrieval.namespace} Markdown snippets for: "${body.question}".`;
      return {
        answer,
        answerHtml: await renderPreview(linkCitationReferences(answer, citations.length)),
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
        answerHtml: await renderPreview(linkCitationReferences(answer, citations.length)),
        indexNamespace: retrieval.namespace,
        retrievalWarning: retrieval.warning,
        providerError,
        citations
      };
    }
  });
}
