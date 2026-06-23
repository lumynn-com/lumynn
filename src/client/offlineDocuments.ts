import type { DocumentContent, DocumentSearchResult, DocumentTreeEntry, SortField, SortOrder } from "../shared/types";
import { marked, type Tokens } from "marked";
import { api, isHttpError, isNetworkError } from "./api";

const DB_NAME = "lumynn-offline";
const DB_VERSION = 2;
const DOCS_STORE = "documents";
const FOLDERS_STORE = "folders";
const OPS_STORE = "operations";
const PINS_STORE = "offlinePins";
const META_STORE = "metadata";
const OFFLINE_EVENT = "lumynn:offline-state";
const OFFLINE_CACHE_EVENT = "lumynn:offline-cache";
const MEDIA_CACHE_PREFIX = "owd-v6-media-";
const MEDIA_PATH = "/api/documents/media";
const LOCAL_MEDIA_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".svg",
  ".webp"
]);

type OperationStatus = "pending" | "conflict";
export type OfflinePinKind = "document" | "folder";

export interface OfflinePinRecord {
  key: string;
  username: string;
  kind: OfflinePinKind;
  path: string;
  createdAt: string;
  cachedAt?: string;
  lastError?: string;
}

export interface OfflineCacheProgress {
  running: boolean;
  currentPath?: string;
  done: number;
  total?: number;
  lastError?: string;
}

export interface OfflineCacheStatus {
  fullLibrary: boolean;
  fullLibraryCachedAt?: string;
  pinned: OfflinePinRecord[];
  progress: OfflineCacheProgress;
  cachedDocumentCount: number;
  cachedFolderCount: number;
}

type OfflineOperation =
  | {
      id: string;
      username: string;
      type: "createDocument";
      createdAt: string;
      status: OperationStatus;
      payload: { path: string; content: string };
      lastError?: string;
    }
  | {
      id: string;
      username: string;
      type: "updateDocument";
      createdAt: string;
      status: OperationStatus;
      payload: { path: string; content: string; expectedHash?: string };
      lastError?: string;
    }
  | {
      id: string;
      username: string;
      type: "deleteDocument";
      createdAt: string;
      status: OperationStatus;
      payload: { path: string };
      lastError?: string;
    }
  | {
      id: string;
      username: string;
      type: "renameDocument";
      createdAt: string;
      status: OperationStatus;
      payload: { path: string; nextPath: string };
      lastError?: string;
    }
  | {
      id: string;
      username: string;
      type: "createFolder";
      createdAt: string;
      status: OperationStatus;
      payload: { path: string };
      lastError?: string;
    }
  | {
      id: string;
      username: string;
      type: "renameFolder";
      createdAt: string;
      status: OperationStatus;
      payload: { path: string; nextPath: string };
      lastError?: string;
    }
  | {
      id: string;
      username: string;
      type: "deleteFolder";
      createdAt: string;
      status: OperationStatus;
      payload: { path: string; recursive: boolean };
      lastError?: string;
    };

interface OfflineDocumentRecord {
  key: string;
  username: string;
  path: string;
  document: DocumentContent;
  cachedAt: string;
  dirty?: boolean;
  deleted?: boolean;
  previewHtml?: string;
  previewDraft?: string;
}

interface OfflineFolderRecord {
  key: string;
  username: string;
  path: string;
  children: DocumentTreeEntry[];
  cachedAt: string;
}

interface OfflineMetadataRecord<T = unknown> {
  key: string;
  username: string;
  name: string;
  value: T;
  updatedAt: string;
}

interface FullLibraryOfflineMeta {
  enabled: boolean;
  cachedAt?: string;
}

export interface OfflineWorkspaceState {
  isOnline: boolean;
  syncing: boolean;
  pendingCount: number;
  conflictCount: number;
  lastError?: string;
}

const syncingUsers = new Set<string>();
const warmingUsers = new Map<string, OfflineCacheProgress>();
let dbPromise: Promise<IDBDatabase> | null = null;

function canUseIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  if (!canUseIndexedDb()) {
    return Promise.reject(new Error("Offline storage is unavailable in this browser."));
  }
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Unable to open offline storage."));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DOCS_STORE)) {
        const store = db.createObjectStore(DOCS_STORE, { keyPath: "key" });
        store.createIndex("username", "username", { unique: false });
      }
      if (!db.objectStoreNames.contains(FOLDERS_STORE)) {
        const store = db.createObjectStore(FOLDERS_STORE, { keyPath: "key" });
        store.createIndex("username", "username", { unique: false });
      }
      if (!db.objectStoreNames.contains(OPS_STORE)) {
        const store = db.createObjectStore(OPS_STORE, { keyPath: "id" });
        store.createIndex("username", "username", { unique: false });
      }
      if (!db.objectStoreNames.contains(PINS_STORE)) {
        const store = db.createObjectStore(PINS_STORE, { keyPath: "key" });
        store.createIndex("username", "username", { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        const store = db.createObjectStore(META_STORE, { keyPath: "key" });
        store.createIndex("username", "username", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
  return dbPromise;
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Offline storage request failed."));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Offline storage transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("Offline storage transaction aborted."));
  });
}

function keyFor(username: string, path: string): string {
  return `${username}\n${path}`;
}

function pinKeyFor(username: string, kind: OfflinePinKind, path: string): string {
  return `${username}\n${kind}\n${path}`;
}

function metaKeyFor(username: string, name: string): string {
  return `${username}\n${name}`;
}

function newOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function basename(path: string): string {
  const clean = path.replace(/\/+$/g, "");
  const slash = clean.lastIndexOf("/");
  return slash >= 0 ? clean.slice(slash + 1) : clean;
}

function extensionOfMediaTarget(value: string): string {
  const clean = value.split("#")[0].split("?")[0].trim();
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  const name = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function isLocalMediaTarget(value: string): boolean {
  const target = value.trim();
  if (!target || target.startsWith("#") || target.startsWith("//")) return false;
  if (target.startsWith("data:") || target.startsWith("/api/")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  return LOCAL_MEDIA_EXTENSIONS.has(extensionOfMediaTarget(target));
}

function documentMediaUrl(assetPath: string, basePath?: string): string {
  const params = new URLSearchParams({ path: assetPath });
  if (basePath) params.set("base", basePath);
  return `${MEDIA_PATH}?${params.toString()}`;
}

function transformOutsideMarkdownCode(input: string, transform: (value: string) => string): string {
  const protectedSegments: string[] = [];
  const protect = (segment: string) => {
    const token = `@@LUMYNN_OFFLINE_CODE_${protectedSegments.length}@@`;
    protectedSegments.push(segment);
    return token;
  };
  const protectedInput = input
    .replace(/(^|\r?\n)(`{3,}|~{3,})[^\r\n]*(?:\r?\n[\s\S]*?)(?:\r?\n\2)(?=$|\r?\n)/g, (match) => protect(match))
    .replace(/(`+)([^`\r\n]*?)\1/g, (match) => protect(match));
  return transform(protectedInput).replace(/@@LUMYNN_OFFLINE_CODE_(\d+)@@/g, (_match, index: string) => protectedSegments[Number(index)] ?? "");
}

export function listLocalMediaUrlsForDocument(content: string, documentPath: string): string[] {
  const urls = new Set<string>();
  transformOutsideMarkdownCode(content, (segment) =>
    segment
      .replace(/(?<!\\)!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g, (match, rawPath: string) => {
        const assetPath = rawPath.trim();
        if (isLocalMediaTarget(assetPath)) {
          urls.add(documentMediaUrl(assetPath, documentPath));
        }
        return match;
      })
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, _rawAlt: string, rawPath: string) => {
        const assetPath = rawPath.trim();
        if (assetPath.startsWith(MEDIA_PATH)) {
          urls.add(assetPath);
        } else if (isLocalMediaTarget(assetPath)) {
          urls.add(documentMediaUrl(assetPath, documentPath));
        }
        return match;
      })
  );
  return Array.from(urls);
}

function userCacheKey(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i += 1) {
    hash = (hash * 31 + username.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36) || "user";
}

async function cacheMediaUrl(username: string, mediaUrl: string): Promise<void> {
  if (typeof window === "undefined" || typeof fetch !== "function") return;
  const absoluteUrl = new URL(mediaUrl, window.location.origin).toString();
  const request = new Request(absoluteUrl, { credentials: "include" });
  const response = await fetch(request);
  if (!response.ok || typeof caches === "undefined") return;
  const cache = await caches.open(`${MEDIA_CACHE_PREFIX}${userCacheKey(username)}`);
  await cache.put(request, response.clone());
}

export function warmDocumentMedia(username: string, documentPath: string, content: string): void {
  if (!username || !content) return;
  const urls = listLocalMediaUrlsForDocument(content, documentPath);
  if (urls.length === 0) return;
  void Promise.allSettled(urls.map((url) => cacheMediaUrl(username, url)));
}

function parentFolderOfPath(path: string): string {
  const clean = path.replace(/\/+$/g, "");
  const slash = clean.lastIndexOf("/");
  return slash > 0 ? clean.slice(0, slash) : "";
}

function titleFromContent(path: string, content: string): string {
  const heading = content.match(/^\s*#{1,6}\s+(.+?)\s*$/m)?.[1]?.trim();
  return heading || basename(path).replace(/\.md$/i, "") || path;
}

function summaryFromContent(content: DocumentContent) {
  const { content: _content, frontmatter: _frontmatter, links: _links, ...summary } = content;
  return summary;
}

function synthDocument(path: string, content = "", base?: Partial<DocumentContent>): DocumentContent {
  const now = new Date().toISOString();
  return {
    path,
    name: basename(path),
    title: titleFromContent(path, content),
    createdAt: base?.createdAt ?? now,
    updatedAt: now,
    hash: base?.hash ?? `offline:${newOperationId()}`,
    tags: base?.tags ?? [],
    aliases: base?.aliases ?? [],
    headings: base?.headings ?? [],
    frontmatter: base?.frontmatter ?? {},
    links: base?.links ?? [],
    content
  };
}

function sortEntries(entries: DocumentTreeEntry[], sort: SortField, order: SortOrder): DocumentTreeEntry[] {
  const factor = order === "asc" ? 1 : -1;
  const treeSort: "name" | "updatedAt" = sort === "updatedAt" ? "updatedAt" : "name";
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    const aValue = treeSort === "updatedAt" ? a.updatedAt ?? "" : a.name;
    const bValue = treeSort === "updatedAt" ? b.updatedAt ?? "" : b.name;
    const primary = String(aValue).localeCompare(String(bValue));
    if (primary !== 0) return primary * factor;
    return a.path.localeCompare(b.path);
  });
}

function folderNameFromPath(path: string): string {
  return basename(path) || "";
}

function documentEntry(doc: DocumentContent): DocumentTreeEntry {
  return {
    path: doc.path,
    name: doc.name,
    type: "file",
    updatedAt: doc.updatedAt
  };
}

function folderEntry(path: string): DocumentTreeEntry {
  return {
    path,
    name: folderNameFromPath(path),
    type: "folder",
    hasChildren: true
  };
}

function treeRoot(folderPath: string, children: DocumentTreeEntry[]): DocumentTreeEntry {
  return {
    path: folderPath,
    name: folderNameFromPath(folderPath),
    type: "folder",
    children
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function safePreviewHref(value: string): string {
  const href = value.trim();
  if (!href) return "#";
  if (href.startsWith("#") || href.startsWith("/")) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return /^(https?:|mailto:|tel:)/i.test(href) ? href : "#";
  }
  return href;
}

function markdownMediaSyntax(assetPath: string, documentPath: string): string {
  const label = basename(assetPath) || assetPath;
  const href = documentMediaUrl(assetPath, documentPath);
  return extensionOfMediaTarget(assetPath) === ".pdf" ? `[${label}](${href})` : `![${label}](${href})`;
}

function rewriteLocalMediaReferences(content: string, documentPath: string): string {
  return transformOutsideMarkdownCode(content, (segment) =>
    segment
      .replace(/(?<!\\)!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g, (match, rawPath: string) => {
        const assetPath = rawPath.trim();
        return isLocalMediaTarget(assetPath) ? markdownMediaSyntax(assetPath, documentPath) : match;
      })
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (match, rawAlt: string, rawPath: string, rawTitle = "") => {
        const assetPath = rawPath.trim();
        if (!isLocalMediaTarget(assetPath)) return match;
        return `![${rawAlt}](${documentMediaUrl(assetPath, documentPath)}${rawTitle})`;
      })
      .replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (match, rawText: string, rawPath: string, rawTitle = "") => {
        const assetPath = rawPath.trim();
        if (!isLocalMediaTarget(assetPath)) return match;
        return `[${rawText}](${documentMediaUrl(assetPath, documentPath)}${rawTitle})`;
      })
  );
}

function offlinePreviewRenderer() {
  const renderer = new marked.Renderer();

  renderer.html = function html(token: Tokens.HTML): string {
    return escapeHtml(token.raw);
  };
  renderer.link = function link(token: Tokens.Link): string {
    const href = safePreviewHref(token.href);
    const title = token.title ? ` title="${escapeAttribute(token.title)}"` : "";
    const text = escapeHtml(token.text);
    return `<a href="${escapeAttribute(href)}"${title}>${text}</a>`;
  };
  renderer.image = function image(token: Tokens.Image): string {
    const href = safePreviewHref(token.href);
    const title = token.title ? ` title="${escapeAttribute(token.title)}"` : "";
    return `<img src="${escapeAttribute(href)}" alt="${escapeAttribute(token.text)}"${title} loading="lazy">`;
  };
  renderer.code = function code(token: Tokens.Code): string {
    const lang = (token.lang || "").trim().split(/\s+/)[0];
    const langClass = lang ? ` class="language-${escapeAttribute(lang)}"` : "";
    return `<pre class="hljs"><code${langClass}>${escapeHtml(token.text)}</code></pre>\n`;
  };

  return renderer;
}

async function markdownFallbackHtml(content: string, documentPath: string): Promise<string> {
  const markdown = rewriteLocalMediaReferences(content, documentPath);
  const html = await marked.parse(markdown, {
    async: false,
    gfm: true,
    breaks: true,
    renderer: offlinePreviewRenderer()
  });
  return `<div class="offline-markdown-fallback">${html}</div>`;
}

async function getRecord<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  const tx = db.transaction(storeName, "readonly");
  const result = await idbRequest<T | undefined>(tx.objectStore(storeName).get(key));
  await txDone(tx);
  return result;
}

async function putRecord<T>(storeName: string, value: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  await idbRequest(tx.objectStore(storeName).put(value));
  await txDone(tx);
}

async function deleteRecord(storeName: string, key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  await idbRequest(tx.objectStore(storeName).delete(key));
  await txDone(tx);
}

async function allRecords<T>(storeName: string): Promise<T[]> {
  const db = await openDb();
  const tx = db.transaction(storeName, "readonly");
  const result = await idbRequest<T[]>(tx.objectStore(storeName).getAll());
  await txDone(tx);
  return result;
}

async function allUserDocuments(username: string): Promise<OfflineDocumentRecord[]> {
  return (await allRecords<OfflineDocumentRecord>(DOCS_STORE)).filter((record) => record.username === username);
}

async function allUserFolders(username: string): Promise<OfflineFolderRecord[]> {
  return (await allRecords<OfflineFolderRecord>(FOLDERS_STORE)).filter((record) => record.username === username);
}

async function allUserOperations(username: string): Promise<OfflineOperation[]> {
  return (await allRecords<OfflineOperation>(OPS_STORE))
    .filter((record) => record.username === username)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function allUserPins(username: string): Promise<OfflinePinRecord[]> {
  return (await allRecords<OfflinePinRecord>(PINS_STORE))
    .filter((record) => record.username === username)
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      return a.path.localeCompare(b.path);
    });
}

async function allUserMetadata(username: string): Promise<OfflineMetadataRecord[]> {
  return (await allRecords<OfflineMetadataRecord>(META_STORE)).filter((record) => record.username === username);
}

async function getMetadata<T>(username: string, name: string): Promise<OfflineMetadataRecord<T> | undefined> {
  return getRecord<OfflineMetadataRecord<T>>(META_STORE, metaKeyFor(username, name));
}

async function putMetadata<T>(username: string, name: string, value: T): Promise<void> {
  await putRecord<OfflineMetadataRecord<T>>(META_STORE, {
    key: metaKeyFor(username, name),
    username,
    name,
    value,
    updatedAt: new Date().toISOString()
  });
}

async function fullLibraryMeta(username: string): Promise<FullLibraryOfflineMeta> {
  return (await getMetadata<FullLibraryOfflineMeta>(username, "fullLibrary"))?.value ?? { enabled: false };
}

async function getDocumentRecord(username: string, path: string): Promise<OfflineDocumentRecord | undefined> {
  return getRecord<OfflineDocumentRecord>(DOCS_STORE, keyFor(username, path));
}

async function putDocument(username: string, document: DocumentContent, options: { dirty?: boolean; deleted?: boolean } = {}): Promise<void> {
  const existing = await getDocumentRecord(username, document.path);
  await putRecord<OfflineDocumentRecord>(DOCS_STORE, {
    key: keyFor(username, document.path),
    username,
    path: document.path,
    document,
    cachedAt: new Date().toISOString(),
    dirty: options.dirty ?? existing?.dirty,
    deleted: options.deleted ?? false,
    previewHtml: existing?.previewHtml,
    previewDraft: existing?.previewDraft
  });
  if (!options.deleted) {
    warmDocumentMedia(username, document.path, document.content);
  }
}

async function putFolderChildren(username: string, folderPath: string, children: DocumentTreeEntry[]): Promise<void> {
  await putRecord<OfflineFolderRecord>(FOLDERS_STORE, {
    key: keyFor(username, folderPath),
    username,
    path: folderPath,
    children,
    cachedAt: new Date().toISOString()
  });
}

async function getFolderChildren(username: string, folderPath: string): Promise<DocumentTreeEntry[] | null> {
  const record = await getRecord<OfflineFolderRecord>(FOLDERS_STORE, keyFor(username, folderPath));
  return record?.children ?? null;
}

async function ensureFolderPath(username: string, folderPath: string): Promise<void> {
  if (!folderPath) return;
  const parts = folderPath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    const next = current ? `${current}/${part}` : part;
    const parent = current;
    const children = (await getFolderChildren(username, parent)) ?? [];
    if (!children.some((entry) => entry.type === "folder" && entry.path === next)) {
      await putFolderChildren(username, parent, [...children, folderEntry(next)]);
    }
    if ((await getFolderChildren(username, next)) === null) {
      await putFolderChildren(username, next, []);
    }
    current = next;
  }
}

async function upsertFolderEntry(username: string, parentPath: string, entry: DocumentTreeEntry): Promise<void> {
  await ensureFolderPath(username, parentPath);
  const children = (await getFolderChildren(username, parentPath)) ?? [];
  const next = [...children.filter((child) => !(child.type === entry.type && child.path === entry.path)), entry];
  await putFolderChildren(username, parentPath, next);
}

async function removeFolderEntry(username: string, parentPath: string, path: string): Promise<void> {
  const children = (await getFolderChildren(username, parentPath)) ?? [];
  await putFolderChildren(username, parentPath, children.filter((child) => child.path !== path));
}

async function queueOperation(username: string, operation: Omit<OfflineOperation, "id" | "username" | "createdAt" | "status">): Promise<void> {
  await putRecord<OfflineOperation>(OPS_STORE, {
    ...operation,
    id: newOperationId(),
    username,
    createdAt: new Date().toISOString(),
    status: "pending"
  } as OfflineOperation);
  await emitOfflineState(username);
}

async function removeOperation(operationId: string): Promise<void> {
  await deleteRecord(OPS_STORE, operationId);
}

async function markOperationConflict(operation: OfflineOperation, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await putRecord<OfflineOperation>(OPS_STORE, { ...operation, status: "conflict", lastError: message });
}

async function hasPendingLocalState(username: string): Promise<boolean> {
  const operations = await allUserOperations(username);
  return operations.some((operation) => operation.status === "pending" || operation.status === "conflict");
}

async function pendingCreateFor(username: string, path: string): Promise<OfflineOperation | undefined> {
  return (await allUserOperations(username)).find(
    (operation) => operation.status === "pending" && operation.type === "createDocument" && operation.payload.path === path
  );
}

async function upsertPendingCreateContent(username: string, path: string, content: string): Promise<boolean> {
  const existing = await pendingCreateFor(username, path);
  if (!existing || existing.type !== "createDocument") return false;
  await putRecord<OfflineOperation>(OPS_STORE, { ...existing, payload: { ...existing.payload, content } });
  await emitOfflineState(username);
  return true;
}

async function upsertPendingUpdate(username: string, path: string, content: string, expectedHash?: string): Promise<void> {
  if (await upsertPendingCreateContent(username, path, content)) return;
  const existing = (await allUserOperations(username)).find(
    (operation) => operation.status === "pending" && operation.type === "updateDocument" && operation.payload.path === path
  );
  if (existing && existing.type === "updateDocument") {
    await putRecord<OfflineOperation>(OPS_STORE, {
      ...existing,
      payload: { ...existing.payload, content, expectedHash: existing.payload.expectedHash ?? expectedHash }
    });
    await emitOfflineState(username);
    return;
  }
  await queueOperation(username, { type: "updateDocument", payload: { path, content, expectedHash } });
}

async function remapPendingDocumentPath(username: string, currentPath: string, nextPath: string): Promise<boolean> {
  let changed = false;
  const operations = await allUserOperations(username);
  for (const operation of operations) {
    if (operation.status !== "pending") continue;
    if (operation.type === "createDocument" && operation.payload.path === currentPath) {
      await putRecord<OfflineOperation>(OPS_STORE, { ...operation, payload: { ...operation.payload, path: nextPath } });
      changed = true;
    } else if (operation.type === "updateDocument" && operation.payload.path === currentPath) {
      await putRecord<OfflineOperation>(OPS_STORE, { ...operation, payload: { ...operation.payload, path: nextPath } });
      changed = true;
    } else if (operation.type === "deleteDocument" && operation.payload.path === currentPath) {
      await putRecord<OfflineOperation>(OPS_STORE, { ...operation, payload: { path: nextPath } });
      changed = true;
    }
  }
  if (changed) await emitOfflineState(username);
  return changed;
}

async function remapPendingFolderPrefix(username: string, currentPath: string, nextPath: string): Promise<void> {
  const oldPrefix = `${currentPath}/`;
  const operations = await allUserOperations(username);
  for (const operation of operations) {
    if (operation.status !== "pending") continue;
    if (
      (operation.type === "createDocument" || operation.type === "updateDocument" || operation.type === "deleteDocument") &&
      operation.payload.path.startsWith(oldPrefix)
    ) {
      await putRecord<OfflineOperation>(OPS_STORE, {
        ...operation,
        payload: { ...operation.payload, path: `${nextPath}/${operation.payload.path.slice(oldPrefix.length)}` }
      } as OfflineOperation);
    }
  }
  await emitOfflineState(username);
}

async function remapOfflinePinPath(username: string, kind: OfflinePinKind, currentPath: string, nextPath: string): Promise<void> {
  const pin = await getRecord<OfflinePinRecord>(PINS_STORE, pinKeyFor(username, kind, currentPath));
  if (!pin) return;
  await deleteRecord(PINS_STORE, pin.key);
  await putRecord<OfflinePinRecord>(PINS_STORE, {
    ...pin,
    key: pinKeyFor(username, kind, nextPath),
    path: nextPath
  });
  await emitOfflineCacheStatus(username);
}

async function remapOfflinePinPrefix(username: string, currentPath: string, nextPath: string): Promise<void> {
  const oldPrefix = `${currentPath}/`;
  const pins = await allUserPins(username);
  let changed = false;
  for (const pin of pins) {
    if (pin.path !== currentPath && !pin.path.startsWith(oldPrefix)) continue;
    const remappedPath = pin.path === currentPath ? nextPath : `${nextPath}/${pin.path.slice(oldPrefix.length)}`;
    await deleteRecord(PINS_STORE, pin.key);
    await putRecord<OfflinePinRecord>(PINS_STORE, {
      ...pin,
      key: pinKeyFor(username, pin.kind, remappedPath),
      path: remappedPath
    });
    changed = true;
  }
  if (changed) await emitOfflineCacheStatus(username);
}

async function removeOfflinePinsForPath(username: string, path: string): Promise<void> {
  const prefix = `${path}/`;
  let changed = false;
  for (const pin of await allUserPins(username)) {
    if (pin.path === path || pin.path.startsWith(prefix)) {
      await deleteRecord(PINS_STORE, pin.key);
      changed = true;
    }
  }
  if (changed) await emitOfflineCacheStatus(username);
}

async function applyLocalDocumentSave(username: string, path: string, content: string, expectedHash?: string): Promise<DocumentContent> {
  const existing = await getDocumentRecord(username, path);
  const saved = synthDocument(path, content, existing?.document ?? { hash: expectedHash });
  await putDocument(username, saved, { dirty: true });
  await upsertFolderEntry(username, parentFolderOfPath(path), documentEntry(saved));
  await upsertPendingUpdate(username, path, content, expectedHash);
  return saved;
}

async function applyLocalDocumentCreate(username: string, path: string, content = ""): Promise<DocumentContent> {
  const existing = await getDocumentRecord(username, path);
  if (existing && !existing.deleted) {
    throw new Error("Document already exists");
  }
  const pendingCreate = await pendingCreateFor(username, path);
  if (pendingCreate) {
    throw new Error("Document already exists");
  }
  const doc = synthDocument(path, content);
  await ensureFolderPath(username, parentFolderOfPath(path));
  await putDocument(username, doc, { dirty: true });
  await upsertFolderEntry(username, parentFolderOfPath(path), documentEntry(doc));
  await queueOperation(username, { type: "createDocument", payload: { path, content } });
  return doc;
}

async function applyLocalDocumentRename(username: string, currentPath: string, nextPath: string): Promise<DocumentContent> {
  const existing = await getDocumentRecord(username, currentPath);
  const renamed = synthDocument(nextPath, existing?.document.content ?? "", existing?.document);
  renamed.hash = existing?.document.hash ?? renamed.hash;
  renamed.createdAt = existing?.document.createdAt ?? renamed.createdAt;
  await deleteRecord(DOCS_STORE, keyFor(username, currentPath));
  await putDocument(username, renamed, { dirty: existing?.dirty ?? true });
  await removeFolderEntry(username, parentFolderOfPath(currentPath), currentPath);
  await upsertFolderEntry(username, parentFolderOfPath(nextPath), documentEntry(renamed));
  const remappedPendingCreate = await remapPendingDocumentPath(username, currentPath, nextPath);
  if (!remappedPendingCreate) {
    await queueOperation(username, { type: "renameDocument", payload: { path: currentPath, nextPath } });
  }
  await remapOfflinePinPath(username, "document", currentPath, nextPath);
  return renamed;
}

async function applyLocalDocumentDelete(username: string, path: string): Promise<void> {
  const pendingCreate = await pendingCreateFor(username, path);
  if (pendingCreate) {
    await removeOperation(pendingCreate.id);
    await deleteRecord(DOCS_STORE, keyFor(username, path));
  } else {
    const existing = await getDocumentRecord(username, path);
    if (existing) {
      await putRecord<OfflineDocumentRecord>(DOCS_STORE, { ...existing, deleted: true, dirty: true, cachedAt: new Date().toISOString() });
    }
    await queueOperation(username, { type: "deleteDocument", payload: { path } });
  }
  await removeFolderEntry(username, parentFolderOfPath(path), path);
  await removeOfflinePinsForPath(username, path);
  await emitOfflineState(username);
}

async function applyLocalFolderCreate(username: string, path: string): Promise<void> {
  await ensureFolderPath(username, parentFolderOfPath(path));
  await upsertFolderEntry(username, parentFolderOfPath(path), folderEntry(path));
  if ((await getFolderChildren(username, path)) === null) {
    await putFolderChildren(username, path, []);
  }
  await queueOperation(username, { type: "createFolder", payload: { path } });
}

async function applyLocalFolderRename(username: string, currentPath: string, nextPath: string): Promise<void> {
  const oldPrefix = `${currentPath}/`;
  const newPrefix = `${nextPath}/`;
  const folderRecords = await allUserFolders(username);
  for (const folder of folderRecords) {
    if (folder.path !== currentPath && !folder.path.startsWith(oldPrefix)) continue;
    const remappedPath = folder.path === currentPath ? nextPath : `${newPrefix}${folder.path.slice(oldPrefix.length)}`;
    const remappedChildren = folder.children.map((child) => {
      if (child.path === currentPath) return { ...child, path: nextPath, name: folderNameFromPath(nextPath) };
      if (!child.path.startsWith(oldPrefix)) return child;
      return { ...child, path: `${newPrefix}${child.path.slice(oldPrefix.length)}`, name: basename(child.path) };
    });
    await deleteRecord(FOLDERS_STORE, folder.key);
    await putFolderChildren(username, remappedPath, remappedChildren);
  }
  const docs = await allUserDocuments(username);
  for (const record of docs) {
    if (!record.path.startsWith(oldPrefix)) continue;
    const nextDocPath = `${newPrefix}${record.path.slice(oldPrefix.length)}`;
    const nextDoc = synthDocument(nextDocPath, record.document.content, record.document);
    nextDoc.hash = record.document.hash;
    nextDoc.createdAt = record.document.createdAt;
    await deleteRecord(DOCS_STORE, record.key);
    await putDocument(username, nextDoc, { dirty: record.dirty, deleted: record.deleted });
  }
  await removeFolderEntry(username, parentFolderOfPath(currentPath), currentPath);
  await upsertFolderEntry(username, parentFolderOfPath(nextPath), folderEntry(nextPath));
  await remapPendingFolderPrefix(username, currentPath, nextPath);
  await remapOfflinePinPrefix(username, currentPath, nextPath);
  await queueOperation(username, { type: "renameFolder", payload: { path: currentPath, nextPath } });
}

async function localFolderFileCount(username: string, folderPath: string): Promise<number> {
  const prefix = `${folderPath}/`;
  const docs = await allUserDocuments(username);
  return docs.filter((record) => !record.deleted && record.path.startsWith(prefix)).length;
}

async function applyLocalFolderDelete(username: string, path: string, recursive: boolean): Promise<void> {
  const fileCount = await localFolderFileCount(username, path);
  if (fileCount > 0 && !recursive) {
    throw new Error(`Folder is not empty (${fileCount} file${fileCount === 1 ? "" : "s"}). Pass recursive=true to delete it anyway.`);
  }
  const prefix = `${path}/`;
  for (const record of await allUserDocuments(username)) {
    if (record.path.startsWith(prefix)) {
      await putRecord<OfflineDocumentRecord>(DOCS_STORE, { ...record, deleted: true, dirty: true, cachedAt: new Date().toISOString() });
    }
  }
  for (const folder of await allUserFolders(username)) {
    if (folder.path === path || folder.path.startsWith(prefix)) {
      await deleteRecord(FOLDERS_STORE, folder.key);
    }
  }
  await removeFolderEntry(username, parentFolderOfPath(path), path);
  await removeOfflinePinsForPath(username, path);
  await queueOperation(username, { type: "deleteFolder", payload: { path, recursive } });
}

async function cachedDocumentOrThrow(username: string, path: string): Promise<DocumentContent> {
  const cached = await getDocumentRecord(username, path);
  if (!cached || cached.deleted) {
    throw new Error("This note is not available offline yet.");
  }
  return cached.document;
}

async function emitOfflineState(username: string, lastError?: string): Promise<OfflineWorkspaceState> {
  const state = await getOfflineState(username, lastError);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OFFLINE_EVENT, { detail: { username, state } }));
  }
  return state;
}

export function addOfflineStateListener(
  listener: (event: { username: string; state: OfflineWorkspaceState }) => void
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ username: string; state: OfflineWorkspaceState }>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener(OFFLINE_EVENT, handler);
  return () => window.removeEventListener(OFFLINE_EVENT, handler);
}

function currentCacheProgress(username: string): OfflineCacheProgress {
  return warmingUsers.get(username) ?? { running: false, done: 0 };
}

async function emitOfflineCacheStatus(username: string): Promise<OfflineCacheStatus> {
  const status = await getOfflineCacheStatus(username);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OFFLINE_CACHE_EVENT, { detail: { username, status } }));
  }
  return status;
}

function setCacheProgress(username: string, progress: OfflineCacheProgress): void {
  warmingUsers.set(username, progress);
  if (typeof window !== "undefined") {
    void emitOfflineCacheStatus(username);
  }
}

async function setCacheError(username: string, error: unknown): Promise<OfflineCacheStatus> {
  const message = error instanceof Error ? error.message : String(error);
  const previous = currentCacheProgress(username);
  warmingUsers.set(username, { ...previous, running: false, lastError: message });
  return emitOfflineCacheStatus(username);
}

export function addOfflineCacheListener(
  listener: (event: { username: string; status: OfflineCacheStatus }) => void
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ username: string; status: OfflineCacheStatus }>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener(OFFLINE_CACHE_EVENT, handler);
  return () => window.removeEventListener(OFFLINE_CACHE_EVENT, handler);
}

export async function getOfflineCacheStatus(username: string): Promise<OfflineCacheStatus> {
  if (!username || !canUseIndexedDb()) {
    return {
      fullLibrary: false,
      pinned: [],
      progress: { running: false, done: 0 },
      cachedDocumentCount: 0,
      cachedFolderCount: 0
    };
  }
  const [pins, meta, docs, folders] = await Promise.all([
    allUserPins(username),
    fullLibraryMeta(username),
    allUserDocuments(username),
    allUserFolders(username)
  ]);
  return {
    fullLibrary: meta.enabled,
    fullLibraryCachedAt: meta.cachedAt,
    pinned: pins,
    progress: currentCacheProgress(username),
    cachedDocumentCount: docs.filter((record) => !record.deleted).length,
    cachedFolderCount: folders.length
  };
}

function offlineTreeEntry(entry: DocumentTreeEntry): DocumentTreeEntry {
  if (entry.type === "folder") {
    return {
      path: entry.path,
      name: entry.name,
      type: "folder",
      hasChildren: entry.hasChildren ?? (entry.children?.length ?? 0) > 0,
      updatedAt: entry.updatedAt
    };
  }
  return {
    path: entry.path,
    name: entry.name,
    type: "file",
    updatedAt: entry.updatedAt
  };
}

async function storeTreeSnapshot(username: string, node: DocumentTreeEntry): Promise<void> {
  const children = node.children ?? [];
  await putFolderChildren(username, node.path, children.map(offlineTreeEntry));
  for (const child of children) {
    if (child.type === "folder") {
      await storeTreeSnapshot(username, child);
    }
  }
}

function collectTreeDocumentPaths(node: DocumentTreeEntry, output: string[] = []): string[] {
  for (const child of node.children ?? []) {
    if (child.type === "file") {
      output.push(child.path);
    } else {
      collectTreeDocumentPaths(child, output);
    }
  }
  return output;
}

async function fetchTreeSnapshot(folderPath: string, options: { sort: SortField; order: SortOrder }): Promise<DocumentTreeEntry> {
  const params = new URLSearchParams();
  if (folderPath) params.set("path", folderPath);
  params.set("sort", options.sort === "updatedAt" ? "updatedAt" : "name");
  params.set("order", options.order);
  params.set("depth", "20");
  return api<DocumentTreeEntry>(`/api/documents/tree?${params.toString()}`);
}

async function cacheDocumentForOffline(username: string, path: string, progress: OfflineCacheProgress): Promise<void> {
  progress.currentPath = path;
  setCacheProgress(username, { ...progress });
  const doc = await readDocument(username, path);
  try {
    await renderPreview(username, doc.content, doc.path, false);
  } catch {
    // The raw note and media are already cached by readDocument; preview can fall back locally.
  }
  progress.done += 1;
  setCacheProgress(username, { ...progress });
}

async function cacheDocumentsForOffline(
  username: string,
  paths: string[],
  seen: Set<string>,
  progress: OfflineCacheProgress
): Promise<void> {
  const uniquePaths = paths.filter((path) => {
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  });
  progress.total = (progress.total ?? progress.done) + uniquePaths.length;
  setCacheProgress(username, { ...progress });
  for (const path of uniquePaths) {
    await cacheDocumentForOffline(username, path, progress);
  }
}

async function cacheFolderForOffline(
  username: string,
  folderPath: string,
  options: { sort: SortField; order: SortOrder },
  seen: Set<string>,
  progress: OfflineCacheProgress
): Promise<void> {
  progress.currentPath = folderPath || "/";
  setCacheProgress(username, { ...progress });
  const tree = await fetchTreeSnapshot(folderPath, options);
  await storeTreeSnapshot(username, tree);
  await cacheDocumentsForOffline(username, collectTreeDocumentPaths(tree), seen, progress);
}

async function markPinCached(username: string, kind: OfflinePinKind, path: string, cachedAt: string, lastError?: string): Promise<void> {
  const pin = await getRecord<OfflinePinRecord>(PINS_STORE, pinKeyFor(username, kind, path));
  if (!pin) return;
  await putRecord<OfflinePinRecord>(PINS_STORE, { ...pin, cachedAt: cachedAt || pin.cachedAt, lastError });
}

async function warmSingleOfflineTarget(
  username: string,
  target: { kind: OfflinePinKind; path: string },
  options: { sort: SortField; order: SortOrder },
  seen: Set<string>,
  progress: OfflineCacheProgress
): Promise<void> {
  try {
    if (target.kind === "document") {
      await cacheDocumentsForOffline(username, [target.path], seen, progress);
    } else {
      await cacheFolderForOffline(username, target.path, options, seen, progress);
    }
    await markPinCached(username, target.kind, target.path, new Date().toISOString());
  } catch (error) {
    await markPinCached(username, target.kind, target.path, "", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function setOfflinePin(
  username: string,
  kind: OfflinePinKind,
  path: string,
  pinned: boolean,
  options: { sort?: SortField; order?: SortOrder } = {}
): Promise<OfflineCacheStatus> {
  if (!username || !canUseIndexedDb()) return getOfflineCacheStatus(username);
  const key = pinKeyFor(username, kind, path);
  if (pinned) {
    const existing = await getRecord<OfflinePinRecord>(PINS_STORE, key);
    await putRecord<OfflinePinRecord>(PINS_STORE, {
      key,
      username,
      kind,
      path,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      cachedAt: existing?.cachedAt,
      lastError: undefined
    });
    const sort = options.sort ?? "name";
    const order = options.order ?? "asc";
    void warmOfflineCache(username, { sort, order, targets: [{ kind, path }] }).catch((error) => {
      void setCacheError(username, error);
    });
  } else {
    await deleteRecord(PINS_STORE, key);
  }
  return emitOfflineCacheStatus(username);
}

export async function setFullLibraryOffline(
  username: string,
  enabled: boolean,
  options: { sort?: SortField; order?: SortOrder } = {}
): Promise<OfflineCacheStatus> {
  if (!username || !canUseIndexedDb()) return getOfflineCacheStatus(username);
  const existing = await fullLibraryMeta(username);
  await putMetadata<FullLibraryOfflineMeta>(username, "fullLibrary", {
    enabled,
    cachedAt: enabled ? existing.cachedAt : undefined
  });
  if (enabled) {
    void warmOfflineCache(username, { sort: options.sort ?? "name", order: options.order ?? "asc" }).catch((error) => {
      void setCacheError(username, error);
    });
  }
  return emitOfflineCacheStatus(username);
}

export async function warmOfflineCache(
  username: string,
  options: { sort?: SortField; order?: SortOrder; targets?: Array<{ kind: OfflinePinKind; path: string }> } = {}
): Promise<OfflineCacheStatus> {
  if (!username || !canUseIndexedDb()) return getOfflineCacheStatus(username);
  const existing = warmingUsers.get(username);
  if (existing?.running) return getOfflineCacheStatus(username);

  const sort = options.sort ?? "name";
  const order = options.order ?? "asc";
  const meta = await fullLibraryMeta(username);
  const targets = options.targets ?? (meta.enabled ? [] : await allUserPins(username));
  const shouldWarmFullLibrary = !options.targets && meta.enabled;
  if (!shouldWarmFullLibrary && targets.length === 0) {
    return getOfflineCacheStatus(username);
  }

  const progress: OfflineCacheProgress = { running: true, done: 0 };
  warmingUsers.set(username, progress);
  await emitOfflineCacheStatus(username);

  const seen = new Set<string>();
  try {
    if (shouldWarmFullLibrary) {
      await cacheFolderForOffline(username, "", { sort, order }, seen, progress);
      await putMetadata<FullLibraryOfflineMeta>(username, "fullLibrary", {
        enabled: true,
        cachedAt: new Date().toISOString()
      });
    }

    for (const target of targets) {
      await warmSingleOfflineTarget(username, target, { sort, order }, seen, progress);
    }

    warmingUsers.set(username, { ...progress, running: false, currentPath: undefined });
    return emitOfflineCacheStatus(username);
  } catch (error) {
    return setCacheError(username, error);
  }
}

export async function getOfflineState(username: string, lastError?: string): Promise<OfflineWorkspaceState> {
  if (!username || !canUseIndexedDb()) {
    return {
      isOnline: typeof navigator === "undefined" ? true : navigator.onLine,
      syncing: false,
      pendingCount: 0,
      conflictCount: 0,
      lastError
    };
  }
  const operations = await allUserOperations(username);
  return {
    isOnline: typeof navigator === "undefined" ? true : navigator.onLine,
    syncing: syncingUsers.has(username),
    pendingCount: operations.filter((operation) => operation.status === "pending").length,
    conflictCount: operations.filter((operation) => operation.status === "conflict").length,
    lastError
  };
}

export async function clearOfflineUserData(username: string): Promise<void> {
  if (!username || !canUseIndexedDb()) return;
  for (const record of await allUserDocuments(username)) {
    await deleteRecord(DOCS_STORE, record.key);
  }
  for (const record of await allUserFolders(username)) {
    await deleteRecord(FOLDERS_STORE, record.key);
  }
  for (const record of await allUserOperations(username)) {
    await removeOperation(record.id);
  }
  for (const record of await allUserPins(username)) {
    await deleteRecord(PINS_STORE, record.key);
  }
  for (const record of await allUserMetadata(username)) {
    await deleteRecord(META_STORE, record.key);
  }
  await emitOfflineState(username);
  await emitOfflineCacheStatus(username);
}

export async function getDocumentTree(
  username: string,
  folderPath: string,
  options: { sort: SortField; order: SortOrder }
): Promise<DocumentTreeEntry> {
  const hasLocalState = await hasPendingLocalState(username);
  if (!hasLocalState) {
    try {
      const params = new URLSearchParams();
      if (folderPath) params.set("path", folderPath);
      params.set("sort", options.sort === "updatedAt" ? "updatedAt" : "name");
      params.set("order", options.order);
      const data = await api<DocumentTreeEntry>(`/api/documents/tree?${params.toString()}`);
      await putFolderChildren(username, folderPath, data.children ?? []);
      return data;
    } catch (error) {
      if (!isNetworkError(error)) throw error;
    }
  }
  const cached = await getFolderChildren(username, folderPath);
  if (cached) return treeRoot(folderPath, sortEntries(cached, options.sort, options.order));
  throw new Error("This folder is not available offline yet.");
}

export async function getDocumentCount(username: string): Promise<number> {
  if (!(await hasPendingLocalState(username))) {
    try {
      const result = await api<{ count: number }>("/api/documents/count");
      return result.count;
    } catch (error) {
      if (!isNetworkError(error)) throw error;
    }
  }
  const docs = await allUserDocuments(username);
  return docs.filter((record) => !record.deleted).length;
}

export async function readDocument(username: string, path: string): Promise<DocumentContent> {
  const cached = await getDocumentRecord(username, path);
  if (cached?.dirty && !cached.deleted) return cached.document;
  try {
    const doc = await api<DocumentContent>(`/api/documents/content?path=${encodeURIComponent(path)}`);
    await putDocument(username, doc, { dirty: false });
    await upsertFolderEntry(username, parentFolderOfPath(doc.path), documentEntry(doc));
    return doc;
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    return cachedDocumentOrThrow(username, path);
  }
}

export async function renderPreview(username: string, content: string, path: string, isDraft?: boolean, signal?: AbortSignal): Promise<string> {
  try {
    const result = await api<{ html: string }>("/api/documents/preview", {
      method: "POST",
      signal,
      body: JSON.stringify({
        path: isDraft ? undefined : path,
        content
      })
    });
    if (!isDraft) {
      const record = await getDocumentRecord(username, path);
      if (record && !record.deleted) {
        await putRecord<OfflineDocumentRecord>(DOCS_STORE, {
          ...record,
          previewHtml: result.html,
          previewDraft: content,
          cachedAt: new Date().toISOString()
        });
      }
    }
    return result.html;
  } catch (error) {
    if (!isNetworkError(error) || isDraft) throw error;
    const record = await getDocumentRecord(username, path);
    if (record?.previewHtml && record.previewDraft === content) {
      return record.previewHtml;
    }
    return markdownFallbackHtml(content, path);
  }
}

export async function saveDocumentContent(username: string, path: string, content: string, expectedHash?: string): Promise<DocumentContent> {
  if (await pendingCreateFor(username, path)) {
    return applyLocalDocumentSave(username, path, content, expectedHash);
  }
  try {
    const saved = await api<DocumentContent>("/api/documents/content", {
      method: "PUT",
      body: JSON.stringify({ path, content, expectedHash })
    });
    await putDocument(username, saved, { dirty: false });
    await upsertFolderEntry(username, parentFolderOfPath(saved.path), documentEntry(saved));
    return saved;
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    return applyLocalDocumentSave(username, path, content, expectedHash);
  }
}

export async function createDocument(username: string, path: string, content = ""): Promise<DocumentContent> {
  try {
    const created = await api<DocumentContent>("/api/documents", {
      method: "POST",
      body: JSON.stringify({ path, content })
    });
    await putDocument(username, created, { dirty: false });
    await upsertFolderEntry(username, parentFolderOfPath(created.path), documentEntry(created));
    return created;
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    return applyLocalDocumentCreate(username, path, content);
  }
}

export async function renameDocument(username: string, currentPath: string, nextPath: string): Promise<DocumentContent> {
  if ((await pendingCreateFor(username, currentPath)) || !(typeof navigator !== "undefined" && navigator.onLine)) {
    return applyLocalDocumentRename(username, currentPath, nextPath);
  }
  try {
    const renamed = await api<DocumentContent>("/api/documents/rename", {
      method: "PATCH",
      body: JSON.stringify({ path: currentPath, nextPath })
    });
    await deleteRecord(DOCS_STORE, keyFor(username, currentPath));
    await putDocument(username, renamed, { dirty: false });
    await removeFolderEntry(username, parentFolderOfPath(currentPath), currentPath);
    await upsertFolderEntry(username, parentFolderOfPath(renamed.path), documentEntry(renamed));
    await remapOfflinePinPath(username, "document", currentPath, nextPath);
    return renamed;
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    return applyLocalDocumentRename(username, currentPath, nextPath);
  }
}

export async function deleteDocument(username: string, path: string): Promise<void> {
  if ((await pendingCreateFor(username, path)) || !(typeof navigator !== "undefined" && navigator.onLine)) {
    await applyLocalDocumentDelete(username, path);
    return;
  }
  try {
    await api("/api/documents/content", {
      method: "DELETE",
      body: JSON.stringify({ path })
    });
    await deleteRecord(DOCS_STORE, keyFor(username, path));
    await removeFolderEntry(username, parentFolderOfPath(path), path);
    await removeOfflinePinsForPath(username, path);
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    await applyLocalDocumentDelete(username, path);
  }
}

export async function createFolder(username: string, path: string): Promise<void> {
  try {
    await api<{ path: string }>("/api/documents/folders", {
      method: "POST",
      body: JSON.stringify({ path })
    });
    await ensureFolderPath(username, parentFolderOfPath(path));
    await upsertFolderEntry(username, parentFolderOfPath(path), folderEntry(path));
    await putFolderChildren(username, path, []);
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    await applyLocalFolderCreate(username, path);
  }
}

export async function renameFolder(username: string, currentPath: string, nextPath: string): Promise<void> {
  try {
    await api<{ path: string; movedFiles: number }>("/api/documents/folders/rename", {
      method: "PATCH",
      body: JSON.stringify({ path: currentPath, nextPath })
    });
    await applyLocalFolderRename(username, currentPath, nextPath);
    const operations = await allUserOperations(username);
    const lastRename = operations
      .filter((operation) => operation.type === "renameFolder" && operation.payload.path === currentPath && operation.payload.nextPath === nextPath)
      .at(-1);
    if (lastRename) await removeOperation(lastRename.id);
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    await applyLocalFolderRename(username, currentPath, nextPath);
  }
}

export async function deleteFolder(username: string, path: string, recursive: boolean): Promise<void> {
  try {
    await api(`/api/documents/folders?recursive=${recursive ? "1" : "0"}`, {
      method: "DELETE",
      body: JSON.stringify({ path })
    });
    const prefix = `${path}/`;
    for (const record of await allUserDocuments(username)) {
      if (record.path.startsWith(prefix)) await deleteRecord(DOCS_STORE, record.key);
    }
    for (const folder of await allUserFolders(username)) {
      if (folder.path === path || folder.path.startsWith(prefix)) await deleteRecord(FOLDERS_STORE, folder.key);
    }
    await removeFolderEntry(username, parentFolderOfPath(path), path);
    await removeOfflinePinsForPath(username, path);
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    await applyLocalFolderDelete(username, path, recursive);
  }
}

export async function searchDocuments(username: string, query: string): Promise<DocumentSearchResult[]> {
  if (!(await hasPendingLocalState(username))) {
    try {
      return await api<DocumentSearchResult[]>(`/api/documents/search?q=${encodeURIComponent(query)}`);
    } catch (error) {
      if (!isNetworkError(error)) throw error;
    }
  }
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const docs = await allUserDocuments(username);
  return docs
    .filter((record) => !record.deleted)
    .filter((record) => {
      const doc = record.document;
      return [doc.path, doc.name, doc.title, doc.content, ...doc.tags, ...doc.aliases, ...doc.headings]
        .join("\n")
        .toLocaleLowerCase()
        .includes(needle);
    })
    .slice(0, 100)
    .map((record) => {
      const doc = record.document;
      const idx = doc.content.toLocaleLowerCase().indexOf(needle);
      const snippet = idx >= 0 ? doc.content.slice(Math.max(0, idx - 40), idx + needle.length + 80).replace(/\s+/g, " ") : doc.title;
      return {
        path: doc.path,
        name: doc.name,
        title: doc.title,
        snippet,
        source: "filesystem" as const
      };
    });
}

export async function syncOfflineQueue(username: string): Promise<OfflineWorkspaceState> {
  if (!username || syncingUsers.has(username)) return getOfflineState(username);
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return emitOfflineState(username);
  }
  syncingUsers.add(username);
  await emitOfflineState(username);
  let lastError: string | undefined;
  try {
    const operations = (await allUserOperations(username)).filter((operation) => operation.status === "pending");
    for (const operation of operations) {
      try {
        await syncOperation(username, operation);
        await removeOperation(operation.id);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (isNetworkError(error)) {
          break;
        }
        await markOperationConflict(operation, error);
        break;
      }
    }
  } finally {
    syncingUsers.delete(username);
  }
  return emitOfflineState(username, lastError);
}

async function syncOperation(username: string, operation: OfflineOperation): Promise<void> {
  switch (operation.type) {
    case "createDocument": {
      const created = await api<DocumentContent>("/api/documents", {
        method: "POST",
        body: JSON.stringify(operation.payload)
      });
      await putDocument(username, created, { dirty: false });
      await upsertFolderEntry(username, parentFolderOfPath(created.path), documentEntry(created));
      return;
    }
    case "updateDocument": {
      const saved = await api<DocumentContent>("/api/documents/content", {
        method: "PUT",
        body: JSON.stringify(operation.payload)
      });
      await putDocument(username, saved, { dirty: false });
      await upsertFolderEntry(username, parentFolderOfPath(saved.path), documentEntry(saved));
      return;
    }
    case "deleteDocument": {
      try {
        await api("/api/documents/content", {
          method: "DELETE",
          body: JSON.stringify(operation.payload)
        });
      } catch (error) {
        if (!isHttpError(error, 404)) throw error;
      }
      await deleteRecord(DOCS_STORE, keyFor(username, operation.payload.path));
      await removeFolderEntry(username, parentFolderOfPath(operation.payload.path), operation.payload.path);
      return;
    }
    case "renameDocument": {
      const renamed = await api<DocumentContent>("/api/documents/rename", {
        method: "PATCH",
        body: JSON.stringify(operation.payload)
      });
      await deleteRecord(DOCS_STORE, keyFor(username, operation.payload.path));
      await putDocument(username, renamed, { dirty: false });
      return;
    }
    case "createFolder": {
      await api<{ path: string }>("/api/documents/folders", {
        method: "POST",
        body: JSON.stringify(operation.payload)
      });
      return;
    }
    case "renameFolder": {
      await api<{ path: string; movedFiles: number }>("/api/documents/folders/rename", {
        method: "PATCH",
        body: JSON.stringify(operation.payload)
      });
      return;
    }
    case "deleteFolder": {
      await api(`/api/documents/folders?recursive=${operation.payload.recursive ? "1" : "0"}`, {
        method: "DELETE",
        body: JSON.stringify({ path: operation.payload.path })
      });
      return;
    }
  }
}
