import { randomUUID } from "node:crypto";
import type { RagIndexJob } from "../../shared/types";
import { sha256 } from "../crypto";
import { store } from "../store";
import { listDocuments, readDocument } from "../vault/vaultService";
import { chunkMarkdownByHeading, formatChunkForEmbedding } from "./chunker";
import { embedTexts } from "./embeddingProvider";
import { getNamespaceChunks, replaceNamespace, type VectorChunk, type VectorNamespace } from "./vectorStore";

const jobs = new Map<string, RagIndexJob>();
const embeddingBatchSize = 1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) {
    return text;
  }

  const match = text.match(/\n---(\r?\n|$)/);
  return match?.index === undefined ? text : text.slice(match.index + match[0].length);
}

function formatChunkForContext(title: string, text: string): string {
  return `NOTE TITLE: [[${title}]]\n\nNOTE BLOCK CONTENT:\n\n${stripFrontmatter(text).trimStart()}`;
}

function updateJob(job: RagIndexJob, patch: Partial<RagIndexJob>) {
  Object.assign(job, patch);
  jobs.set(job.id, job);
}

export function getIndexJob(id: string): RagIndexJob | undefined {
  return jobs.get(id);
}

export function latestIndexJob(): RagIndexJob | undefined {
  return Array.from(jobs.values()).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
}

export async function startIndexJob(options: { mode: "test" | "full" | "incremental"; sampleSize?: number }): Promise<RagIndexJob> {
  const data = await store.load();
  if (data.settings.rag.embedding.provider === "disabled") {
    throw new Error("Embedding provider must be configured before indexing");
  }

  const namespace: VectorNamespace = options.mode === "test" ? "test" : "production";
  const job: RagIndexJob = {
    id: randomUUID(),
    mode: options.mode,
    namespace,
    status: "queued",
    totalFiles: 0,
    processedFiles: 0,
    skippedFiles: 0,
    totalChunks: 0,
    embeddedChunks: 0,
    reusedChunks: 0,
    failedChunks: 0,
    message: "Queued",
    startedAt: new Date().toISOString()
  };
  jobs.set(job.id, job);

  void runIndexJob(job, options.sampleSize).catch((error) => {
    updateJob(job, {
      status: "failed",
      error: error instanceof Error ? error.message : "Indexing failed",
      message: "Indexing failed",
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - Date.parse(job.startedAt)
    });
  });

  return job;
}

async function runIndexJob(job: RagIndexJob, sampleSize?: number): Promise<void> {
  updateJob(job, { status: "running", message: "Reading documents" });

  const settings = (await store.load()).settings.rag;
  const docs = await listDocuments("updatedAt", "desc");
  const selectedDocs = job.mode === "test" ? docs.slice(0, sampleSize ?? 20) : docs;
  const existingVectors = job.mode === "incremental" ? await getNamespaceChunks("production") : [];
  const existingByPath = new Map<string, VectorChunk[]>();
  for (const vector of existingVectors) {
    const current = existingByPath.get(vector.path) ?? [];
    current.push(vector);
    existingByPath.set(vector.path, current);
  }
  const currentPaths = new Set(selectedDocs.map((doc) => doc.path));
  const vectors: VectorChunk[] = job.mode === "incremental" ? existingVectors.filter((vector) => currentPaths.has(vector.path)) : [];

  updateJob(job, {
    totalFiles: selectedDocs.length,
    message: `Indexing ${selectedDocs.length} file${selectedDocs.length === 1 ? "" : "s"}`
  });

  for (const doc of selectedDocs) {
    updateJob(job, { currentFile: doc.path, message: `Chunking ${doc.path}` });
    const full = await readDocument(doc.path);
    const reusable = existingByPath.get(full.path);
    if (job.mode === "incremental" && reusable?.length && reusable.every((vector) => vector.hash === full.hash)) {
      updateJob(job, {
        processedFiles: job.processedFiles + 1,
        skippedFiles: job.skippedFiles + 1,
        totalChunks: job.totalChunks + reusable.length,
        reusedChunks: job.reusedChunks + reusable.length,
        message: `Reused ${reusable.length} unchanged chunk${reusable.length === 1 ? "" : "s"} from ${full.path}`
      });
      continue;
    }

    if (job.mode === "incremental") {
      for (let index = vectors.length - 1; index >= 0; index -= 1) {
        if (vectors[index].path === full.path) {
          vectors.splice(index, 1);
        }
      }
    }

    const chunks = chunkMarkdownByHeading(full.content, settings.retrieval.chunkSize, settings.retrieval.chunkOverlap).map((chunk) => ({
      ...chunk,
      embeddingText: formatChunkForEmbedding({
        title: full.title,
        path: full.path,
        tags: full.tags,
        aliases: full.aliases,
        frontmatter: full.frontmatter,
        heading: chunk.heading,
        text: chunk.text
      })
    }));
    updateJob(job, {
      processedFiles: job.processedFiles + 1,
      totalChunks: job.totalChunks + chunks.length
    });

    for (let index = 0; index < chunks.length; index += embeddingBatchSize) {
      const batch = chunks.slice(index, index + embeddingBatchSize);
      updateJob(job, { message: `Embedding ${doc.path} (${index + 1}-${index + batch.length}/${chunks.length})` });

      try {
        const result = await embedTexts(settings.embedding, batch.map((chunk) => chunk.embeddingText));
        result.embeddings.forEach((embedding, batchIndex) => {
          const chunk = batch[batchIndex];
          vectors.push({
            id: sha256(`${doc.path}:${chunk.index}:${chunk.embeddingText}`),
            path: full.path,
            title: chunk.heading ? `${full.title} > ${chunk.heading}` : full.title,
            text: formatChunkForContext(full.title, chunk.text),
            hash: full.hash,
            tags: full.tags,
            aliases: full.aliases,
            embedding
          });
        });
        updateJob(job, { embeddedChunks: job.embeddedChunks + batch.length });
        await sleep(150);
      } catch (error) {
        const batchError = error instanceof Error ? error.message : "Embedding batch failed";
        updateJob(job, { message: `${batchError}; retrying chunks one by one` });

        for (const chunk of batch) {
          try {
            const result = await embedTexts(settings.embedding, [chunk.embeddingText]);
            vectors.push({
              id: sha256(`${doc.path}:${chunk.index}:${chunk.embeddingText}`),
              path: full.path,
              title: chunk.heading ? `${full.title} > ${chunk.heading}` : full.title,
              text: formatChunkForContext(full.title, chunk.text),
              hash: full.hash,
              tags: full.tags,
              aliases: full.aliases,
              embedding: result.embeddings[0]
            });
            updateJob(job, { embeddedChunks: job.embeddedChunks + 1 });
          } catch (singleError) {
            const message = singleError instanceof Error ? singleError.message : "Embedding chunk failed";
            console.warn("Embedding chunk failed", {
              path: full.path,
              chunkIndex: chunk.index,
              chars: chunk.embeddingText.length,
              message
            });
            vectors.push({
              id: sha256(`${doc.path}:${chunk.index}:${chunk.embeddingText}`),
              path: full.path,
              title: chunk.heading ? `${full.title} > ${chunk.heading}` : full.title,
              text: formatChunkForContext(full.title, chunk.text),
              hash: full.hash,
              tags: full.tags,
              aliases: full.aliases,
              embedding: []
            });
            updateJob(job, {
              failedChunks: job.failedChunks + 1,
              message: `${message}; saved chunk for lexical search only`
            });
          }
          await sleep(150);
        }
      }
    }
  }

  updateJob(job, { message: "Persisting vector index" });
  await replaceNamespace(job.namespace, vectors);

  updateJob(job, {
    status: "completed",
    message:
      job.mode === "incremental"
        ? `Incremental index complete: ${job.embeddedChunks} embedded, ${job.reusedChunks} reused`
        : `Indexed ${vectors.length} vector chunk${vectors.length === 1 ? "" : "s"}`,
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - Date.parse(job.startedAt)
  });
}
