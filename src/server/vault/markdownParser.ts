import matter from "gray-matter";

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  title: string;
  headings: string[];
  tags: string[];
  aliases: string[];
  links: string[];
}

function normalizeStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

export function parseMarkdown(content: string, fallbackName: string): ParsedMarkdown {
  const parsed = matter(content);
  const body = parsed.content;
  const headings = Array.from(body.matchAll(/^#{1,6}\s+(.+)$/gm)).map((match) => match[1].trim());
  const inlineTags = Array.from(body.matchAll(/(^|\s)#([\p{Letter}\p{Number}/_-]+)/gu)).map((match) => match[2]);
  const frontmatterTags = normalizeStringArray(parsed.data.tags).map((tag) => tag.replace(/^#/, ""));
  const aliases = normalizeStringArray(parsed.data.aliases ?? parsed.data.alias);
  const links = Array.from(body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)).map((match) => match[1].trim());
  const title =
    typeof parsed.data.title === "string"
      ? parsed.data.title
      : headings[0] ?? fallbackName.replace(/\.md$/i, "");

  return {
    frontmatter: parsed.data,
    title,
    headings,
    tags: Array.from(new Set([...inlineTags, ...frontmatterTags])),
    aliases,
    links: Array.from(new Set(links))
  };
}
