import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import katex from "katex";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { config } from "../config";
import { sha256 } from "../crypto";
import { backlinksWithObsidianCli, searchWithObsidianCli } from "../obsidian/obsidianCli";
import { store } from "../store";
import type { DocumentContent, DocumentSearchResult, DocumentSummary, SortField, SortOrder, VaultValidation } from "../../shared/types";
import { parseMarkdown } from "./markdownParser";

const supportedMediaTypes: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

export interface DocumentFileStat {
  path: string;
  name: string;
  updatedAt: string;
  mtimeMs: number;
  size: number;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeDocumentPath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").some((part) => part === "..")) {
    throw new Error("Invalid document path");
  }
  return normalized.endsWith(".md") ? normalized : `${normalized}.md`;
}

function normalizeVaultAssetPath(input: string): string {
  const withoutAnchor = input.split("#")[0].split("?")[0].trim();
  const normalized = withoutAnchor.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").some((part) => part === "..")) {
    throw new Error("Invalid asset path");
  }
  return normalized;
}

export async function validateVaultPath(vaultPath: string): Promise<VaultValidation> {
  const resolved = path.resolve(vaultPath);
  const allowedRoots = config.allowedVaultRoots.length > 0 ? config.allowedVaultRoots : [config.rootDir];
  const insideAllowedRoot = allowedRoots.some((root) => isInside(root, resolved));
  let exists = false;
  let readable = false;
  let writable = false;
  let isDirectory = false;
  let hasObsidianConfig = false;

  try {
    const stat = await fs.stat(resolved);
    exists = true;
    isDirectory = stat.isDirectory();
    await fs.access(resolved, fsConstants.R_OK);
    readable = true;
    await fs.access(resolved, fsConstants.W_OK);
    writable = true;
    hasObsidianConfig = await fs
      .stat(path.join(resolved, ".obsidian"))
      .then((entry) => entry.isDirectory())
      .catch(() => false);
  } catch {
    // The booleans above describe the failure.
  }

  const ok = exists && isDirectory && readable && writable && insideAllowedRoot;
  return {
    ok,
    exists,
    readable,
    writable,
    insideAllowedRoot,
    hasObsidianConfig,
    message: ok
      ? hasObsidianConfig
        ? "Valid Obsidian vault."
        : "Valid Markdown folder. Obsidian metadata was not found."
      : "Vault path must exist, be readable/writable, and stay inside ALLOWED_VAULT_ROOTS."
  };
}

async function ensureVault(): Promise<string> {
  const data = await store.load();
  const validation = await validateVaultPath(data.settings.vault.path);
  data.settings.vault.validation = validation;
  await store.save();
  if (!validation.ok) {
    throw new Error(validation.message);
  }
  return path.resolve(data.settings.vault.path);
}

function resolveInVault(vaultRoot: string, documentPath: string): string {
  const safePath = normalizeDocumentPath(documentPath);
  const fullPath = path.resolve(vaultRoot, safePath);
  if (!isInside(vaultRoot, fullPath)) {
    throw new Error("Document path escapes the vault");
  }
  return fullPath;
}

async function walkMarkdown(root: string, dir = root): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.name !== ".obsidian")
      .map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          return walkMarkdown(root, fullPath);
        }
        return entry.isFile() && entry.name.endsWith(".md") ? [path.relative(root, fullPath).replaceAll("\\", "/")] : [];
      })
  );
  return nested.flat();
}

async function walkFiles(root: string, dir = root): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.name !== ".obsidian")
      .map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          return walkFiles(root, fullPath);
        }
        return entry.isFile() ? [path.relative(root, fullPath).replaceAll("\\", "/")] : [];
      })
  );
  return nested.flat();
}

async function summarize(vaultRoot: string, documentPath: string): Promise<DocumentSummary> {
  const fullPath = resolveInVault(vaultRoot, documentPath);
  const content = await fs.readFile(fullPath, "utf8");
  const stat = await fs.stat(fullPath);
  const name = path.basename(documentPath);
  const parsed = parseMarkdown(content, name);
  const data = await store.load();
  const createdAt = data.createdAtByPath[documentPath] ?? stat.birthtime.toISOString();
  data.createdAtByPath[documentPath] = createdAt;
  const updatedAt = stat.mtime.toISOString();
  const hash = sha256(content);
  data.metadataByPath[documentPath] = {
    path: documentPath,
    title: parsed.title,
    frontmatter: parsed.frontmatter,
    headings: parsed.headings,
    tags: parsed.tags,
    aliases: parsed.aliases,
    links: parsed.links,
    hash,
    createdAt,
    updatedAt,
    cachedAt: new Date().toISOString()
  };

  return {
    path: documentPath,
    name,
    title: parsed.title,
    createdAt,
    updatedAt,
    hash,
    tags: parsed.tags,
    aliases: parsed.aliases,
    headings: parsed.headings
  };
}

export async function listDocuments(sort: SortField = "name", order: SortOrder = "asc"): Promise<DocumentSummary[]> {
  const vaultRoot = await ensureVault();
  await fs.mkdir(vaultRoot, { recursive: true });
  const paths = await walkMarkdown(vaultRoot);
  const summaries = await Promise.all(paths.map((docPath) => summarize(vaultRoot, docPath)));
  await store.save();

  const factor = order === "asc" ? 1 : -1;
  return summaries.sort((a, b) => {
    const aValue = String(a[sort] ?? "").toLocaleLowerCase();
    const bValue = String(b[sort] ?? "").toLocaleLowerCase();
    const primary = aValue.localeCompare(bValue);
    return (primary || a.path.localeCompare(b.path)) * factor;
  });
}

export async function listDocumentFileStats(sort: SortField = "name", order: SortOrder = "asc"): Promise<DocumentFileStat[]> {
  const vaultRoot = await ensureVault();
  await fs.mkdir(vaultRoot, { recursive: true });
  const paths = await walkMarkdown(vaultRoot);
  const stats = await Promise.all(
    paths.map(async (docPath) => {
      const stat = await fs.stat(resolveInVault(vaultRoot, docPath));
      return {
        path: docPath,
        name: path.basename(docPath),
        updatedAt: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
        size: stat.size
      } satisfies DocumentFileStat;
    })
  );

  const factor = order === "asc" ? 1 : -1;
  return stats.sort((a, b) => {
    const aValue = sort === "createdAt" ? "" : String(a[sort as keyof DocumentFileStat] ?? "").toLocaleLowerCase();
    const bValue = sort === "createdAt" ? "" : String(b[sort as keyof DocumentFileStat] ?? "").toLocaleLowerCase();
    const primary = aValue.localeCompare(bValue);
    return (primary || a.path.localeCompare(b.path)) * factor;
  });
}

export async function readDocument(documentPath: string): Promise<DocumentContent> {
  const vaultRoot = await ensureVault();
  const safePath = normalizeDocumentPath(documentPath);
  const fullPath = resolveInVault(vaultRoot, safePath);
  const content = await fs.readFile(fullPath, "utf8");
  const summary = await summarize(vaultRoot, safePath);
  const parsed = parseMarkdown(content, summary.name);
  await store.save();
  return {
    ...summary,
    content,
    frontmatter: parsed.frontmatter,
    links: parsed.links
  };
}

function normalizeCliSearchPath(line: string, vaultRoot: string, documents: DocumentSummary[]): string | null {
  const normalizedLine = line.trim().replaceAll("\\", "/");
  if (!normalizedLine) {
    return null;
  }

  const withoutVault = normalizedLine.startsWith(vaultRoot.replaceAll("\\", "/"))
    ? path.relative(vaultRoot, normalizedLine.split(/:(?:\d+:)?/)[0]).replaceAll("\\", "/")
    : normalizedLine;
  const candidates = [
    withoutVault,
    withoutVault.split(/:(?:\d+:)?/)[0],
    withoutVault.replace(/^["']|["']$/g, "")
  ].map((candidate) => candidate.replace(/^\/+/, ""));

  for (const candidate of candidates) {
    const normalized = candidate.endsWith(".md") ? candidate : `${candidate}.md`;
    const match = documents.find((doc) => doc.path === normalized || doc.path.endsWith(`/${normalized}`));
    if (match) {
      return match.path;
    }
  }

  const contained = documents.find((doc) => normalizedLine.includes(doc.path) || normalizedLine.includes(doc.name));
  return contained?.path ?? null;
}

function makeSnippet(content: string, query: string, fallback: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const offset = normalized.toLowerCase().indexOf(query.toLowerCase());
  if (offset === -1) {
    return fallback || normalized.slice(0, 180);
  }
  const start = Math.max(0, offset - 70);
  return `${start > 0 ? "..." : ""}${normalized.slice(start, offset + query.length + 120)}${offset + query.length + 120 < normalized.length ? "..." : ""}`;
}

export async function searchDocuments(query: string): Promise<DocumentSearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  const vaultRoot = await ensureVault();
  const documents = await listDocuments("updatedAt", "desc");
  const byPath = new Map(documents.map((doc) => [doc.path, doc]));
  const results = new Map<string, DocumentSearchResult>();
  const cliLines = await searchWithObsidianCli(vaultRoot, trimmedQuery);

  for (const line of cliLines) {
    const matchedPath = normalizeCliSearchPath(line, vaultRoot, documents);
    const doc = matchedPath ? byPath.get(matchedPath) : undefined;
    if (!doc || results.has(doc.path)) {
      continue;
    }
    results.set(doc.path, {
      path: doc.path,
      name: doc.name,
      title: doc.title,
      snippet: line,
      source: "obsidian-cli"
    });
  }

  if (results.size > 0) {
    return Array.from(results.values());
  }

  for (const doc of documents) {
    const content = await fs.readFile(resolveInVault(vaultRoot, doc.path), "utf8").catch(() => "");
    const haystack = `${doc.path}\n${doc.title}\n${doc.name}\n${doc.tags.join(" ")}\n${doc.aliases.join(" ")}\n${content}`.toLowerCase();
    if (!haystack.includes(trimmedQuery.toLowerCase())) {
      continue;
    }
    results.set(doc.path, {
      path: doc.path,
      name: doc.name,
      title: doc.title,
      snippet: makeSnippet(content, trimmedQuery, doc.headings[0] ?? doc.path),
      source: "filesystem"
    });
  }

  return Array.from(results.values()).slice(0, 100);
}

export async function writeDocument(documentPath: string, content: string, expectedHash?: string): Promise<DocumentContent> {
  const vaultRoot = await ensureVault();
  const safePath = normalizeDocumentPath(documentPath);
  const fullPath = resolveInVault(vaultRoot, safePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });

  const existing = await fs.readFile(fullPath, "utf8").catch(() => null);
  if (existing !== null && expectedHash && sha256(existing) !== expectedHash) {
    const error = new Error("Document changed on disk. Reload before saving.");
    error.name = "ConflictError";
    throw error;
  }

  const data = await store.load();
  data.createdAtByPath[safePath] ??= new Date().toISOString();
  const tmpPath = `${fullPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, fullPath);
  await store.save();
  return readDocument(safePath);
}

export async function createDocument(documentPath: string, content = ""): Promise<DocumentContent> {
  const vaultRoot = await ensureVault();
  const safePath = normalizeDocumentPath(documentPath);
  const fullPath = resolveInVault(vaultRoot, safePath);
  const exists = await fs.stat(fullPath).then(() => true).catch(() => false);
  if (exists) {
    throw new Error("Document already exists");
  }
  return writeDocument(safePath, content || `# ${path.basename(safePath, ".md")}\n`);
}

export async function deleteDocument(documentPath: string): Promise<void> {
  const vaultRoot = await ensureVault();
  const safePath = normalizeDocumentPath(documentPath);
  const fullPath = resolveInVault(vaultRoot, safePath);
  await fs.unlink(fullPath);
  const data = await store.load();
  delete data.createdAtByPath[safePath];
  delete data.metadataByPath[safePath];
  await store.save();
}

export async function renameDocument(documentPath: string, nextPath: string): Promise<DocumentContent> {
  const vaultRoot = await ensureVault();
  const safePath = normalizeDocumentPath(documentPath);
  const safeNextPath = normalizeDocumentPath(nextPath);
  if (safePath === safeNextPath) {
    return readDocument(safePath);
  }

  const fullPath = resolveInVault(vaultRoot, safePath);
  const nextFullPath = resolveInVault(vaultRoot, safeNextPath);
  const exists = await fs.stat(nextFullPath).then(() => true).catch(() => false);
  if (exists) {
    throw new Error("A document already exists at the new path");
  }

  await fs.mkdir(path.dirname(nextFullPath), { recursive: true });
  await fs.rename(fullPath, nextFullPath);

  const data = await store.load();
  if (data.createdAtByPath[safePath]) {
    data.createdAtByPath[safeNextPath] = data.createdAtByPath[safePath];
    delete data.createdAtByPath[safePath];
  }
  if (data.metadataByPath[safePath]) {
    data.metadataByPath[safeNextPath] = {
      ...data.metadataByPath[safePath],
      path: safeNextPath,
      cachedAt: new Date().toISOString()
    };
    delete data.metadataByPath[safePath];
  }
  await store.save();

  return readDocument(safeNextPath);
}

function mediaUrl(assetPath: string, basePath?: string): string {
  const params = new URLSearchParams({ path: assetPath });
  if (basePath) {
    params.set("base", basePath);
  }
  return `/api/documents/media?${params.toString()}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isImagePath(value: string): boolean {
  return Boolean(supportedMediaTypes[path.extname(value.split("#")[0].split("?")[0]).toLowerCase()]);
}

function parseObsidianEmbedMeta(rawMeta: string | undefined): { alt: string; width?: string; height?: string } {
  const meta = rawMeta?.trim() ?? "";
  if (!meta) {
    return { alt: "" };
  }
  const size = meta.match(/^(\d+)(?:x(\d+))?$/i);
  if (size) {
    return { alt: "", width: size[1], height: size[2] };
  }
  return { alt: meta };
}

function transformObsidianCallouts(input: string): string {
  return input
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^>\s*\[!([a-zA-Z0-9_-]+)\][+-]?\s*(.*)$/);
      if (!match) {
        return line;
      }
      const type = match[1].replace(/[-_]+/g, " ");
      const title = match[2]?.trim() || type;
      return `> **${type[0].toUpperCase()}${type.slice(1)}:** ${title}`;
    })
    .join("\n");
}

function renderMath(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex.trim(), {
    displayMode,
    output: "html",
    throwOnError: false,
    strict: "ignore"
  });
}

function transformObsidianMath(input: string): string {
  const withBlockMath = input.replace(/(^|[\r\n])\$\$([\s\S]*?)\$\$(?=$|[\r\n])/g, (_match, prefix: string, tex: string) => {
    return `${prefix}${renderMath(tex, true)}`;
  });

  return withBlockMath.replace(/(^|[^\\$])\$(?!\s|\$)([^\n$]+?)(?<!\s|\\)\$/g, (_match, prefix: string, tex: string) => {
    return `${prefix}${renderMath(tex, false)}`;
  });
}

function transformObsidianSyntaxSegment(input: string, basePath?: string): string {
  const withoutComments = input.replace(/%%[\s\S]*?%%/g, "");
  const withMath = transformObsidianMath(withoutComments);
  const withCallouts = transformObsidianCallouts(withMath);
  const withObsidianEmbeds = withCallouts.replace(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_match, rawPath: string, rawMeta: string | undefined) => {
    const assetPath = rawPath.trim();
    if (!isImagePath(assetPath)) {
      return `<a class="internal-link internal-embed" href="#" title="${escapeHtml(assetPath)}">${escapeHtml(path.basename(assetPath))}</a>`;
    }
    const meta = parseObsidianEmbedMeta(rawMeta);
    const alt = meta.alt || path.basename(assetPath);
    const sizeAttributes = `${meta.width ? ` width="${escapeHtml(meta.width)}"` : ""}${meta.height ? ` height="${escapeHtml(meta.height)}"` : ""}`;
    return `<img src="${escapeHtml(mediaUrl(assetPath, basePath))}" alt="${escapeHtml(alt)}"${sizeAttributes} />`;
  });

  return withObsidianEmbeds
    .replace(/!\[([^\]]*)\]\((?!https?:\/\/|data:|\/)([^)\s]+)(?:\s+"[^"]*")?\)/gi, (_match, rawAlt: string, rawPath: string) => {
      return `![${rawAlt}](${mediaUrl(rawPath, basePath)})`;
    })
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_match, rawTarget: string, rawAlias: string | undefined) => {
      const target = rawTarget.trim();
      const label = rawAlias?.trim() || path.basename(target, ".md") || target;
      return `<a class="internal-link" href="#" title="${escapeHtml(target)}">${escapeHtml(label)}</a>`;
    })
    .replace(/(^|[^=])==([^=\n][\s\S]*?[^=\n])==(?=[^=]|$)/g, (_match, prefix: string, text: string) => {
      return `${prefix}<mark>${escapeHtml(text)}</mark>`;
    });
}

function prepareObsidianMarkdown(content: string, basePath?: string): string {
  const segments = content.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g);
  return segments
    .map((segment) => (/^(```|~~~|`)/.test(segment) ? segment : transformObsidianSyntaxSegment(segment, basePath)))
    .join("");
}

export async function readVaultMedia(assetPath: string, basePath?: string): Promise<{ data: Buffer; contentType: string }> {
  const vaultRoot = await ensureVault();
  const safeAssetPath = normalizeVaultAssetPath(assetPath);
  const extension = path.extname(safeAssetPath).toLowerCase();
  const contentType = supportedMediaTypes[extension];
  if (!contentType) {
    throw new Error("Unsupported media type");
  }

  const candidates = new Set<string>();
  if (basePath) {
    const safeBasePath = normalizeDocumentPath(basePath);
    candidates.add(path.posix.normalize(path.posix.join(path.posix.dirname(safeBasePath), safeAssetPath)));
  }
  candidates.add(safeAssetPath);

  for (const candidate of candidates) {
    const fullPath = path.resolve(vaultRoot, candidate);
    if (!isInside(vaultRoot, fullPath)) {
      continue;
    }
    const data = await fs.readFile(fullPath).catch(() => null);
    if (data) {
      return { data, contentType };
    }
  }

  const basename = path.basename(safeAssetPath).toLowerCase();
  const files = await walkFiles(vaultRoot);
  const match = files.find((file) => path.basename(file).toLowerCase() === basename && supportedMediaTypes[path.extname(file).toLowerCase()]);
  if (!match) {
    throw new Error("Media not found");
  }

  const fullPath = path.resolve(vaultRoot, match);
  return {
    data: await fs.readFile(fullPath),
    contentType
  };
}

export async function renderPreview(content: string, basePath?: string): Promise<string> {
  const html = await marked.parse(prepareObsidianMarkdown(content, basePath), { async: true, gfm: true, breaks: true });
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2", "input", "mark"]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ["href", "name", "target", "title", "class"],
      input: ["checked", "disabled", "type"],
      span: ["class", "style", "aria-hidden"],
      img: ["src", "alt", "title", "loading", "width", "height"],
      mark: ["class"]
    }
  });
}

export async function backlinksFor(documentPath: string): Promise<Array<{ source: string; title: string }>> {
  const vaultRoot = await ensureVault();
  const cliBacklinks = await backlinksWithObsidianCli(vaultRoot, normalizeDocumentPath(documentPath));
  if (cliBacklinks.length > 0) {
    return cliBacklinks.map((link) => ({ source: link.source, title: link.title ?? path.basename(link.source, ".md") }));
  }

  const targetBase = path.basename(normalizeDocumentPath(documentPath), ".md");
  const docs = await listDocuments("path", "asc");
  const matches: Array<{ source: string; title: string }> = [];
  for (const doc of docs) {
    if (doc.path === documentPath) {
      continue;
    }
    const full = await readDocument(doc.path);
    if (full.links.some((link) => link === targetBase || link.endsWith(`/${targetBase}`))) {
      matches.push({ source: doc.path, title: doc.title });
    }
  }
  return matches;
}
