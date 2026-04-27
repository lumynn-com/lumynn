import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { config } from "../config";
import { sha256 } from "../crypto";
import { store } from "../store";
import type { DocumentContent, DocumentSummary, SortField, SortOrder, VaultValidation } from "../../shared/types";
import { parseMarkdown } from "./markdownParser";

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

async function summarize(vaultRoot: string, documentPath: string): Promise<DocumentSummary> {
  const fullPath = resolveInVault(vaultRoot, documentPath);
  const content = await fs.readFile(fullPath, "utf8");
  const stat = await fs.stat(fullPath);
  const name = path.basename(documentPath);
  const parsed = parseMarkdown(content, name);
  const data = await store.load();
  const createdAt = data.createdAtByPath[documentPath] ?? stat.birthtime.toISOString();
  data.createdAtByPath[documentPath] = createdAt;

  return {
    path: documentPath,
    name,
    title: parsed.title,
    createdAt,
    updatedAt: stat.mtime.toISOString(),
    hash: sha256(content),
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
  await store.save();
}

export async function renderPreview(content: string): Promise<string> {
  const html = await marked.parse(content, { async: true });
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2"]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ["src", "alt", "title"]
    }
  });
}

export async function backlinksFor(documentPath: string): Promise<Array<{ source: string; title: string }>> {
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
