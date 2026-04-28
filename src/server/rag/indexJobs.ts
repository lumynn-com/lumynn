import { randomUUID } from "node:crypto";
import type { RagIndexJob } from "../../shared/types";
import { sha256 } from "../crypto";
import { store } from "../store";
import { listDocuments, readDocument } from "../vault/vaultService";
import { chunkMarkdownByHeading, formatChunkForEmbedding } from "./chunker";
import { embedTexts } from "./embeddingProvider";
import { getNamespaceChunks, replaceNamespace, type VectorChunk, type VectorNamespace } from "./vectorStore";

const jobs = new Map<string, RagIndexJob>();

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

function canControlJob(job: RagIndexJob): boolean {
  return job.status === "queued" || job.status === "running";
}

export function requestIndexJobCancel(id: string): RagIndexJob | undefined {
  const job = jobs.get(id);
  if (!job || !canControlJob(job)) {
    return job;
  }
  updateJob(job, {
    cancelRequested: true,
    message: "Stop requested. The job will stop after the current operation."
  });
  return job;
}

export function requestIndexJobSkipCurrentFile(id: string): RagIndexJob | undefined {
  const job = jobs.get(id);
  if (!job || !canControlJob(job)) {
    return job;
  }
  updateJob(job, {
    skipRequested: true,
    message: job.currentFile ? `Skip requested for ${job.currentFile}` : "Skip requested for the next file."
  });
  return job;
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
    console.error("RAG index job failed", {
      id: job.id,
      mode: job.mode,
      namespace: job.namespace,
      currentFile: job.currentFile,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
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
  const embeddingBatchSize = Math.max(1, Math.min(128, settings.indexing?.embeddingBatchSize ?? 16));
  const embeddingRequestsPerMinute = Math.max(0, settings.indexing?.embeddingRequestsPerMinute ?? 0);
  const minEmbeddingRequestGapMs = embeddingRequestsPerMinute > 0 ? Math.ceil(60000 / embeddingRequestsPerMinute) : 0;
  const checkpointFileInterval = Math.max(10, Math.min(100, 8 * embeddingBatchSize));
  let lastEmbeddingRequestStartedAt = 0;
  const embedBatch = async (input: string[]) => {
    if (minEmbeddingRequestGapMs > 0 && lastEmbeddingRequestStartedAt > 0) {
      const elapsedMs = Date.now() - lastEmbeddingRequestStartedAt;
      const waitMs = minEmbeddingRequestGapMs - elapsedMs;
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }
    lastEmbeddingRequestStartedAt = Date.now();
    return embedTexts(settings.embedding, input, { inputType: "passage" });
  };
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
  let checkpointedFiles = 0;
  const checkpointIndex = async (force = false) => {
    if (job.mode === "test") {
      return;
    }
    if (!force && job.processedFiles - checkpointedFiles < checkpointFileInterval) {
      return;
    }
    const previousMessage = job.message;
    updateJob(job, { message: `Checkpointing index (${job.processedFiles}/${job.totalFiles} files)` });
    await replaceNamespace(job.namespace, vectors);
    checkpointedFiles = job.processedFiles;
    updateJob(job, { message: previousMessage });
  };

  updateJob(job, {
    totalFiles: selectedDocs.length,
    message: `Indexing ${selectedDocs.length} file${selectedDocs.length === 1 ? "" : "s"}`
  });

  for (const doc of selectedDocs) {
    if (job.cancelRequested) {
      return cancelJob(job);
    }

    updateJob(job, { currentFile: doc.path, message: `Chunking ${doc.path}` });
    const full = await readDocument(doc.path);
    const reusable = existingByPath.get(full.path);
    let fileVectorStart = vectors.length;
    let removedVectorsForPath: VectorChunk[] = [];
    let fileSkipped = false;

    if (job.skipRequested) {
      updateJob(job, {
        skipRequested: false,
        processedFiles: job.processedFiles + 1,
        skippedFiles: job.skippedFiles + 1,
        message: `Skipped ${full.path}`
      });
      await checkpointIndex();
      continue;
    }

    if (job.mode === "incremental" && reusable?.length && reusable.every((vector) => vector.hash === full.hash)) {
      updateJob(job, {
        processedFiles: job.processedFiles + 1,
        skippedFiles: job.skippedFiles + 1,
        totalChunks: job.totalChunks + reusable.length,
        reusedChunks: job.reusedChunks + reusable.length,
        message: `Reused ${reusable.length} unchanged chunk${reusable.length === 1 ? "" : "s"} from ${full.path}`
      });
      await checkpointIndex();
      continue;
    }

    if (job.mode === "incremental") {
      for (let index = vectors.length - 1; index >= 0; index -= 1) {
        if (vectors[index].path === full.path) {
          removedVectorsForPath.push(vectors[index]);
          vectors.splice(index, 1);
        }
      }
      fileVectorStart = vectors.length;
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
      if (job.cancelRequested) {
        vectors.splice(fileVectorStart);
        return cancelJob(job);
      }
      if (job.skipRequested) {
        vectors.splice(fileVectorStart);
        vectors.push(...removedVectorsForPath.reverse());
        updateJob(job, {
          skipRequested: false,
          skippedFiles: job.skippedFiles + 1,
          message: `Skipped ${full.path}`
        });
        fileSkipped = true;
        break;
      }

      const batch = chunks.slice(index, index + embeddingBatchSize);
      updateJob(job, { message: `Embedding ${doc.path} (${index + 1}-${index + batch.length}/${chunks.length})` });

      try {
        const result = await embedBatch(batch.map((chunk) => chunk.embeddingText));
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
      } catch (error) {
        const batchError = error instanceof Error ? error.message : "Embedding batch failed";
        updateJob(job, { message: `${batchError}; retrying chunks one by one` });

        for (const chunk of batch) {
          if (job.cancelRequested) {
            vectors.splice(fileVectorStart);
            return cancelJob(job);
          }
          if (job.skipRequested) {
            vectors.splice(fileVectorStart);
            vectors.push(...removedVectorsForPath.reverse());
            updateJob(job, {
              skipRequested: false,
              skippedFiles: job.skippedFiles + 1,
              message: `Skipped ${full.path}`
            });
            fileSkipped = true;
            break;
          }
          try {
            const result = await embedBatch([chunk.embeddingText]);
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
        }
      }

      if (fileSkipped) {
        break;
      }
    }

    if (fileSkipped) {
      await checkpointIndex();
      continue;
    }

    await checkpointIndex();
  }

  if (job.cancelRequested) {
    return cancelJob(job);
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

function cancelJob(job: RagIndexJob): void {
  updateJob(job, {
    status: "cancelled",
    cancelRequested: false,
    skipRequested: false,
    currentFile: undefined,
    message: "Indexing stopped. Completed checkpointed files can be reused by incremental indexing.",
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - Date.parse(job.startedAt)
  });
}
