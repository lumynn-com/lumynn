const IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".gif", ".svg", ".webp"]);
const MEDIA_PATH = "/api/documents/media";
const MEDIA_ROUNDTRIP_FLAG = "owdEmbed";

function extensionOf(value: string): string {
  const clean = value.split("#")[0].split("?")[0].trim();
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot).toLowerCase() : "";
}

function isImagePath(value: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(value));
}

function basename(value: string): string {
  const clean = value.split("#")[0].split("?")[0].trim();
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return slash >= 0 ? clean.slice(slash + 1) : clean;
}

function escapeAlt(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function transformOutsideInlineCode(line: string, transform: (segment: string) => string): string {
  let out = "";
  let chunkStart = 0;
  let index = 0;

  while (index < line.length) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }

    let markerEnd = index + 1;
    while (markerEnd < line.length && line[markerEnd] === "`") markerEnd += 1;
    const marker = line.slice(index, markerEnd);
    const close = line.indexOf(marker, markerEnd);
    if (close === -1) {
      index = markerEnd;
      continue;
    }

    out += transform(line.slice(chunkStart, index));
    out += line.slice(index, close + marker.length);
    index = close + marker.length;
    chunkStart = index;
  }

  out += transform(line.slice(chunkStart));
  return out;
}

function transformOutsideCode(markdown: string, transform: (segment: string) => string): string {
  const parts = markdown.split(/(\r?\n)/);
  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;
  let result = "";

  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? "";
    const newline = parts[index + 1] ?? "";
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);

    if (fence) {
      const marker = fence[1];
      if (!inFence) {
        inFence = true;
        fenceChar = marker[0];
        fenceLength = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
        inFence = false;
        fenceChar = "";
        fenceLength = 0;
      }
      result += line + newline;
      continue;
    }

    result += (inFence ? line : transformOutsideInlineCode(line, transform)) + newline;
  }

  return result;
}

function mediaUrl(assetPath: string, documentPath?: string, meta?: string): string {
  const params = new URLSearchParams({ path: assetPath, [MEDIA_ROUNDTRIP_FLAG]: "1" });
  if (documentPath) params.set("base", documentPath);
  if (meta) params.set("owdMeta", meta);
  return `${MEDIA_PATH}?${params.toString()}`;
}

function parseMediaUrl(value: string): URL | null {
  try {
    const parsed = new URL(value, "http://owd.local");
    if (parsed.pathname !== MEDIA_PATH) return null;
    if (parsed.searchParams.get(MEDIA_ROUNDTRIP_FLAG) !== "1") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function obsidianToMuyaMarkdown(markdown: string, documentPath?: string): string {
  return transformOutsideCode(markdown, (segment) =>
    segment.replace(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (match, rawPath: string, rawMeta: string | undefined) => {
      const assetPath = rawPath.trim();
      if (!isImagePath(assetPath)) return match;
      const meta = rawMeta?.trim();
      const alt = meta && !/^\d+(?:x\d+)?$/i.test(meta) ? meta : basename(assetPath);
      return `![${escapeAlt(alt)}](${mediaUrl(assetPath, documentPath, meta)})`;
    })
  );
}

export function muyaToObsidianMarkdown(markdown: string): string {
  return transformOutsideCode(markdown, (segment) =>
    segment.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, _alt: string, rawSrc: string) => {
      const parsed = parseMediaUrl(rawSrc);
      if (!parsed) return match;
      const assetPath = parsed.searchParams.get("path");
      if (!assetPath || !isImagePath(assetPath)) return match;
      const meta = parsed.searchParams.get("owdMeta");
      return meta ? `![[${assetPath}|${meta}]]` : `![[${assetPath}]]`;
    })
  );
}
