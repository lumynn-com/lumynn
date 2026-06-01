import crypto from "node:crypto";

export const RAG_CHUNKING_VERSION = 3;

export interface MarkdownChunk {
  index: number;
  id?: string;
  heading?: string;
  text: string;
  contentHash?: string;
  mtimeMs?: number;
}

export interface ChunkMarkdownOptions {
  path?: string;
  title?: string;
  mtimeMs?: number;
}

const maxEmbeddingTextChars = 1800;
const maxMetadataValueChars = 500;
const splitSeparators = ["\n\n", "\n", ". ", " ", ""];

function compactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > maxMetadataValueChars ? `${value.slice(0, maxMetadataValueChars)}...` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(compactValue);
  }
  if (value && typeof value === "object") {
    return compactFrontmatter(value as Record<string, unknown>);
  }
  return value;
}

function compactFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter).slice(0, 30)) {
    compact[key] = compactValue(value);
  }
  return compact;
}

function normalizeMarkdown(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

export function stripMarkdownFrontmatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }

  const closingMatch = content.match(/\n---(\r?\n|$)/);
  if (!closingMatch || closingMatch.index === undefined) {
    return content;
  }

  return content.slice(closingMatch.index + closingMatch[0].length);
}

function chunkHeaderLength(title: string): number {
  return `\n\nNOTE TITLE: [[${title}]]\n\nNOTE BLOCK CONTENT:\n\n`.length;
}

function chunkId(pathName: string | undefined, index: number): string | undefined {
  return pathName ? `${pathName}#${index}` : undefined;
}

function contentHash(content: string): string {
  const sample = content.slice(0, 64);
  return crypto.createHash("sha256").update(`${content.length}:${sample}`).digest("hex").slice(0, 16);
}

function findSplitEnd(text: string, start: number, maxChars: number): number {
  const hardEnd = Math.min(text.length, start + maxChars);
  if (hardEnd >= text.length) {
    return text.length;
  }

  const window = text.slice(start, hardEnd);
  const minimumUsefulBreak = Math.floor(maxChars * 0.35);

  for (const separator of splitSeparators) {
    if (!separator) {
      break;
    }
    const offset = window.lastIndexOf(separator);
    if (offset >= minimumUsefulBreak) {
      return start + offset + separator.length;
    }
  }

  return hardEnd;
}

export function chunkText(text: string, size: number, overlap: number): string[] {
  const normalized = normalizeMarkdown(text);
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  const maxChars = Math.max(1, size);
  const overlapChars = Math.max(0, Math.min(overlap, maxChars - 1));
  let index = 0;

  while (index < normalized.length) {
    const end = findSplitEnd(normalized, index, maxChars);
    const chunk = normalized.slice(index, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= normalized.length) {
      break;
    }
    index = Math.max(index + 1, end - overlapChars);
  }

  return chunks;
}

function stripSyntheticHeader(content: string, title: string): string {
  const header = `\n\nNOTE TITLE: [[${title}]]\n\nNOTE BLOCK CONTENT:\n\n`;
  return content.startsWith(header) ? content.slice(header.length) : content;
}

function isTinyStructuralChunk(chunk: string, title: string): boolean {
  const body = stripSyntheticHeader(chunk, title).trim();
  if (!body) {
    return true;
  }

  const nonEmptyLines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return nonEmptyLines.length === 1 && /^#{1,6}\s+\S+/.test(nonEmptyLines[0]);
}

function mergeChunkText(first: string, second: string): string {
  const left = first.replace(/\s+$/, "");
  const right = second.replace(/^\s+/, "");
  return left && right ? `${left}\n\n${right}` : `${left}${right}`;
}

function coalesceTinySplitChunks(chunks: string[], title: string, maxChars: number): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  const merged = [...chunks];
  let index = 0;

  while (index < merged.length - 1) {
    if (isTinyStructuralChunk(merged[index], title)) {
      const candidate = mergeChunkText(merged[index], merged[index + 1]);
      if (candidate.length + chunkHeaderLength(title) <= maxChars) {
        merged.splice(index, 2, candidate);
        continue;
      }
    }
    index += 1;
  }

  if (merged.length > 1) {
    const lastIndex = merged.length - 1;
    if (isTinyStructuralChunk(merged[lastIndex], title)) {
      const candidate = mergeChunkText(merged[lastIndex - 1], merged[lastIndex]);
      if (candidate.length + chunkHeaderLength(title) <= maxChars) {
        merged.splice(lastIndex - 1, 2, candidate);
      }
    }
  }

  return merged;
}

function processSection(sectionText: string, heading: string | undefined, size: number, overlap: number, options: ChunkMarkdownOptions, startIndex: number): MarkdownChunk[] {
  const title = options.title ?? "Untitled";
  const maxBodyChars = Math.max(1, size - chunkHeaderLength(title));
  const normalized = normalizeMarkdown(sectionText);
  if (!normalized) {
    return [];
  }

  const bodies =
    normalized.length + chunkHeaderLength(title) <= size
      ? [normalized]
      : coalesceTinySplitChunks(chunkText(normalized, maxBodyChars, overlap), title, size);

  return bodies.map((body, localIndex) => {
    const index = startIndex + localIndex;
    return {
      index,
      id: chunkId(options.path, index),
      heading,
      text: body,
      contentHash: contentHash(body),
      mtimeMs: options.mtimeMs
    };
  });
}

// Behavior adapted from logancyang/obsidian-copilot
// src/search/v3/chunks.ts (AGPL-3.0):
// heading-first chunks, whole-note preservation for small notes,
// and deterministic section splitting for oversized sections.
export function chunkMarkdownByHeading(content: string, size: number, overlap: number, options: ChunkMarkdownOptions = {}): MarkdownChunk[] {
  const body = normalizeMarkdown(stripMarkdownFrontmatter(content));
  if (!body) {
    return [];
  }

  const title = options.title ?? "Untitled";
  const headingMatches = Array.from(body.matchAll(/^#{1,6}\s+(.+)$/gm));
  const firstHeading = headingMatches[0]?.[1]?.trim();

  if (body.length + chunkHeaderLength(title) <= size) {
    return processSection(body, firstHeading, size, overlap, options, 0);
  }

  if (headingMatches.length === 0) {
    return processSection(body, undefined, size, overlap, options, 0);
  }

  const chunks: MarkdownChunk[] = [];
  for (let index = 0; index < headingMatches.length; index += 1) {
    const heading = headingMatches[index];
    const nextHeading = headingMatches[index + 1];
    const start = index === 0 ? 0 : heading.index ?? 0;
    const end = nextHeading?.index ?? body.length;
    const sectionText = body.slice(start, end);
    const processed = processSection(sectionText, heading[1].trim(), size, overlap, options, chunks.length);
    chunks.push(...processed);
  }

  return chunks;
}

export function formatChunkForContext(input: { title: string; path?: string; heading?: string; text: string }): string {
  const pathLine = input.path ? `\nNOTE PATH: ${input.path}` : "";
  const headingLine = input.heading ? `\nHEADING: ${input.heading}` : "";
  return `NOTE TITLE: [[${input.title}]]${pathLine}${headingLine}\n\nNOTE BLOCK CONTENT:\n\n${stripMarkdownFrontmatter(input.text).trimStart()}`;
}

export function formatChunkForEmbedding(input: {
  title: string;
  path: string;
  tags: string[];
  aliases: string[];
  frontmatter: Record<string, unknown>;
  heading?: string;
  text: string;
}): string {
  const metadata = {
    path: input.path,
    title: input.title,
    heading: input.heading,
    tags: input.tags,
    aliases: input.aliases,
    frontmatter: compactFrontmatter(input.frontmatter)
  };

  const prefix = [
    `NOTE TITLE: [[${input.title}]]`,
    `NOTE PATH: ${input.path}`,
    `METADATA: ${JSON.stringify(metadata)}`,
    "",
    "NOTE BLOCK CONTENT:",
    ""
  ].join("\n");
  const remaining = Math.max(500, maxEmbeddingTextChars - prefix.length);
  return `${prefix}\n${stripMarkdownFrontmatter(input.text).trimStart().slice(0, remaining)}`;
}
