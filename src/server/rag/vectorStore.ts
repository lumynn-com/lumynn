import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config";

export type VectorNamespace = "test" | "production";

export interface VectorChunk {
  id: string;
  path: string;
  title: string;
  text: string;
  hash: string;
  tags?: string[];
  aliases?: string[];
  embedding: number[];
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
  embeddingLength: number;
}

interface NamespaceManifest {
  storageVersion: 2;
  format: "jsonl-float32";
  updatedAt: string;
  chunkCount: number;
  embeddingFloatCount: number;
}

const legacyIndexPath = path.join(config.dataDir, "vector-index.json");
const indexDir = path.join(config.dataDir, "vector-index");

let migrationPromise: Promise<void> | null = null;

function namespacePath(namespace: VectorNamespace, extension: "jsonl" | "f32" | "manifest.json"): string {
  return path.join(indexDir, `${namespace}.${extension}`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function baseTitle(title: string): string {
  return title.split(" > ")[0] || title;
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) {
    return text;
  }

  const match = text.match(/\n---(\r?\n|$)/);
  return match?.index === undefined ? text : text.slice(match.index + match[0].length);
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

function normalizeStoredText(title: string, text: string): string {
  const marker = "NOTE BLOCK CONTENT:\n\n";
  const markerIndex = text.indexOf(marker);
  const body = stripFrontmatter(markerIndex === -1 ? text : text.slice(markerIndex + marker.length)).trimStart();
  return `NOTE TITLE: [[${baseTitle(title)}]]\n\nNOTE BLOCK CONTENT:\n\n${body}`;
}

async function loadLegacyIndex(): Promise<VectorIndexFile | null> {
  try {
    return JSON.parse(await fs.readFile(legacyIndexPath, "utf8")) as VectorIndexFile;
  } catch {
    return null;
  }
}

async function readManifest(namespace: VectorNamespace): Promise<NamespaceManifest | null> {
  try {
    return JSON.parse(await fs.readFile(namespacePath(namespace, "manifest.json"), "utf8")) as NamespaceManifest;
  } catch {
    return null;
  }
}

async function writeCompactNamespace(namespace: VectorNamespace, chunks: VectorChunk[], updatedAt = new Date().toISOString()): Promise<void> {
  await fs.mkdir(indexDir, { recursive: true });

  const metadataPath = namespacePath(namespace, "jsonl");
  const embeddingsPath = namespacePath(namespace, "f32");
  const manifestPath = namespacePath(namespace, "manifest.json");
  const tmpSuffix = `${process.pid}.${Date.now()}.tmp`;
  const metadataTmpPath = `${metadataPath}.${tmpSuffix}`;
  const embeddingsTmpPath = `${embeddingsPath}.${tmpSuffix}`;
  const manifestTmpPath = `${manifestPath}.${tmpSuffix}`;
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
        text: normalizeStoredText(chunk.title, chunk.text),
        hash: chunk.hash,
        tags: chunk.tags?.length ? chunk.tags : legacyMetadata.tags,
        aliases: chunk.aliases?.length ? chunk.aliases : legacyMetadata.aliases,
        embeddingLength: embedding.length
      } satisfies StoredVectorChunk)
    );

    for (const value of embedding) {
      embeddingsBuffer.writeFloatLE(value, byteOffset);
      byteOffset += 4;
    }
  }

  const manifest: NamespaceManifest = {
    storageVersion: 2,
    format: "jsonl-float32",
    updatedAt,
    chunkCount: chunks.length,
    embeddingFloatCount
  };

  await fs.writeFile(metadataTmpPath, metadataLines.length > 0 ? `${metadataLines.join("\n")}\n` : "");
  await fs.writeFile(embeddingsTmpPath, embeddingsBuffer);
  await fs.writeFile(manifestTmpPath, JSON.stringify(manifest));
  await fs.rename(metadataTmpPath, metadataPath);
  await fs.rename(embeddingsTmpPath, embeddingsPath);
  await fs.rename(manifestTmpPath, manifestPath);
}

async function loadCompactNamespace(namespace: VectorNamespace): Promise<VectorChunk[] | null> {
  if (!(await pathExists(namespacePath(namespace, "manifest.json"))) && !(await pathExists(namespacePath(namespace, "jsonl")))) {
    return null;
  }

  const [metadataText, embeddingsBuffer] = await Promise.all([
    fs.readFile(namespacePath(namespace, "jsonl"), "utf8").catch(() => ""),
    fs.readFile(namespacePath(namespace, "f32")).catch(() => Buffer.alloc(0))
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
      embedding
    });
  }

  return chunks;
}

async function ensureLegacyMigrated(): Promise<void> {
  if (migrationPromise) {
    return migrationPromise;
  }

  migrationPromise = (async () => {
    const legacy = await loadLegacyIndex();
    if (!legacy) {
      return;
    }

    for (const [namespace, entry] of Object.entries(legacy.namespaces)) {
      if (namespace !== "test" && namespace !== "production") {
        continue;
      }
      await writeCompactNamespace(namespace, entry.chunks ?? [], entry.updatedAt ?? new Date().toISOString());
    }

    await fs.unlink(legacyIndexPath).catch(() => undefined);
  })().finally(() => {
    migrationPromise = null;
  });

  return migrationPromise;
}

export async function replaceNamespace(namespace: VectorNamespace, chunks: VectorChunk[]): Promise<void> {
  await ensureLegacyMigrated();
  await writeCompactNamespace(namespace, chunks);
}

export async function getNamespaceChunks(namespace: VectorNamespace): Promise<VectorChunk[]> {
  await ensureLegacyMigrated();
  return (await loadCompactNamespace(namespace)) ?? [];
}

export async function getNamespaceStats(namespace: VectorNamespace): Promise<{ updatedAt?: string; chunkCount: number }> {
  await ensureLegacyMigrated();
  const manifest = await readManifest(namespace);
  if (manifest) {
    return {
      updatedAt: manifest.updatedAt,
      chunkCount: manifest.chunkCount
    };
  }

  const chunks = await loadCompactNamespace(namespace);
  return {
    chunkCount: chunks?.length ?? 0
  };
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

export async function searchVectors(namespace: VectorNamespace, queryEmbedding: number[], topK: number) {
  const chunks = await getNamespaceChunks(namespace);
  return chunks
    .map((chunk) => ({ ...chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
