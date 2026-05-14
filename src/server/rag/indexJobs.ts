import { randomUUID } from "node:crypto";
import type { RagIndexJob } from "../../shared/types";
import { sha256 } from "../crypto";
import { store, type UserRecord } from "../store";
import { listDocumentFileStats, readDocument, type DocumentFileStat } from "../vault/vaultService";
import { chunkMarkdownByHeading, formatChunkForEmbedding } from "./chunker";
import { embedTexts } from "./embeddingProvider";
import { getNamespaceChunks, getNamespaceFileIndex, replaceNamespace, type FileIndexRecord, type VectorChunk, type VectorNamespace } from "./vectorStore";

// Index jobs are tagged with the username they belong to so each
// user only ever sees their own jobs. We also enforce one
// running/queued job per user (different users can index in
// parallel; the same user cannot stack jobs).
type OwnedJob = RagIndexJob & { username: string };
const jobs = new Map<string, OwnedJob>();

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

function updateJob(job: OwnedJob, patch: Partial<RagIndexJob>) {
  Object.assign(job, patch);
  jobs.set(job.id, job);
}

function isUnchangedFile(record: FileIndexRecord | undefined, doc: DocumentFileStat): boolean {
  if (!record || record.mtimeMs <= 0 || record.size < 0) {
    return false;
  }
  return record.size === doc.size && Math.abs(record.mtimeMs - doc.mtimeMs) < 1;
}

// Routes pass the calling username so we can answer "this user's
// latest job" / "this user's job by id" without leaking other
// users' progress. A null `username` (admin oversight) isn't
// supported on purpose: the spec said no admin backdoor.
export function getIndexJob(username: string, id: string): RagIndexJob | undefined {
  const job = jobs.get(id);
  if (!job || job.username !== username) return undefined;
  // Hide the internal `username` field from the wire shape.
  return stripOwner(job);
}

export function latestIndexJob(username: string): RagIndexJob | undefined {
  const candidate = Array.from(jobs.values())
    .filter((job) => job.username === username)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  return candidate ? stripOwner(candidate) : undefined;
}

function activeJobForUser(username: string): OwnedJob | undefined {
  return Array.from(jobs.values()).find((job) => job.username === username && (job.status === "queued" || job.status === "running"));
}

function stripOwner(job: OwnedJob): RagIndexJob {
  const { username: _username, ...rest } = job;
  return rest;
}

function canControlJob(job: OwnedJob): boolean {
  return job.status === "queued" || job.status === "running";
}

export function requestIndexJobCancel(username: string, id: string): RagIndexJob | undefined {
  const job = jobs.get(id);
  if (!job || job.username !== username || !canControlJob(job)) {
    return job ? stripOwner(job) : undefined;
  }
  updateJob(job, {
    cancelRequested: true,
    message: "Stop requested. The job will stop after the current operation."
  });
  return stripOwner(job);
}

export function requestIndexJobSkipCurrentFile(username: string, id: string): RagIndexJob | undefined {
  const job = jobs.get(id);
  if (!job || job.username !== username || !canControlJob(job)) {
    return job ? stripOwner(job) : undefined;
  }
  updateJob(job, {
    skipRequested: true,
    message: job.currentFile ? `Skip requested for ${job.currentFile}` : "Skip requested for the next file."
  });
  return stripOwner(job);
}

export async function startIndexJob(user: UserRecord, options: { mode: "test" | "full" | "incremental"; sampleSize?: number }): Promise<RagIndexJob> {
  if (user.rag.embedding.provider === "disabled") {
    throw new Error("Embedding provider must be configured before indexing");
  }
  const existing = activeJobForUser(user.username);
  if (existing) {
    throw new Error("Another indexing job is already running for your account. Stop it first.");
  }

  const namespace: VectorNamespace = options.mode === "test" ? "test" : "production";
  const job: OwnedJob = {
    username: user.username,
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

  void runIndexJob(user, job, options.sampleSize).catch((error) => {
    console.error("RAG index job failed", {
      id: job.id,
      username: job.username,
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

  return stripOwner(job);
}

async function runIndexJob(user: UserRecord, job: OwnedJob, sampleSize?: number): Promise<void> {
  updateJob(job, { status: "running", message: "Reading documents" });

  // Re-read the user's settings each time the job runs so any
  // mid-run edit (like changing the rate limit) is picked up.
  // We re-fetch the user from the store so we always work
  // against the latest snapshot.
  const data = await store.load();
  const liveUser = data.users.find((u) => u.username === user.username) ?? user;
  const settings = liveUser.rag;
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
  const docs = await listDocumentFileStats(liveUser, "updatedAt", "desc");
  let selectedDocs = job.mode === "test" ? docs.slice(0, sampleSize ?? 20) : docs;
  const currentPaths = new Set(selectedDocs.map((doc) => doc.path));
  const existingFileIndex = job.mode === "incremental" ? await getNamespaceFileIndex(liveUser.username, "production") : [];
  const existingFileByPath = new Map(existingFileIndex.map((record) => [record.path, record]));
  let deletedIndexedFiles = 0;

  if (job.mode === "incremental" && existingFileIndex.length > 0) {
    const changedDocs = selectedDocs.filter((doc) => !isUnchangedFile(existingFileByPath.get(doc.path), doc));
    deletedIndexedFiles = existingFileIndex.filter((record) => !currentPaths.has(record.path)).length;
    const reusedChunkCount = selectedDocs.reduce((total, doc) => total + (existingFileByPath.get(doc.path)?.chunkCount ?? 0), 0);

    if (changedDocs.length === 0 && deletedIndexedFiles === 0) {
      updateJob(job, {
        status: "completed",
        totalFiles: selectedDocs.length,
        processedFiles: selectedDocs.length,
        skippedFiles: selectedDocs.length,
        totalChunks: reusedChunkCount,
        reusedChunks: reusedChunkCount,
        currentFile: undefined,
        message: "Incremental index complete: no file changes detected",
        finishedAt: new Date().toISOString(),
        elapsedMs: Date.now() - Date.parse(job.startedAt)
      });
      return;
    }

    selectedDocs = changedDocs;
  }

  const changedPaths = new Set(selectedDocs.map((doc) => doc.path));
  const existingVectors = job.mode === "incremental" ? await getNamespaceChunks(liveUser.username, "production") : [];
  const existingByPath = new Map<string, VectorChunk[]>();
  for (const vector of existingVectors) {
    const current = existingByPath.get(vector.path) ?? [];
    current.push(vector);
    existingByPath.set(vector.path, current);
  }
  const vectors: VectorChunk[] =
    job.mode === "incremental" ? existingVectors.filter((vector) => currentPaths.has(vector.path) && !changedPaths.has(vector.path)) : [];
  const fileIndexByPath = new Map<string, FileIndexRecord>(
    job.mode === "incremental"
      ? existingFileIndex.filter((record) => currentPaths.has(record.path) && !changedPaths.has(record.path)).map((record) => [record.path, record])
      : []
  );
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
    await replaceNamespace(liveUser.username, job.namespace, vectors, Array.from(fileIndexByPath.values()));
    checkpointedFiles = job.processedFiles;
    updateJob(job, { message: previousMessage });
  };

  updateJob(job, {
    totalFiles: selectedDocs.length,
    message:
      job.mode === "incremental"
        ? `Indexing ${selectedDocs.length} changed file${selectedDocs.length === 1 ? "" : "s"}${deletedIndexedFiles ? ` and removing ${deletedIndexedFiles} deleted file${deletedIndexedFiles === 1 ? "" : "s"}` : ""}`
        : `Indexing ${selectedDocs.length} file${selectedDocs.length === 1 ? "" : "s"}`
  });

  for (const doc of selectedDocs) {
    if (job.cancelRequested) {
      return cancelJob(job);
    }

    updateJob(job, { currentFile: doc.path, message: `Checking ${doc.path}` });
    const reusable = existingByPath.get(doc.path);
    let fileVectorStart = vectors.length;
    let removedVectorsForPath: VectorChunk[] = [];
    let fileSkipped = false;

    if (job.skipRequested) {
      updateJob(job, {
        skipRequested: false,
        processedFiles: job.processedFiles + 1,
        skippedFiles: job.skippedFiles + 1,
        message: `Skipped ${doc.path}`
      });
      await checkpointIndex();
      continue;
    }

    const existingFile = existingFileByPath.get(doc.path);
    if (job.mode === "incremental" && reusable?.length && isUnchangedFile(existingFile, doc)) {
      updateJob(job, {
        processedFiles: job.processedFiles + 1,
        skippedFiles: job.skippedFiles + 1,
        totalChunks: job.totalChunks + reusable.length,
        reusedChunks: job.reusedChunks + reusable.length,
        message: `Fast reused ${reusable.length} unchanged chunk${reusable.length === 1 ? "" : "s"} from ${doc.path}`
      });
      await checkpointIndex();
      continue;
    }

    const full = await readDocument(liveUser, doc.path);
    if (job.mode === "incremental" && reusable?.length && reusable.every((vector) => vector.hash === full.hash)) {
      fileIndexByPath.set(full.path, {
        path: full.path,
        hash: full.hash,
        updatedAt: doc.updatedAt,
        mtimeMs: doc.mtimeMs,
        size: doc.size,
        chunkCount: reusable.length,
        indexedAt: new Date().toISOString()
      });
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

    fileIndexByPath.set(full.path, {
      path: full.path,
      hash: full.hash,
      updatedAt: doc.updatedAt,
      mtimeMs: doc.mtimeMs,
      size: doc.size,
      chunkCount: chunks.length,
      indexedAt: new Date().toISOString()
    });
    await checkpointIndex();
  }

  if (job.cancelRequested) {
    return cancelJob(job);
  }

  updateJob(job, { message: "Persisting vector index" });
  await replaceNamespace(liveUser.username, job.namespace, vectors, Array.from(fileIndexByPath.values()));

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

function cancelJob(job: OwnedJob): void {
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
