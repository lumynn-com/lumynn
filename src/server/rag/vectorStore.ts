import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config";
import { adminUsers, store } from "../store";
import { RAG_CHUNKING_VERSION } from "./chunker";

export type VectorNamespace = "test" | "production";
export interface VectorIndexCompatibility {
  embeddingModel?: string;
  chunkingVersion?: number;
  partitions?: number;
}

export interface VectorChunk {
  id: string;
  path: string;
  title: string;
  text: string;
  hash: string;
  tags?: string[];
  aliases?: string[];
  heading?: string;
  contentHash?: string;
  mtimeMs?: number;
  embeddingModel?: string;
  chunkingVersion?: number;
  embedding: number[];
}

export interface FileIndexRecord {
  path: string;
  hash: string;
  updatedAt: string;
  mtimeMs: number;
  size: number;
  chunkCount: number;
  indexedAt: string;
}

interface VectorIndexFile {
  namespaces: Record<string, { updatedAt: string; chunks: VectorChunk[] }>;
}

interface StoredVectorChunk {
  id: string;
  path: string;
  title: string;
  text: string;
  hash: string;
  tags?: string[];
  aliases?: string[];
  heading?: string;
  contentHash?: string;
  mtimeMs?: number;
  embeddingModel?: string;
  chunkingVersion?: number;
  embeddingLength: number;
}

interface NamespaceManifest {
  storageVersion: number;
  format: "jsonl-float32";
  updatedAt: string;
  chunkCount: number;
  embeddingFloatCount: number;
  partitionCount?: number;
  embeddingModel?: string;
  chunkingVersion?: number;
}

interface FileIndexSnapshot {
  storageVersion: 1;
  updatedAt: string;
  files: FileIndexRecord[];
}

const legacyIndexPath = path.join(config.dataDir, "vector-index.json");
const indexDir = path.join(config.dataDir, "vector-index");
const activeStorageVersion = 3;

let migrationPromise: Promise<void> | null = null;

// Hash the username so the on-disk directory is path-safe and a
// fixed length, regardless of what the user's name looks like
// (including non-ASCII or otherwise unfortunate characters).
function userKey(username: string): string {
  return crypto.createHash("sha256").update(username).digest("hex").slice(0, 16);
}

// Per-user vector index dir. Exposed so userRoutes can `rm -rf`
// it when an admin deletes a user.
export function vectorIndexDirForUser(username: string): string {
  return path.join(indexDir, userKey(username));
}

function namespacePath(username: string, namespace: VectorNamespace, extension: "jsonl" | "f32" | "manifest.json" | "files.json"): string {
  return path.join(vectorIndexDirForUser(username), `${namespace}.${extension}`);
}

function namespacePartitionPath(username: string, namespace: VectorNamespace, partition: number, extension: "jsonl" | "f32"): string {
  return path.join(vectorIndexDirForUser(username), `${namespace}.part-${partition}.${extension}`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function extractLegacyMetadata(text: string): { tags: string[]; aliases: string[] } {
  const metadataLine = text
    .slice(0, Math.max(0, text.indexOf("NOTE BLOCK CONTENT:")))
    .split(/\r?\n/)
    .find((line) => line.startsWith("METADATA: "));

  if (!metadataLine) {
    return { tags: [], aliases: [] };
  }

  try {
    const metadata = JSON.parse(metadataLine.slice("METADATA: ".length)) as { tags?: unknown; aliases?: unknown };
    return {
      tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === "string") : [],
      aliases: Array.isArray(metadata.aliases) ? metadata.aliases.filter((alias): alias is string => typeof alias === "string") : []
    };
  } catch {
    return { tags: [], aliases: [] };
  }
}

async function loadLegacyIndex(): Promise<VectorIndexFile | null> {
  try {
    return JSON.parse(await fs.readFile(legacyIndexPath, "utf8")) as VectorIndexFile;
  } catch {
    return null;
  }
}

async function readManifest(username: string, namespace: VectorNamespace): Promise<NamespaceManifest | null> {
  try {
    return JSON.parse(await fs.readFile(namespacePath(username, namespace, "manifest.json"), "utf8")) as NamespaceManifest;
  } catch {
    return null;
  }
}

function compatibleChunkingVersion(options?: VectorIndexCompatibility): number {
  return options?.chunkingVersion ?? RAG_CHUNKING_VERSION;
}

function isCompatibleManifest(manifest: NamespaceManifest | null, options?: VectorIndexCompatibility): boolean {
  if (!manifest || manifest.storageVersion !== activeStorageVersion) {
    return false;
  }
  if (manifest.chunkingVersion !== compatibleChunkingVersion(options)) {
    return false;
  }
  if (options?.embeddingModel && manifest.embeddingModel !== options.embeddingModel) {
    return false;
  }
  return true;
}

function deriveFileIndexFromChunks(chunks: VectorChunk[], updatedAt: string): FileIndexRecord[] {
  const byPath = new Map<string, FileIndexRecord>();
  for (const chunk of chunks) {
    const current = byPath.get(chunk.path);
    if (current) {
      current.chunkCount += 1;
      continue;
    }
    byPath.set(chunk.path, {
      path: chunk.path,
      hash: chunk.hash,
      updatedAt,
      mtimeMs: 0,
      size: 0,
      chunkCount: 1,
      indexedAt: updatedAt
    });
  }
  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function normalizePartitionCount(partitions: number | undefined): number {
  const value = Number(partitions ?? 1);
  return Number.isFinite(value) ? Math.max(1, Math.min(64, Math.trunc(value))) : 1;
}

function splitIntoPartitions(chunks: VectorChunk[], partitionCount: number): VectorChunk[][] {
  const partitions = Array.from({ length: partitionCount }, () => [] as VectorChunk[]);
  if (chunks.length === 0) {
    return partitions;
  }

  chunks.forEach((chunk, index) => {
    const partitionIndex = Math.min(partitionCount - 1, Math.floor((index * partitionCount) / chunks.length));
    partitions[partitionIndex].push(chunk);
  });
  return partitions;
}

function serializeCompactPartition(
  chunks: VectorChunk[],
  options: VectorIndexCompatibility
): { metadataText: string; embeddingsBuffer: Buffer; embeddingFloatCount: number } {
  const finiteEmbeddings = chunks.map((chunk) => chunk.embedding.filter((value) => Number.isFinite(value)));
  const embeddingFloatCount = finiteEmbeddings.reduce((total, embedding) => total + embedding.length, 0);
  const embeddingsBuffer = Buffer.allocUnsafe(embeddingFloatCount * 4);
  const metadataLines: string[] = [];
  let byteOffset = 0;

  for (const [index, chunk] of chunks.entries()) {
    const embedding = finiteEmbeddings[index];
    const legacyMetadata = extractLegacyMetadata(chunk.text);
    metadataLines.push(
      JSON.stringify({
        id: chunk.id,
        path: chunk.path,
        title: chunk.title,
        text: chunk.text,
        hash: chunk.hash,
        tags: chunk.tags?.length ? chunk.tags : legacyMetadata.tags,
        aliases: chunk.aliases?.length ? chunk.aliases : legacyMetadata.aliases,
        heading: chunk.heading,
        contentHash: chunk.contentHash,
        mtimeMs: chunk.mtimeMs,
        embeddingModel: chunk.embeddingModel ?? options.embeddingModel,
        chunkingVersion: chunk.chunkingVersion ?? compatibleChunkingVersion(options),
        embeddingLength: embedding.length
      } satisfies StoredVectorChunk)
    );

    for (const value of embedding) {
      embeddingsBuffer.writeFloatLE(value, byteOffset);
      byteOffset += 4;
    }
  }

  return {
    metadataText: metadataLines.length > 0 ? `${metadataLines.join("\n")}\n` : "",
    embeddingsBuffer,
    embeddingFloatCount
  };
}

async function cleanupNamespacePartitions(username: string, namespace: VectorNamespace, partitionCount: number): Promise<void> {
  const dir = vectorIndexDirForUser(username);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const partitionPattern = new RegExp(`^${namespace}\\.part-(\\d+)\\.(jsonl|f32)$`);
  const removals: Promise<void>[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(partitionPattern);
    if (match && (partitionCount === 1 || Number(match[1]) >= partitionCount)) {
      removals.push(fs.unlink(path.join(dir, entry.name)).catch(() => undefined));
    }
  }

  if (partitionCount > 1) {
    removals.push(fs.unlink(namespacePath(username, namespace, "jsonl")).catch(() => undefined));
    removals.push(fs.unlink(namespacePath(username, namespace, "f32")).catch(() => undefined));
  }

  await Promise.all(removals);
}

async function writeCompactNamespace(
  username: string,
  namespace: VectorNamespace,
  chunks: VectorChunk[],
  fileIndex?: FileIndexRecord[],
  options: VectorIndexCompatibility & { storageVersion?: number } = {},
  updatedAt = new Date().toISOString()
): Promise<void> {
  await fs.mkdir(vectorIndexDirForUser(username), { recursive: true });

  const manifestPath = namespacePath(username, namespace, "manifest.json");
  const filesPath = namespacePath(username, namespace, "files.json");
  const tmpSuffix = `${process.pid}.${Date.now()}.tmp`;
  const manifestTmpPath = `${manifestPath}.${tmpSuffix}`;
  const filesTmpPath = `${filesPath}.${tmpSuffix}`;
  const partitionCount = normalizePartitionCount(options.partitions);
  const partitionPayloads = splitIntoPartitions(chunks, partitionCount).map((partitionChunks) => serializeCompactPartition(partitionChunks, options));
  const embeddingFloatCount = partitionPayloads.reduce((total, payload) => total + payload.embeddingFloatCount, 0);

  const manifest: NamespaceManifest = {
    storageVersion: options.storageVersion ?? activeStorageVersion,
    format: "jsonl-float32",
    updatedAt,
    chunkCount: chunks.length,
    embeddingFloatCount,
    partitionCount,
    embeddingModel: options.embeddingModel,
    chunkingVersion: compatibleChunkingVersion(options)
  };
  const fileSnapshot: FileIndexSnapshot = {
    storageVersion: 1,
    updatedAt,
    files: (fileIndex?.length ? fileIndex : deriveFileIndexFromChunks(chunks, updatedAt)).sort((a, b) => a.path.localeCompare(b.path))
  };

  const partitionFiles = partitionPayloads.map((payload, index) => {
    const metadataPath = partitionCount === 1 ? namespacePath(username, namespace, "jsonl") : namespacePartitionPath(username, namespace, index, "jsonl");
    const embeddingsPath = partitionCount === 1 ? namespacePath(username, namespace, "f32") : namespacePartitionPath(username, namespace, index, "f32");
    return {
      payload,
      metadataPath,
      embeddingsPath,
      metadataTmpPath: `${metadataPath}.${tmpSuffix}`,
      embeddingsTmpPath: `${embeddingsPath}.${tmpSuffix}`
    };
  });

  for (const file of partitionFiles) {
    await fs.writeFile(file.metadataTmpPath, file.payload.metadataText);
    await fs.writeFile(file.embeddingsTmpPath, file.payload.embeddingsBuffer);
  }
  await fs.writeFile(manifestTmpPath, JSON.stringify(manifest));
  await fs.writeFile(filesTmpPath, JSON.stringify(fileSnapshot));
  for (const file of partitionFiles) {
    await fs.rename(file.metadataTmpPath, file.metadataPath);
    await fs.rename(file.embeddingsTmpPath, file.embeddingsPath);
  }
  await fs.rename(manifestTmpPath, manifestPath);
  await fs.rename(filesTmpPath, filesPath);
  await cleanupNamespacePartitions(username, namespace, partitionCount);
}

async function loadCompactNamespacePart(
  username: string,
  namespace: VectorNamespace,
  manifest: NamespaceManifest,
  partition?: number
): Promise<VectorChunk[]> {
  const metadataPath = partition === undefined ? namespacePath(username, namespace, "jsonl") : namespacePartitionPath(username, namespace, partition, "jsonl");
  const embeddingsPath = partition === undefined ? namespacePath(username, namespace, "f32") : namespacePartitionPath(username, namespace, partition, "f32");
  const [metadataText, embeddingsBuffer] = await Promise.all([
    fs.readFile(metadataPath, "utf8").catch(() => ""),
    fs.readFile(embeddingsPath).catch(() => Buffer.alloc(0))
  ]);
  const chunks: VectorChunk[] = [];
  let byteOffset = 0;

  for (const line of metadataText.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const item = JSON.parse(line) as StoredVectorChunk;
    const embedding: number[] = [];
    for (let index = 0; index < item.embeddingLength; index += 1) {
      embedding.push(byteOffset + 4 <= embeddingsBuffer.length ? embeddingsBuffer.readFloatLE(byteOffset) : 0);
      byteOffset += 4;
    }

    chunks.push({
      id: item.id,
      path: item.path,
      title: item.title,
      text: item.text,
      hash: item.hash,
      tags: Array.isArray(item.tags) ? item.tags : [],
      aliases: Array.isArray(item.aliases) ? item.aliases : [],
      heading: item.heading,
      contentHash: item.contentHash,
      mtimeMs: item.mtimeMs,
      embeddingModel: item.embeddingModel ?? manifest.embeddingModel,
      chunkingVersion: item.chunkingVersion ?? manifest.chunkingVersion,
      embedding
    });
  }

  return chunks;
}

async function loadCompactNamespace(username: string, namespace: VectorNamespace, options?: VectorIndexCompatibility): Promise<VectorChunk[] | null> {
  if (!(await pathExists(namespacePath(username, namespace, "manifest.json"))) && !(await pathExists(namespacePath(username, namespace, "jsonl")))) {
    return null;
  }

  const manifest = await readManifest(username, namespace);
  if (!manifest || !isCompatibleManifest(manifest, options)) {
    return null;
  }

  const partitionCount = normalizePartitionCount(manifest.partitionCount);
  if (partitionCount === 1) {
    return loadCompactNamespacePart(username, namespace, manifest);
  }

  const partitions = await Promise.all(
    Array.from({ length: partitionCount }, (_, partition) => loadCompactNamespacePart(username, namespace, manifest, partition))
  );
  return partitions.flat();
}

// Migrate any pre-multi-user data into the *first admin user's*
// hashed directory:
//   - the very old `vector-index.json` blob (if it still exists)
//   - the per-namespace files that used to live directly under
//     `data/vector-index/` (no user-keyed subdir)
// Idempotent: silently no-ops once the target dir exists.
async function ensureLegacyMigrated(): Promise<void> {
  if (migrationPromise) {
    return migrationPromise;
  }

  migrationPromise = (async () => {
    const data = await store.load();
    const admins = adminUsers(data);
    const adminTarget = admins[0];
    if (!adminTarget) {
      // No admin yet, nothing to migrate to.
      return;
    }

    // (a) very-old single JSON blob.
    const legacy = await loadLegacyIndex();
    if (legacy) {
      for (const [namespace, entry] of Object.entries(legacy.namespaces)) {
        if (namespace !== "test" && namespace !== "production") {
          continue;
        }
        await writeCompactNamespace(
          adminTarget.username,
          namespace,
          entry.chunks ?? [],
          undefined,
          { storageVersion: 2 },
          entry.updatedAt ?? new Date().toISOString()
        );
      }
      await fs.unlink(legacyIndexPath).catch(() => undefined);
    }

    // (b) per-namespace files at the top-level of indexDir
    // (pre-multi-user layout). Only move them if there's no
    // user-keyed subdir for the admin yet, so we don't clobber
    // a freshly indexed dataset.
    const targetDir = vectorIndexDirForUser(adminTarget.username);
    const targetExists = await pathExists(targetDir);
    if (targetExists) {
      return;
    }
    const entries = await fs.readdir(indexDir, { withFileTypes: true }).catch(() => []);
    const flatFiles = entries.filter((entry) => entry.isFile() && /^(test|production)\.(jsonl|f32|manifest\.json|files\.json)$/.test(entry.name));
    if (flatFiles.length > 0) {
      try {
        await fs.mkdir(targetDir, { recursive: true });
        for (const file of flatFiles) {
          const from = path.join(indexDir, file.name);
          const to = path.join(targetDir, file.name);
          await fs.rename(from, to);
        }
      } catch (error) {
        // Don't crash the whole boot just because we can't move
        // legacy files (often a leftover from running under a
        // different user). Log loudly so the operator can fix
        // permissions; the per-user code paths will still work
        // for newly indexed data.
        console.warn(
          `Could not migrate legacy vector-index files for user "${adminTarget.username}": ` +
            (error instanceof Error ? error.message : String(error))
        );
      }
    }
  })().finally(() => {
    migrationPromise = null;
  });

  return migrationPromise;
}

export async function replaceNamespace(
  username: string,
  namespace: VectorNamespace,
  chunks: VectorChunk[],
  fileIndex?: FileIndexRecord[],
  options?: VectorIndexCompatibility
): Promise<void> {
  await ensureLegacyMigrated();
  await writeCompactNamespace(username, namespace, chunks, fileIndex, options);
}

export async function getNamespaceChunks(username: string, namespace: VectorNamespace, options?: VectorIndexCompatibility): Promise<VectorChunk[]> {
  await ensureLegacyMigrated();
  return (await loadCompactNamespace(username, namespace, options)) ?? [];
}

export async function getNamespaceStats(
  username: string,
  namespace: VectorNamespace,
  options?: VectorIndexCompatibility
): Promise<{ updatedAt?: string; fileCount: number; chunkCount: number; hasIndex: boolean; stale?: boolean }> {
  await ensureLegacyMigrated();
  const manifest = await readManifest(username, namespace);
  if (manifest && !isCompatibleManifest(manifest, options)) {
    return {
      updatedAt: manifest.updatedAt,
      fileCount: 0,
      chunkCount: 0,
      hasIndex: false,
      stale: true
    };
  }

  const fileIndex = await getNamespaceFileIndex(username, namespace, options);
  if (manifest && isCompatibleManifest(manifest, options)) {
    const chunks = fileIndex.length > 0 ? null : await loadCompactNamespace(username, namespace, options);
    return {
      updatedAt: manifest.updatedAt,
      fileCount: fileIndex.length || new Set((chunks ?? []).map((chunk) => chunk.path)).size,
      chunkCount: manifest.chunkCount,
      hasIndex: manifest.chunkCount > 0
    };
  }

  const chunks = await loadCompactNamespace(username, namespace, options);
  return {
    fileCount: new Set((chunks ?? []).map((chunk) => chunk.path)).size,
    chunkCount: chunks?.length ?? 0,
    hasIndex: Boolean(chunks?.length)
  };
}

export async function getNamespaceFileIndex(username: string, namespace: VectorNamespace, options?: VectorIndexCompatibility): Promise<FileIndexRecord[]> {
  await ensureLegacyMigrated();
  if (!isCompatibleManifest(await readManifest(username, namespace), options)) {
    return [];
  }
  try {
    const snapshot = JSON.parse(await fs.readFile(namespacePath(username, namespace, "files.json"), "utf8")) as FileIndexSnapshot;
    return Array.isArray(snapshot.files) ? snapshot.files : [];
  } catch {
    return [];
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  const length = Math.min(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    aNorm += a[index] * a[index];
    bNorm += b[index] * b[index];
  }

  if (aNorm === 0 || bNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

export async function searchVectors(username: string, namespace: VectorNamespace, queryEmbedding: number[], topK: number, options?: VectorIndexCompatibility) {
  const chunks = await getNamespaceChunks(username, namespace, options);
  return chunks
    .filter((chunk) => chunk.embedding.length > 0)
    .map((chunk) => ({ ...chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
