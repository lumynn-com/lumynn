export interface MarkdownChunk {
  index: number;
  heading?: string;
  text: string;
}

const maxEmbeddingTextChars = 1800;
const maxMetadataValueChars = 500;

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

export function chunkText(text: string, size: number, overlap: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  let index = 0;
  while (index < normalized.length) {
    const chunk = normalized.slice(index, index + size).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    index += Math.max(1, size - overlap);
  }
  return chunks;
}

export function chunkMarkdownByHeading(content: string, size: number, overlap: number): MarkdownChunk[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const sections: Array<{ heading?: string; text: string }> = [];
  const matches = Array.from(normalized.matchAll(/^#{1,6}\s+(.+)$/gm));

  if (matches.length === 0) {
    sections.push({ text: normalized });
  } else {
    const firstHeadingIndex = matches[0].index ?? 0;
    if (firstHeadingIndex > 0) {
      sections.push({ text: normalized.slice(0, firstHeadingIndex).trim() });
    }

    matches.forEach((match, index) => {
      const start = match.index ?? 0;
      const end = index + 1 < matches.length ? matches[index + 1].index ?? normalized.length : normalized.length;
      sections.push({
        heading: match[1].trim(),
        text: normalized.slice(start, end).trim()
      });
    });
  }

  const chunks: MarkdownChunk[] = [];
  for (const section of sections) {
    for (const text of chunkText(section.text, size, overlap)) {
      chunks.push({
        index: chunks.length,
        heading: section.heading,
        text
      });
    }
  }
  return chunks;
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
  return `${prefix}\n${input.text.slice(0, remaining)}`;
}
