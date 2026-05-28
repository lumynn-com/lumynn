import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import hljs from "highlight.js";
import katex from "katex";
import { marked, type Token, type Tokens } from "marked";
import sanitizeHtml from "sanitize-html";
import { config } from "../config";
import { sha256 } from "../crypto";
import { backlinksWithObsidianCli, searchWithObsidianCli } from "../obsidian/obsidianCli";
import { store, type UserRecord } from "../store";
import type { DocumentContent, DocumentSearchResult, DocumentSummary, DocumentTreeEntry, SortField, SortOrder, VaultValidation } from "../../shared/types";
import { parseMarkdown } from "./markdownParser";

type ParsedMarkdown = ReturnType<typeof parseMarkdown>;

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

const VAULT_VALIDATION_TTL_MS = 30_000;
const VAULT_VALIDATION_FAILURE_TTL_MS = 3_000;
const vaultValidationCache = new Map<string, { validation: VaultValidation; resolvedPath: string; expiresAt: number }>();

function vaultValidationCacheKey(user: UserRecord, resolvedPath: string): string {
  return `${user.username}\0${resolvedPath}`;
}

function sameVaultValidation(a: VaultValidation | undefined, b: VaultValidation): boolean {
  if (!a) return false;
  return a.ok === b.ok &&
    a.exists === b.exists &&
    a.readable === b.readable &&
    a.writable === b.writable &&
    a.insideAllowedRoot === b.insideAllowedRoot &&
    a.hasObsidianConfig === b.hasObsidianConfig &&
    a.message === b.message;
}

export function invalidateVaultValidationCache(username?: string): void {
  if (!username) {
    vaultValidationCache.clear();
    return;
  }

  const prefix = `${username}\0`;
  for (const key of vaultValidationCache.keys()) {
    if (key.startsWith(prefix)) {
      vaultValidationCache.delete(key);
    }
  }
}

// Per-user: validate the user's configured vault path and return
// its absolute form. Persists the latest validation result on the
// user record so the Settings UI can show the current status. A
// missing/blank/invalid path throws; routes catch and 400 it.
async function ensureVault(user: UserRecord): Promise<string> {
  if (!user.vault.path?.trim()) {
    throw new Error("Vault path is not configured. Open Settings → Vault to set it.");
  }
  const resolvedPath = path.resolve(user.vault.path);
  const cacheKey = vaultValidationCacheKey(user, resolvedPath);
  const cached = vaultValidationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    user.vault.validation = cached.validation;
    if (!cached.validation.ok) {
      throw new Error(cached.validation.message);
    }
    return cached.resolvedPath;
  }

  const validation = await validateVaultPath(resolvedPath);
  const now = Date.now();
  vaultValidationCache.set(cacheKey, {
    validation,
    resolvedPath,
    expiresAt: now + (validation.ok ? VAULT_VALIDATION_TTL_MS : VAULT_VALIDATION_FAILURE_TTL_MS)
  });
  const validationChanged = !sameVaultValidation(user.vault.validation, validation);
  user.vault.validation = validation;
  if (validationChanged) {
    await store.save();
  }
  if (!validation.ok) {
    throw new Error(validation.message);
  }
  return resolvedPath;
}

function resolveInVault(vaultRoot: string, documentPath: string): string {
  const safePath = normalizeDocumentPath(documentPath);
  const fullPath = path.resolve(vaultRoot, safePath);
  if (!isInside(vaultRoot, fullPath)) {
    throw new Error("Document path escapes the vault");
  }
  return fullPath;
}

// Lightweight in-memory cache for directory listings. Per-folder
// because the tree is now lazy: each folder expansion makes its own
// /api/documents/tree?path=... call. Cache key includes path,
// depth, and sort spec so different views don't collide.
const TREE_CACHE_TTL_MS = 5_000;
const treeCache = new Map<string, { value: DocumentTreeEntry; expiresAt: number }>();

export type TreeSortField = "name" | "updatedAt";

export interface ListDocumentTreeOptions {
  /** Vault-relative folder path, "" for vault root. */
  folder?: string;
  /** How many levels of children to include. 1 = direct children
   *  only (default; lazy-loading friendly). Number.POSITIVE_INFINITY
   *  returns the entire subtree. */
  depth?: number;
  sort?: TreeSortField;
  order?: SortOrder;
}

export async function listDocumentTree(user: UserRecord, options: ListDocumentTreeOptions = {}): Promise<DocumentTreeEntry> {
  const vaultRoot = await ensureVault(user);
  await fs.mkdir(vaultRoot, { recursive: true });
  const folder = options.folder ?? "";
  const depth = options.depth ?? 1;
  const sort: TreeSortField = options.sort ?? "name";
  const order: SortOrder = options.order ?? "asc";
  const safeFolder = folder === "" ? "" : normalizeFolderPath(folder);

  // Cache key is keyed off the absolute vault root so two users
  // with different vault paths can never see each other's cached
  // tree, even by accident.
  const cacheKey = `${vaultRoot}|${safeFolder}|d=${depth}|s=${sort}|o=${order}`;
  const now = Date.now();
  const cached = treeCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const folderAbs = safeFolder ? path.resolve(vaultRoot, safeFolder) : vaultRoot;
  if (!isInside(vaultRoot, folderAbs)) {
    throw new Error("Folder path escapes the vault");
  }

  const node = await buildTreeNode(vaultRoot, folderAbs, safeFolder, depth, sort, order);
  treeCache.set(cacheKey, { value: node, expiresAt: now + TREE_CACHE_TTL_MS });
  return node;
}

function normalizeFolderPath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").some((part) => part === "..")) {
    throw new Error("Invalid folder path");
  }
  return normalized;
}

// Drop cached folder listings rooted at the given vault. Called
// after any write that could have changed structure (create,
// delete, rename). Only clears entries for *this* user's vault
// so other users keep their warm cache.
function invalidateTreeCache(vaultRoot: string): void {
  for (const key of treeCache.keys()) {
    if (key.startsWith(`${vaultRoot}|`)) {
      treeCache.delete(key);
    }
  }
}

async function folderHasContent(dir: string): Promise<boolean> {
  // Cheap check: is there any markdown file or any subfolder that
  // (recursively) has one? We need this so depth-limited folders
  // still know to show an expand caret. Walks until it finds one
  // .md file, then returns true; stops descending into hidden
  // folders.
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === ".obsidian" || entry.name.startsWith(".")) continue;
    if (entry.isFile() && entry.name.endsWith(".md")) return true;
  }
  for (const entry of entries) {
    if (entry.name === ".obsidian" || entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (await folderHasContent(path.join(dir, entry.name))) return true;
    }
  }
  return false;
}

async function buildTreeNode(
  vaultRoot: string,
  dir: string,
  relativePath: string,
  depth: number,
  sort: TreeSortField,
  order: SortOrder
): Promise<DocumentTreeEntry> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const childPromises = entries
    .filter((entry) => entry.name !== ".obsidian" && !entry.name.startsWith("."))
    .map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      const childRel = (relativePath ? `${relativePath}/${entry.name}` : entry.name).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (depth > 1) {
          const folder = await buildTreeNode(vaultRoot, fullPath, childRel, depth - 1, sort, order);
          // Drop empty folders so the tree doesn't show useless rows.
          return folder.children && folder.children.length > 0 ? folder : null;
        }
        // Depth-limited: skip recursion. Probe whether the folder
        // has any content so the client can show an expand caret
        // without forcing a deeper walk now.
        const hasChildren = await folderHasContent(fullPath);
        if (!hasChildren) return null;
        return {
          path: childRel,
          name: entry.name,
          type: "folder" as const,
          hasChildren: true
        } satisfies DocumentTreeEntry;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const file: DocumentTreeEntry = {
          path: childRel,
          name: entry.name,
          type: "file"
        };
        if (sort === "updatedAt") {
          const stat = await fs.stat(fullPath).catch(() => null);
          if (stat) file.updatedAt = stat.mtime.toISOString();
        }
        return file;
      }
      return null;
    });
  const settled = await Promise.all(childPromises);
  const children = settled.filter((child): child is DocumentTreeEntry => child !== null);

  const factor = order === "asc" ? 1 : -1;
  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    // Folders always alphabetical; only files honor the sort field.
    if (a.type === "folder") return a.name.localeCompare(b.name);
    if (sort === "updatedAt" && a.updatedAt && b.updatedAt) {
      const cmp = a.updatedAt.localeCompare(b.updatedAt);
      return cmp * factor;
    }
    return a.name.localeCompare(b.name) * factor;
  });

  return {
    path: relativePath ? relativePath.replaceAll("\\", "/") : "",
    name: relativePath ? path.basename(relativePath) : "",
    type: "folder",
    children
  };
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

interface SummaryResult {
  summary: DocumentSummary;
  metadataChanged: boolean;
}

function cachedSummary(user: UserRecord, documentPath: string, stat: Stats): SummaryResult | null {
  const name = path.basename(documentPath);
  const updatedAt = stat.mtime.toISOString();
  const cached = user.metadataByPath[documentPath];
  if (!cached || cached.updatedAt !== updatedAt) {
    return null;
  }

  const createdAt = user.createdAtByPath[documentPath] ?? cached.createdAt ?? stat.birthtime.toISOString();
  const metadataChanged = !user.createdAtByPath[documentPath];
  if (metadataChanged) {
    user.createdAtByPath[documentPath] = createdAt;
  }

  return {
    summary: {
      path: documentPath,
      name,
      title: cached.title,
      createdAt,
      updatedAt,
      hash: cached.hash,
      tags: cached.tags,
      aliases: cached.aliases,
      headings: cached.headings
    },
    metadataChanged
  };
}

function summarizeParsedContent(
  user: UserRecord,
  documentPath: string,
  stat: Stats,
  content: string,
  parsed: ParsedMarkdown
): SummaryResult {
  const name = path.basename(documentPath);
  const updatedAt = stat.mtime.toISOString();
  const createdAt = user.createdAtByPath[documentPath] ?? stat.birthtime.toISOString();
  user.createdAtByPath[documentPath] = createdAt;
  const hash = sha256(content);
  user.metadataByPath[documentPath] = {
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
    summary: {
      path: documentPath,
      name,
      title: parsed.title,
      createdAt,
      updatedAt,
      hash,
      tags: parsed.tags,
      aliases: parsed.aliases,
      headings: parsed.headings
    },
    metadataChanged: true
  };
}

async function summarize(user: UserRecord, vaultRoot: string, documentPath: string): Promise<SummaryResult> {
  const fullPath = resolveInVault(vaultRoot, documentPath);
  // Read mtime first so we can short-circuit on the cached metadata
  // without paying the cost of fs.readFile + parseMarkdown + sha256
  // for documents that haven't changed since we last summarized them.
  const stat = await fs.stat(fullPath);
  const cached = cachedSummary(user, documentPath, stat);
  if (cached) return cached;

  // Cache miss or stale: fall through to the full read + parse + hash.
  const content = await fs.readFile(fullPath, "utf8");
  const parsed = parseMarkdown(content, path.basename(documentPath));
  return summarizeParsedContent(user, documentPath, stat, content, parsed);
}

export async function listDocuments(user: UserRecord, sort: SortField = "name", order: SortOrder = "asc"): Promise<DocumentSummary[]> {
  const vaultRoot = await ensureVault(user);
  await fs.mkdir(vaultRoot, { recursive: true });
  const paths = await walkMarkdown(vaultRoot);

  const results = await Promise.all(paths.map((docPath) => summarize(user, vaultRoot, docPath)));
  if (results.some((result) => result.metadataChanged)) {
    await store.save();
  }
  const summaries = results.map((result) => result.summary);

  const factor = order === "asc" ? 1 : -1;
  return summaries.sort((a, b) => {
    const aValue = String(a[sort] ?? "").toLocaleLowerCase();
    const bValue = String(b[sort] ?? "").toLocaleLowerCase();
    const primary = aValue.localeCompare(bValue);
    return (primary || a.path.localeCompare(b.path)) * factor;
  });
}

export async function listDocumentFileStats(user: UserRecord, sort: SortField = "name", order: SortOrder = "asc"): Promise<DocumentFileStat[]> {
  const vaultRoot = await ensureVault(user);
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

export async function countDocuments(user: UserRecord): Promise<number> {
  const vaultRoot = await ensureVault(user);
  await fs.mkdir(vaultRoot, { recursive: true });
  return countMarkdownFiles(vaultRoot);
}

export async function resolveDocumentLink(user: UserRecord, target: string, basePath?: string): Promise<{ path: string }> {
  const vaultRoot = await ensureVault(user);
  const cleanTarget = target.split("#")[0].trim();
  if (!cleanTarget) {
    throw new Error("Invalid document link");
  }

  const exactPath = normalizeDocumentPath(cleanTarget);
  const exactFullPath = resolveInVault(vaultRoot, exactPath);
  if (await fs.stat(exactFullPath).then((stat) => stat.isFile()).catch(() => false)) {
    return { path: exactPath };
  }

  if (!cleanTarget.includes("/") && basePath) {
    const baseFolder = path.posix.dirname(normalizeDocumentPath(basePath));
    const relativePath = normalizeDocumentPath(baseFolder === "." ? cleanTarget : `${baseFolder}/${cleanTarget}`);
    const relativeFullPath = resolveInVault(vaultRoot, relativePath);
    if (await fs.stat(relativeFullPath).then((stat) => stat.isFile()).catch(() => false)) {
      return { path: relativePath };
    }
  }

  const paths = await walkMarkdown(vaultRoot);
  const exactLower = exactPath.toLocaleLowerCase();
  const caseInsensitiveExact = paths.find((documentPath) => documentPath.toLocaleLowerCase() === exactLower);
  if (caseInsensitiveExact) {
    return { path: caseInsensitiveExact };
  }

  if (cleanTarget.includes("/")) {
    throw new Error(`Document link not found: ${target}`);
  }

  const targetName = path.posix.basename(exactPath).toLocaleLowerCase();
  const match = paths.find((documentPath) => path.posix.basename(documentPath).toLocaleLowerCase() === targetName);
  if (!match) {
    throw new Error(`Document link not found: ${target}`);
  }
  return { path: match };
}

export async function readDocument(user: UserRecord, documentPath: string): Promise<DocumentContent> {
  const vaultRoot = await ensureVault(user);
  const safePath = normalizeDocumentPath(documentPath);
  const fullPath = resolveInVault(vaultRoot, safePath);
  const stat = await fs.stat(fullPath);
  const content = await fs.readFile(fullPath, "utf8");
  const parsed = parseMarkdown(content, path.basename(safePath));
  const result = cachedSummary(user, safePath, stat) ?? summarizeParsedContent(user, safePath, stat, content, parsed);
  if (result.metadataChanged) {
    await store.save();
  }
  return {
    ...result.summary,
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

export async function searchDocuments(user: UserRecord, query: string): Promise<DocumentSearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  const vaultRoot = await ensureVault(user);
  const documents = await listDocuments(user, "updatedAt", "desc");
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

export async function writeDocument(user: UserRecord, documentPath: string, content: string, expectedHash?: string): Promise<DocumentContent> {
  const vaultRoot = await ensureVault(user);
  const safePath = normalizeDocumentPath(documentPath);
  const fullPath = resolveInVault(vaultRoot, safePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });

  const existing = await fs.readFile(fullPath, "utf8").catch(() => null);
  if (existing !== null && expectedHash && sha256(existing) !== expectedHash) {
    const error = new Error("Document changed on disk. Reload before saving.");
    error.name = "ConflictError";
    throw error;
  }

  user.createdAtByPath[safePath] ??= new Date().toISOString();
  const tmpPath = `${fullPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, fullPath);
  await store.save();
  // The new file may add a new folder to the tree (subfolders created
  // by fs.mkdir above). Invalidate so the next /api/documents/tree
  // reflects it.
  if (existing === null) invalidateTreeCache(vaultRoot);
  return readDocument(user, safePath);
}

export async function createDocument(user: UserRecord, documentPath: string, content = ""): Promise<DocumentContent> {
  const vaultRoot = await ensureVault(user);
  const safePath = normalizeDocumentPath(documentPath);
  const fullPath = resolveInVault(vaultRoot, safePath);
  const exists = await fs.stat(fullPath).then(() => true).catch(() => false);
  if (exists) {
    throw new Error("Document already exists");
  }
  return writeDocument(user, safePath, content || `# ${path.basename(safePath, ".md")}\n`);
}

// Whitelist of image MIME types we accept for paste-into-editor uploads
// and the corresponding canonical extension we save with.
const ATTACHMENT_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "image/heif": "heif"
};

const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export interface WriteAttachmentResult {
  /** Vault-relative path to the new file, e.g. `attachments/2026-05-06-142510-a1b2.png`. */
  path: string;
}

// Persist a binary attachment (image) to <vault>/attachments/ with a
// time-sortable, collision-resistant filename. Returns the
// vault-relative path the caller should reference from Markdown.
export async function writeAttachment(user: UserRecord, params: {
  bytes: Buffer;
  mimeType: string;
  preferredName?: string;
}): Promise<WriteAttachmentResult> {
  const ext = ATTACHMENT_IMAGE_EXTENSIONS[params.mimeType.toLowerCase()];
  if (!ext) {
    throw new Error(`Unsupported attachment type: ${params.mimeType}`);
  }
  if (params.bytes.length === 0) {
    throw new Error("Attachment is empty");
  }
  if (params.bytes.length > ATTACHMENT_MAX_BYTES) {
    throw new Error(`Attachment is larger than ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB`);
  }

  const vaultRoot = await ensureVault(user);
  const folderRel = "attachments";
  const folderAbs = path.resolve(vaultRoot, folderRel);
  if (!isInside(vaultRoot, folderAbs)) {
    throw new Error("Attachment path escapes the vault");
  }
  await fs.mkdir(folderAbs, { recursive: true });

  const baseName = sanitizeAttachmentBase(params.preferredName) ?? formatAttachmentTimestamp(new Date());
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const suffix = attempt === 0 ? randomToken(4) : `${randomToken(4)}-${attempt}`;
    const fileName = `${baseName}-${suffix}.${ext}`;
    const fileAbs = path.resolve(folderAbs, fileName);
    if (!isInside(folderAbs, fileAbs)) continue;
    try {
      // wx = exclusive create; fails if the file already exists. This
      // closes the time-of-check / time-of-use race that a `stat`
      // followed by `writeFile` would have.
      await fs.writeFile(fileAbs, params.bytes, { flag: "wx" });
      return { path: `${folderRel}/${fileName}` };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not pick a unique attachment name");
}

function sanitizeAttachmentBase(input: string | undefined): string | null {
  if (!input) return null;
  const withoutExt = input.replace(/\.[a-z0-9]{1,6}$/i, "");
  const cleaned = withoutExt
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : null;
}

function formatAttachmentTimestamp(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function randomToken(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export async function deleteDocument(user: UserRecord, documentPath: string): Promise<void> {
  const vaultRoot = await ensureVault(user);
  const safePath = normalizeDocumentPath(documentPath);
  const fullPath = resolveInVault(vaultRoot, safePath);
  await fs.unlink(fullPath);
  delete user.createdAtByPath[safePath];
  delete user.metadataByPath[safePath];
  await store.save();
  invalidateTreeCache(vaultRoot);
}

// Rename / move a single Markdown file. The new path can either
// be in the same directory (pure rename) or in another directory
// (move + optionally rename). Per-user metadata caches keyed by
// the old path are migrated to the new key so RAG indexing and
// the tree's mtime cache stay correct.
export async function renameDocument(user: UserRecord, documentPath: string, nextPath: string): Promise<DocumentContent> {
  const vaultRoot = await ensureVault(user);
  const safePath = normalizeDocumentPath(documentPath);
  const safeNextPath = normalizeDocumentPath(nextPath);
  if (safePath === safeNextPath) {
    return readDocument(user, safePath);
  }

  const fullPath = resolveInVault(vaultRoot, safePath);
  const nextFullPath = resolveInVault(vaultRoot, safeNextPath);
  const exists = await fs.stat(nextFullPath).then(() => true).catch(() => false);
  if (exists) {
    throw new Error("A document already exists at the new path");
  }

  await fs.mkdir(path.dirname(nextFullPath), { recursive: true });
  await fs.rename(fullPath, nextFullPath);

  if (user.createdAtByPath[safePath]) {
    user.createdAtByPath[safeNextPath] = user.createdAtByPath[safePath];
    delete user.createdAtByPath[safePath];
  }
  if (user.metadataByPath[safePath]) {
    user.metadataByPath[safeNextPath] = {
      ...user.metadataByPath[safePath],
      path: safeNextPath,
      cachedAt: new Date().toISOString()
    };
    delete user.metadataByPath[safePath];
  }
  await store.save();
  invalidateTreeCache(vaultRoot);
  return readDocument(user, safeNextPath);
}

// --- Folder operations ---------------------------------------------
//
// We surface folders as first-class via three operations: create,
// rename/move, delete. Empty folders are tracked by a single
// `.gitkeep` placeholder file because the tree view enumerates
// directories from the filesystem; without a placeholder a brand
// new empty folder would vanish on the next refresh.

const FOLDER_PLACEHOLDER = ".gitkeep";

export interface CreateFolderResult {
  path: string;
}

export async function createFolder(user: UserRecord, folderPath: string): Promise<CreateFolderResult> {
  const vaultRoot = await ensureVault(user);
  const safeFolder = normalizeFolderPath(folderPath);
  const folderAbs = path.resolve(vaultRoot, safeFolder);
  if (!isInside(vaultRoot, folderAbs)) {
    throw new Error("Folder path escapes the vault");
  }
  // Reject if a *file* already exists at that path.
  const stat = await fs.stat(folderAbs).catch(() => null);
  if (stat && !stat.isDirectory()) {
    throw new Error("A file already exists at that path");
  }
  await fs.mkdir(folderAbs, { recursive: true });
  // Drop a hidden placeholder so the empty folder is visible in
  // the tree until the user puts a real .md inside.
  const placeholderAbs = path.resolve(folderAbs, FOLDER_PLACEHOLDER);
  await fs.writeFile(placeholderAbs, "", { flag: "a" }).catch(() => undefined);
  invalidateTreeCache(vaultRoot);
  return { path: safeFolder };
}

// Recursively count Markdown files in a folder (for the "you are
// about to delete N files" confirmation).
async function countMarkdownFiles(dir: string): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    if (entry.name === ".obsidian" || entry.name.startsWith(".")) continue;
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await countMarkdownFiles(child);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      total += 1;
    }
  }
  return total;
}

export interface FolderInspection {
  path: string;
  fileCount: number;
  exists: boolean;
}

export async function inspectFolder(user: UserRecord, folderPath: string): Promise<FolderInspection> {
  const vaultRoot = await ensureVault(user);
  const safeFolder = normalizeFolderPath(folderPath);
  const folderAbs = path.resolve(vaultRoot, safeFolder);
  if (!isInside(vaultRoot, folderAbs)) {
    throw new Error("Folder path escapes the vault");
  }
  const stat = await fs.stat(folderAbs).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    return { path: safeFolder, fileCount: 0, exists: false };
  }
  return {
    path: safeFolder,
    fileCount: await countMarkdownFiles(folderAbs),
    exists: true
  };
}

export async function deleteFolder(user: UserRecord, folderPath: string, options: { recursive?: boolean } = {}): Promise<{ deletedFiles: number }> {
  const vaultRoot = await ensureVault(user);
  const safeFolder = normalizeFolderPath(folderPath);
  if (!safeFolder) {
    throw new Error("Refusing to delete the vault root");
  }
  const folderAbs = path.resolve(vaultRoot, safeFolder);
  if (!isInside(vaultRoot, folderAbs)) {
    throw new Error("Folder path escapes the vault");
  }
  const stat = await fs.stat(folderAbs).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error("Folder not found");
  }
  const fileCount = await countMarkdownFiles(folderAbs);
  // Empty (only .gitkeep / hidden files) -> always allow.
  if (fileCount > 0 && !options.recursive) {
    const error: Error & { code?: string; details?: { fileCount: number } } = new Error(
      `Folder is not empty (${fileCount} file${fileCount === 1 ? "" : "s"}). Pass recursive=true to delete it anyway.`
    );
    error.name = "FolderNotEmpty";
    error.code = "FOLDER_NOT_EMPTY";
    error.details = { fileCount };
    throw error;
  }

  // Drop every per-user metadata cache entry that lived under the
  // deleted folder so RAG and the mtime cache don't keep stale
  // references.
  const prefix = `${safeFolder}/`;
  for (const key of Object.keys(user.metadataByPath)) {
    if (key === safeFolder || key.startsWith(prefix)) delete user.metadataByPath[key];
  }
  for (const key of Object.keys(user.createdAtByPath)) {
    if (key === safeFolder || key.startsWith(prefix)) delete user.createdAtByPath[key];
  }

  await fs.rm(folderAbs, { recursive: true, force: true });
  await store.save();
  invalidateTreeCache(vaultRoot);
  return { deletedFiles: fileCount };
}

// Rename / move a folder. Atomic at the filesystem level; we then
// rewrite every per-user metadata cache key whose path lived
// under the moved folder so RAG indexing and the mtime cache see
// the new location instead of the old.
export interface RenameFolderResult {
  path: string;
  movedFiles: number;
}

export async function renameFolder(user: UserRecord, folderPath: string, nextPath: string): Promise<RenameFolderResult> {
  const vaultRoot = await ensureVault(user);
  const safeFolder = normalizeFolderPath(folderPath);
  const safeNext = normalizeFolderPath(nextPath);
  if (!safeFolder) {
    throw new Error("Refusing to move the vault root");
  }
  if (safeFolder === safeNext) {
    return { path: safeFolder, movedFiles: 0 };
  }
  // Forbid moving a folder into itself or one of its descendants.
  if (safeNext === safeFolder || safeNext.startsWith(`${safeFolder}/`)) {
    throw new Error("Cannot move a folder into itself");
  }

  const fromAbs = path.resolve(vaultRoot, safeFolder);
  const toAbs = path.resolve(vaultRoot, safeNext);
  if (!isInside(vaultRoot, fromAbs) || !isInside(vaultRoot, toAbs)) {
    throw new Error("Folder path escapes the vault");
  }

  const fromStat = await fs.stat(fromAbs).catch(() => null);
  if (!fromStat || !fromStat.isDirectory()) {
    throw new Error("Source folder not found");
  }
  const toExists = await fs.stat(toAbs).then(() => true).catch(() => false);
  if (toExists) {
    throw new Error("A file or folder already exists at the destination");
  }

  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  await fs.rename(fromAbs, toAbs);

  // Rewrite all per-user cache keys that lived under the old
  // folder prefix.
  const oldPrefix = `${safeFolder}/`;
  const newPrefix = `${safeNext}/`;
  let movedFiles = 0;
  for (const oldKey of Object.keys(user.metadataByPath)) {
    if (!oldKey.startsWith(oldPrefix)) continue;
    const newKey = `${newPrefix}${oldKey.slice(oldPrefix.length)}`;
    user.metadataByPath[newKey] = {
      ...user.metadataByPath[oldKey],
      path: newKey,
      cachedAt: new Date().toISOString()
    };
    delete user.metadataByPath[oldKey];
    movedFiles += 1;
  }
  for (const oldKey of Object.keys(user.createdAtByPath)) {
    if (!oldKey.startsWith(oldPrefix)) continue;
    const newKey = `${newPrefix}${oldKey.slice(oldPrefix.length)}`;
    user.createdAtByPath[newKey] = user.createdAtByPath[oldKey];
    delete user.createdAtByPath[oldKey];
  }

  await store.save();
  invalidateTreeCache(vaultRoot);
  return { path: safeNext, movedFiles };
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
    .replace(/\[\[#([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, rawHeading: string, rawAlias: string | undefined) => {
      const heading = rawHeading.trim();
      const label = rawAlias?.trim() || heading;
      return `<a class="internal-link internal-heading-link" href="#" title="#${escapeHtml(heading)}">${escapeHtml(label)}</a>`;
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

// Strip a YAML frontmatter block (--- ... ---) from the very top of
// a Markdown document so it doesn't render as plain text inside the
// preview. We only match a block that starts on the first line and
// closes with a line that is exactly "---"; anything else (e.g. a
// horizontal rule mid-document) is left alone.
function stripFrontmatter(content: string): string {
  // Tolerate a UTF-8 BOM and any leading whitespace/newlines.
  const leadingMatch = content.match(/^\uFEFF?\s*/);
  const offset = leadingMatch ? leadingMatch[0].length : 0;
  if (!content.startsWith("---", offset)) return content;
  // The opening fence must be a line on its own: "---" optionally
  // followed by spaces, then a newline.
  const openMatch = content.slice(offset).match(/^---[ \t]*\r?\n/);
  if (!openMatch) return content;
  const startOfBody = offset + openMatch[0].length;
  // Find the closing fence (a line that is exactly --- or ...).
  const rest = content.slice(startOfBody);
  const closeMatch = rest.match(/\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) return content;
  const endOfFence = startOfBody + closeMatch.index + closeMatch[0].length;
  return content.slice(endOfFence).replace(/^\s*\r?\n/, "");
}

function prepareObsidianMarkdown(content: string, basePath?: string): string {
  const body = stripFrontmatter(content);
  const segments = body.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g);
  return segments
    .map((segment) => (/^(```|~~~|`)/.test(segment) ? segment : transformObsidianSyntaxSegment(segment, basePath)))
    .join("");
}

function orderedListItemValue(item: Tokens.ListItem): number | null {
  const match = item.raw.match(/^\s{0,3}(\d{1,9})[.)]\s/);
  return match ? Number(match[1]) : null;
}

const EMPTY_TASK_ITEM_REG = /^ {0,3}(?:[*+-]|\d{1,9}(?:\.|\)))\s+\[([ xX])\]\s*$/;

function normalizeEmptyPreviewTaskListItem(token: Token): void {
  if (token.type !== "list_item") return;

  const item = token as Tokens.ListItem;
  const checkedMarker = EMPTY_TASK_ITEM_REG.exec(item.raw)?.[1];
  if (checkedMarker === undefined) return;

  const checked = checkedMarker.toLowerCase() === "x";
  const checkbox: Tokens.Checkbox = {
    type: "checkbox",
    raw: checked ? "[x] " : "[ ] ",
    checked
  };

  item.task = true;
  item.checked = checked;
  item.text = "";
  item.tokens = item.loose
    ? [{ type: "paragraph", raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] }]
    : [checkbox];
}

function previewRenderer() {
  const renderer = new marked.Renderer();
  const defaultList = renderer.list.bind(renderer);

  renderer.list = function list(this: typeof renderer, token: Tokens.List): string {
    if (!token.ordered) return defaultList(token);

    const start = typeof token.start === "number" ? token.start : 1;
    const body = token.items
      .map((item) => {
        const rendered = this.listitem(item);
        const value = orderedListItemValue(item);
        if (value === null) return rendered;
        return rendered.replace(/^<li>/, `<li value="${value}">`);
      })
      .join("");

    return `<ol${start !== 1 ? ` start="${start}"` : ""}>\n${body}</ol>\n`;
  };

  renderer.code = function code(_token: Tokens.Code): string {
    const token = _token as Tokens.Code;
    const lang = (token.lang || "").trim().split(/\s+/)[0];
    let highlighted: string;
    if (lang && hljs.getLanguage(lang)) {
      highlighted = hljs.highlight(token.text, { language: lang }).value;
    } else {
      highlighted = hljs.highlightAuto(token.text).value;
    }
    const langClass = lang ? ` class="language-${lang}"` : "";
    return `<pre class="hljs"><code${langClass}>${highlighted}</code></pre>\n`;
  };

  return renderer;
}

export async function readVaultMedia(user: UserRecord, assetPath: string, basePath?: string): Promise<{ data: Buffer; contentType: string }> {
  const vaultRoot = await ensureVault(user);
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
  const html = await marked.parse(prepareObsidianMarkdown(content, basePath), {
    async: true,
    gfm: true,
    breaks: true,
    renderer: previewRenderer(),
    walkTokens: normalizeEmptyPreviewTaskListItem
  });
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2", "input", "mark"]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ["href", "name", "target", "title", "class"],
      input: ["checked", "disabled", "type"],
      ol: ["start", "type"],
      li: ["value"],
      pre: ["class"],
      code: ["class"],
      span: ["class", "style", "aria-hidden"],
      img: ["src", "alt", "title", "loading", "width", "height"],
      mark: ["class"]
    }
  });
}

export async function backlinksFor(user: UserRecord, documentPath: string): Promise<Array<{ source: string; title: string }>> {
  const vaultRoot = await ensureVault(user);
  const cliBacklinks = await backlinksWithObsidianCli(vaultRoot, normalizeDocumentPath(documentPath));
  if (cliBacklinks.length > 0) {
    return cliBacklinks.map((link) => ({ source: link.source, title: link.title ?? path.basename(link.source, ".md") }));
  }

  const targetBase = path.basename(normalizeDocumentPath(documentPath), ".md");
  const docs = await listDocuments(user, "path", "asc");
  const matches: Array<{ source: string; title: string }> = [];
  for (const doc of docs) {
    if (doc.path === documentPath) {
      continue;
    }
    const full = await readDocument(user, doc.path);
    if (full.links.some((link) => link === targetBase || link.endsWith(`/${targetBase}`))) {
      matches.push({ source: doc.path, title: doc.title });
    }
  }
  return matches;
}
