import { randomUUID } from "node:crypto";
import type { RagIndexJob } from "../../shared/types";
import { store, type UserRecord } from "../store";
import { listDocumentFileStats, readDocument, type DocumentFileStat } from "../vault/vaultService";
import { RAG_CHUNKING_VERSION, chunkMarkdownByHeading, formatChunkForContext, formatChunkForEmbedding, type MarkdownChunk } from "./chunker";
import { embedTexts } from "./embeddingProvider";
import { getNamespaceChunks, getNamespaceFileIndex, replaceNamespace, type FileIndexRecord, type VectorChunk, type VectorNamespace } from "./vectorStore";

// Index jobs are tagged with the username they belong to so each
// user only ever sees their own jobs. We also enforce one
// running/queued job per user (different users can index in
// parallel; the same user cannot stack jobs).
type OwnedJob = RagIndexJob & { username: string };
const jobs = new Map<string, OwnedJob>();

interface PendingEmbeddingChunk {
  path: string;
  title: string;
  hash: string;
  tags: string[];
  aliases: string[];
  mtimeMs: number;
  chunk: MarkdownChunk;
  embeddingText: string;
}

export function isRagIndexableDocumentPath(documentPath: string): boolean {
  return !documentPath.replaceAll("\\", "/").toLowerCase().startsWith("copilot/");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const data = await store.load();
  const liveUser = data.users.find((u) => u.username === user.username) ?? user;
  const settings = liveUser.rag;
  const embeddingBatchSize = Math.max(1, Math.min(128, settings.indexing?.embeddingBatchSize ?? 16));
  const embeddingRequestsPerMinute = Math.max(0, settings.indexing?.embeddingRequestsPerMinute ?? 0);
  const numberOfPartitions = Math.max(1, Math.min(64, settings.indexing?.numberOfPartitions ?? 2));
  const minEmbeddingRequestGapMs = embeddingRequestsPerMinute > 0 ? Math.ceil(60000 / embeddingRequestsPerMinute) : 0;
  const checkpointInterval = Math.max(1, embeddingBatchSize * 8);
  const metrics = {
    excludedCopilotFiles: 0,
    selectedFiles: 0,
    changedFiles: 0,
    pendingChunks: 0,
    embeddingRequests: 0,
    embeddingInputs: 0,
    checkpointSaves: 0,
    singleRetries: 0,
    skippedDuringEmbedding: 0,
    startedAt: Date.now()
  };
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
    metrics.embeddingRequests += 1;
    metrics.embeddingInputs += input.length;
    return embedTexts(settings.embedding, input, { inputType: "passage" });
  };

  const allDocs = await listDocumentFileStats(liveUser, "updatedAt", "desc");
  const docs = allDocs.filter((doc) => isRagIndexableDocumentPath(doc.path));
  metrics.excludedCopilotFiles = allDocs.length - docs.length;
  let selectedDocs = job.mode === "test" ? docs.slice(0, sampleSize ?? 20) : docs;
  metrics.selectedFiles = selectedDocs.length;
  const currentPaths = new Set(selectedDocs.map((doc) => doc.path));
  const indexCompatibility = { embeddingModel: settings.embedding.model, chunkingVersion: RAG_CHUNKING_VERSION };
  const indexWriteOptions = { ...indexCompatibility, partitions: numberOfPartitions };
  const existingFileIndex = job.mode === "incremental" ? await getNamespaceFileIndex(liveUser.username, "production", indexCompatibility) : [];
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
      console.info("RAG index job metrics", {
        id: job.id,
        username: job.username,
        mode: job.mode,
        namespace: job.namespace,
        status: "completed",
        excludedCopilotFiles: metrics.excludedCopilotFiles,
        selectedFiles: metrics.selectedFiles,
        changedFiles: 0,
        pendingChunks: 0,
        embeddingBatchSize,
        numberOfPartitions,
        embeddingRequests: 0,
        elapsedMs: Date.now() - metrics.startedAt
      });
      return;
    }

    selectedDocs = changedDocs;
  }

  metrics.changedFiles = selectedDocs.length;
  const changedPaths = new Set(selectedDocs.map((doc) => doc.path));
  const existingVectors = job.mode === "incremental" ? await getNamespaceChunks(liveUser.username, "production", indexCompatibility) : [];
  const existingByPath = new Map<string, VectorChunk[]>();
  for (const vector of existingVectors) {
    const current = existingByPath.get(vector.path) ?? [];
    current.push(vector);
    existingByPath.set(vector.path, current);
  }
  let vectors: VectorChunk[] =
    job.mode === "incremental" ? existingVectors.filter((vector) => currentPaths.has(vector.path) && !changedPaths.has(vector.path)) : [];
  const fileIndexByPath = new Map<string, FileIndexRecord>(
    job.mode === "incremental"
      ? existingFileIndex.filter((record) => currentPaths.has(record.path) && !changedPaths.has(record.path)).map((record) => [record.path, record])
      : []
  );

  if (vectors.length > 0) {
    updateJob(job, {
      totalChunks: vectors.length,
      reusedChunks: vectors.length
    });
  }

  const pendingChunks: PendingEmbeddingChunk[] = [];
  const pendingFileByPath = new Map<string, FileIndexRecord>();
  const pendingChunkCountByPath = new Map<string, number>();
  const settledChunkCountByPath = new Map<string, number>();
  const finalizedPaths = new Set<string>();
  const skippedPaths = new Set<string>();
  const processedPaths = new Set<string>();
  let lastCheckpointVectorCount = vectors.length;

  const logMetrics = (status: RagIndexJob["status"]) => {
    console.info("RAG index job metrics", {
      id: job.id,
      username: job.username,
      mode: job.mode,
      namespace: job.namespace,
      status,
      excludedCopilotFiles: metrics.excludedCopilotFiles,
      selectedFiles: metrics.selectedFiles,
      changedFiles: metrics.changedFiles,
      pendingChunks: metrics.pendingChunks,
      embeddingBatchSize,
      numberOfPartitions,
      embeddingRequests: metrics.embeddingRequests,
      embeddingInputs: metrics.embeddingInputs,
      checkpointSaves: metrics.checkpointSaves,
      singleRetries: metrics.singleRetries,
      skippedDuringEmbedding: metrics.skippedDuringEmbedding,
      failedChunks: job.failedChunks,
      vectorChunks: vectors.length,
      elapsedMs: Date.now() - metrics.startedAt
    });
  };

  const markFileProcessed = (docPath: string) => {
    if (processedPaths.has(docPath)) {
      return;
    }
    processedPaths.add(docPath);
    updateJob(job, { processedFiles: job.processedFiles + 1 });
  };

  const recordSkippedPath = (docPath: string, message: string) => {
    if (skippedPaths.has(docPath)) {
      updateJob(job, { skipRequested: false, message });
      return;
    }

    skippedPaths.add(docPath);
    vectors = vectors.filter((vector) => vector.path !== docPath);
    fileIndexByPath.delete(docPath);
    pendingFileByPath.delete(docPath);
    settledChunkCountByPath.delete(docPath);
    finalizedPaths.delete(docPath);

    const pendingCount = pendingChunkCountByPath.get(docPath) ?? 0;
    pendingChunkCountByPath.delete(docPath);

    const reusable = existingByPath.get(docPath) ?? [];
    const existingFile = existingFileByPath.get(docPath);
    let restoredCount = 0;
    if (job.mode === "incremental" && existingFile && currentPaths.has(docPath) && reusable.length > 0) {
      vectors.push(...reusable);
      fileIndexByPath.set(existingFile.path, existingFile);
      restoredCount = reusable.length;
    }

    updateJob(job, {
      skipRequested: false,
      skippedFiles: job.skippedFiles + 1,
      totalChunks: Math.max(0, job.totalChunks - pendingCount + restoredCount),
      reusedChunks: job.reusedChunks + restoredCount,
      message
    });
    markFileProcessed(docPath);
  };

  const finalizePathIfComplete = (docPath: string) => {
    if (skippedPaths.has(docPath) || finalizedPaths.has(docPath)) {
      return;
    }

    const expected = pendingChunkCountByPath.get(docPath);
    if (expected === undefined || (settledChunkCountByPath.get(docPath) ?? 0) < expected) {
      return;
    }

    const pendingFile = pendingFileByPath.get(docPath);
    if (!pendingFile) {
      return;
    }

    fileIndexByPath.set(docPath, {
      ...pendingFile,
      indexedAt: new Date().toISOString()
    });
    finalizedPaths.add(docPath);
    markFileProcessed(docPath);
  };

  const addVector = (item: PendingEmbeddingChunk, embedding: number[], embedded: boolean) => {
    if (skippedPaths.has(item.path)) {
      return;
    }

    vectors.push({
      id: item.chunk.id ?? `${item.path}#${item.chunk.index}`,
      path: item.path,
      title: item.chunk.heading ? `${item.title} > ${item.chunk.heading}` : item.title,
      text: formatChunkForContext({ title: item.title, path: item.path, heading: item.chunk.heading, text: item.chunk.text }),
      hash: item.hash,
      tags: item.tags,
      aliases: item.aliases,
      heading: item.chunk.heading,
      contentHash: item.chunk.contentHash,
      mtimeMs: item.mtimeMs,
      embeddingModel: settings.embedding.model,
      chunkingVersion: RAG_CHUNKING_VERSION,
      embedding
    });

    settledChunkCountByPath.set(item.path, (settledChunkCountByPath.get(item.path) ?? 0) + 1);
    if (embedded) {
      updateJob(job, { embeddedChunks: job.embeddedChunks + 1 });
    }
    finalizePathIfComplete(item.path);
  };

  const completeVectorSnapshot = () => {
    return vectors.filter((vector) => fileIndexByPath.has(vector.path) && !skippedPaths.has(vector.path));
  };

  const persistIndexSnapshot = async (message: string, persistTestNamespace = true) => {
    if (job.mode === "test" && !persistTestNamespace) {
      return;
    }
    updateJob(job, { message });
    await replaceNamespace(liveUser.username, job.namespace, completeVectorSnapshot(), Array.from(fileIndexByPath.values()), indexWriteOptions);
  };

  const persistPartialIndex = async () => {
    await persistIndexSnapshot("Persisting partial vector index", false);
  };

  const checkpointIndexIfNeeded = async () => {
    if (job.mode === "test" || vectors.length - lastCheckpointVectorCount < checkpointInterval) {
      return;
    }
    await persistIndexSnapshot("Checkpoint saving vector index", false);
    lastCheckpointVectorCount = vectors.length;
    metrics.checkpointSaves += 1;
  };

  const drainPendingChunks = async (flushAll: boolean): Promise<boolean> => {
    while (pendingChunks.length >= embeddingBatchSize || (flushAll && pendingChunks.length > 0)) {
      if (job.cancelRequested) {
        await persistPartialIndex();
        logMetrics("cancelled");
        cancelJob(job);
        return false;
      }

      while (pendingChunks.length > 0 && skippedPaths.has(pendingChunks[0].path)) {
        pendingChunks.shift();
      }
      if (pendingChunks.length === 0) {
        return true;
      }

      if (job.skipRequested) {
        const skipPath = job.currentFile ?? pendingChunks[0].path;
        metrics.skippedDuringEmbedding += 1;
        recordSkippedPath(skipPath, `Skipped ${skipPath}`);
        continue;
      }

      const rawBatch = pendingChunks.splice(0, embeddingBatchSize);
      const batch = rawBatch.filter((item) => !skippedPaths.has(item.path));
      if (batch.length === 0) {
        continue;
      }

      const settledBefore = job.embeddedChunks + job.failedChunks;
      updateJob(job, {
        currentFile: batch[0].path,
        message: `Embedding chunks ${settledBefore + 1}-${Math.min(job.totalChunks, settledBefore + batch.length)}/${job.totalChunks}`
      });

      try {
        const result = await embedBatch(batch.map((item) => item.embeddingText));
        batch.forEach((item, batchIndex) => {
          const embedding = result.embeddings[batchIndex] ?? [];
          if (embedding.length === 0) {
            updateJob(job, {
              failedChunks: job.failedChunks + 1,
              message: "Embedding response missed a chunk; saved it for lexical search only"
            });
            addVector(item, [], false);
            return;
          }
          addVector(item, embedding, true);
        });
      } catch (error) {
        const batchError = error instanceof Error ? error.message : "Embedding batch failed";
        updateJob(job, { message: `${batchError}; retrying chunks one by one` });

        for (const item of batch) {
          if (job.cancelRequested) {
            await persistPartialIndex();
            logMetrics("cancelled");
            cancelJob(job);
            return false;
          }
          if (job.skipRequested) {
            const skipPath = job.currentFile ?? item.path;
            metrics.skippedDuringEmbedding += 1;
            recordSkippedPath(skipPath, `Skipped ${skipPath}`);
            if (skippedPaths.has(item.path)) {
              continue;
            }
          }
          if (skippedPaths.has(item.path)) {
            continue;
          }

          try {
            metrics.singleRetries += 1;
            const result = await embedBatch([item.embeddingText]);
            const embedding = result.embeddings[0] ?? [];
            if (embedding.length === 0) {
              updateJob(job, {
                failedChunks: job.failedChunks + 1,
                message: "Embedding response missed a chunk; saved it for lexical search only"
              });
              addVector(item, [], false);
            } else {
              addVector(item, embedding, true);
            }
          } catch (singleError) {
            const message = singleError instanceof Error ? singleError.message : "Embedding chunk failed";
            console.warn("Embedding chunk failed", {
              path: item.path,
              chunkIndex: item.chunk.index,
              chars: item.embeddingText.length,
              message
            });
            updateJob(job, {
              failedChunks: job.failedChunks + 1,
              message: `${message}; saved chunk for lexical search only`
            });
            addVector(item, [], false);
          }
        }
      }

      await checkpointIndexIfNeeded();
    }

    return true;
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
      await persistPartialIndex();
      logMetrics("cancelled");
      return cancelJob(job);
    }

    updateJob(job, { currentFile: doc.path, message: `Checking ${doc.path}` });

    if (job.skipRequested) {
      recordSkippedPath(doc.path, `Skipped ${doc.path}`);
      continue;
    }

    const reusable = existingByPath.get(doc.path);
    const existingFile = existingFileByPath.get(doc.path);
    if (job.mode === "incremental" && reusable?.length && isUnchangedFile(existingFile, doc)) {
      if (!fileIndexByPath.has(doc.path) && existingFile) {
        fileIndexByPath.set(doc.path, existingFile);
      }
      if (!vectors.some((vector) => vector.path === doc.path)) {
        vectors.push(...reusable);
      }
      updateJob(job, {
        skippedFiles: job.skippedFiles + 1,
        totalChunks: job.totalChunks + reusable.length,
        reusedChunks: job.reusedChunks + reusable.length,
        message: `Fast reused ${reusable.length} unchanged chunk${reusable.length === 1 ? "" : "s"} from ${doc.path}`
      });
      markFileProcessed(doc.path);
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
        skippedFiles: job.skippedFiles + 1,
        totalChunks: job.totalChunks + reusable.length,
        reusedChunks: job.reusedChunks + reusable.length,
        message: `Reused ${reusable.length} unchanged chunk${reusable.length === 1 ? "" : "s"} from ${full.path}`
      });
      markFileProcessed(full.path);
      continue;
    }

    if (job.mode === "incremental") {
      vectors = vectors.filter((vector) => vector.path !== full.path);
      fileIndexByPath.delete(full.path);
    }

    const chunks = chunkMarkdownByHeading(full.content, settings.retrieval.chunkSize, settings.retrieval.chunkOverlap, {
      path: full.path,
      title: full.title,
      mtimeMs: doc.mtimeMs
    }).map((chunk) => ({
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

    pendingChunkCountByPath.set(full.path, chunks.length);
    pendingFileByPath.set(full.path, {
      path: full.path,
      hash: full.hash,
      updatedAt: doc.updatedAt,
      mtimeMs: doc.mtimeMs,
      size: doc.size,
      chunkCount: chunks.length,
      indexedAt: new Date().toISOString()
    });

    if (chunks.length === 0) {
      finalizePathIfComplete(full.path);
    }

    for (const chunk of chunks) {
      pendingChunks.push({
        path: full.path,
        title: full.title,
        hash: full.hash,
        tags: full.tags,
        aliases: full.aliases,
        mtimeMs: doc.mtimeMs,
        chunk,
        embeddingText: chunk.embeddingText
      });
    }

    updateJob(job, { totalChunks: job.totalChunks + chunks.length });
    if (!(await drainPendingChunks(false))) {
      return;
    }
  }

  metrics.pendingChunks = job.totalChunks;
  updateJob(job, {
    currentFile: undefined,
    message:
      pendingChunks.length > 0
        ? `Embedding ${pendingChunks.length} chunk${pendingChunks.length === 1 ? "" : "s"} in batches of ${embeddingBatchSize}`
        : "Persisting vector index"
  });
  if (!(await drainPendingChunks(true))) {
    return;
  }

  if (job.cancelRequested) {
    await persistPartialIndex();
    logMetrics("cancelled");
    return cancelJob(job);
  }

  await persistIndexSnapshot("Persisting vector index");
  logMetrics("completed");

  updateJob(job, {
    status: "completed",
    message:
      job.mode === "incremental"
        ? `Incremental index complete: ${job.embeddedChunks} embedded, ${job.reusedChunks} reused, ${metrics.embeddingRequests} embedding request${metrics.embeddingRequests === 1 ? "" : "s"}`
        : `Indexed ${vectors.length} vector chunk${vectors.length === 1 ? "" : "s"} with ${metrics.embeddingRequests} embedding request${metrics.embeddingRequests === 1 ? "" : "s"}`,
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
    message: "Indexing stopped. Completed files can be reused by incremental indexing.",
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - Date.parse(job.startedAt)
  });
}
