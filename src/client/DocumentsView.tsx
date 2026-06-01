import { lazy, memo, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { DocumentContent, DocumentSearchResult, DocumentSummary, DocumentTreeEntry, SortField, SortOrder } from "../shared/types";
import { api } from "./api";
import {
  AskIcon,
  BusyLabel,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CodeIcon,
  EyeIcon,
  FolderPlusIcon,
  GlobeIcon,
  IndexingIcon,
  LogoutIcon,
  MaximizeIcon,
  MenuIcon,
  MinimizeIcon,
  MoonIcon,
  MoreIcon,
  PanelToggleIcon,
  PencilIcon,
  PlusIcon,
  PrintIcon,
  RefreshIcon,
  SaveIcon,
  SearchIcon,
  SettingsIcon,
  SortIcon,
  SpinnerIcon,
  SunIcon,
  TrashIcon
} from "./icons";
import { useLocale, useT } from "./i18n";
import type { TKey } from "./i18n";
import { CopilotView } from "./CopilotView";
import { FolderPicker } from "./FolderPicker";
import type { MuyaMarkdownEditorHandle } from "./MuyaMarkdownEditor";
import { SettingsView } from "./SettingsView";
import type { UserRole } from "../shared/types";

function importMuyaMarkdownEditor() {
  return import("./MuyaMarkdownEditor").then((module) => ({ default: module.MuyaMarkdownEditor }));
}

function importMarkdownSourceEditor() {
  return import("./MarkdownSourceEditor").then((module) => ({ default: module.MarkdownSourceEditor }));
}

let muyaMarkdownEditorPromise: ReturnType<typeof importMuyaMarkdownEditor> | null = null;
let markdownSourceEditorPromise: ReturnType<typeof importMarkdownSourceEditor> | null = null;

function loadMuyaMarkdownEditor() {
  muyaMarkdownEditorPromise ??= importMuyaMarkdownEditor();
  return muyaMarkdownEditorPromise;
}

function loadMarkdownSourceEditor() {
  markdownSourceEditorPromise ??= importMarkdownSourceEditor();
  return markdownSourceEditorPromise;
}

const MuyaMarkdownEditor = lazy(loadMuyaMarkdownEditor);
const MarkdownSourceEditor = lazy(loadMarkdownSourceEditor);

export function preloadMuyaEditorBundle(): void {
  void loadMuyaMarkdownEditor();
}

type MobileSection = "vault" | "editor" | "ask";
type AppView = "workspace" | "indexing" | "settings";
type SettingsModalMode = "indexing" | "settings";
type EditKind = "wysiwyg" | "source";

interface DocumentsViewProps {
  currentView?: AppView;
  theme?: "dark" | "light";
  loggingOut?: boolean;
  // The current account's username, threaded down so per-user
  // client state (e.g. cached Copilot answer) can be isolated
  // and not bleed between users on the same browser.
  username?: string;
  // Account role; needed so the settings modal can hide admin-
  // only sections for regular users.
  role?: UserRole;
  onSwitchView?: (view: AppView) => void;
  onToggleTheme?: () => void;
  onLogout?: () => void;
}

// Best-effort haptic feedback. Works on Android browsers; no-op on iOS
// Safari and on devices without a vibration motor. Honors prefers-
// reduced-motion as an opt-out signal because users who disable
// motion typically want fewer secondary effects.
function haptic(pattern: number | number[] = 8): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  }
  try {
    navigator.vibrate(pattern);
  } catch {
    // ignore
  }
}

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(max-width: 860px)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia("(max-width: 860px)");
    const handler = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handler);
      return () => mql.removeEventListener("change", handler);
    }
    mql.addListener(handler);
    return () => mql.removeListener(handler);
  }, []);

  return isMobile;
}

interface TreeNode {
  id: string;
  name: string;
  type: "folder" | "document";
  document?: DocumentSummary;
  children: TreeNode[];
  order: number;
}

type OpenTab = DocumentContent & {
  draft: string;
  // Quick-capture buffer that has not been saved to disk yet. The
  // path on the OpenTab is a temporary client-side id (see
  // makeDraftPath); on save we derive the real name and swap the tab.
  isDraft?: boolean;
  // Per-tab edit/preview mode. Existing files open in "preview"
  // by default so the reader sees the rendered note immediately;
  // drafts and freshly created notes start in "edit" because a
  // blank preview is useless. Switching modes only affects the
  // active tab.
  mode: "edit" | "preview";
  editKind: EditKind;
};

type PreviewSnapshot = {
  path: string;
  draft: string;
  isDraft: boolean;
  html: string;
};

type PreviewLinkError = {
  target: string;
  message: string;
};

type VaultAssetLink = {
  path: string;
  name: string;
  contentType: string;
  url: string;
};

const sortStorageKey = "owd_document_sort";

// File-segment sanitizer: keep letters/digits/space/hyphen/underscore/CJK,
// collapse whitespace, trim, and cap length so the resulting file name is
// safe across macOS/Linux/Windows and inside the vault path validator.
function sanitizeFileSegment(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/g, "");
}

// Pick a human-friendly name from quick-note content: prefer the first
// markdown heading, then the first non-empty line, then "" so the caller
// can fall back to a timestamp.
function deriveQuickNoteName(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  const headingMatch = trimmed.match(/^\s*#{1,6}\s+(.+?)\s*$/m);
  if (headingMatch && headingMatch[1].trim()) {
    return headingMatch[1].trim();
  }
  const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim().length > 0);
  return firstLine ? firstLine.trim() : "";
}

// Local timestamp formatted as YYYY-MM-DD HH-mm so it sorts naturally
// and is filesystem-safe.
function formatTimestamp(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

// Synthetic, client-only path used as the unique id of an unsaved
// quick-capture buffer. The "__draft__/" prefix is intentionally not
// a valid vault folder so we can never confuse a draft tab with a
// real document.
function makeDraftPath(): string {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return `__draft__/quick-${stamp}.md`;
}

function isDraftPath(value: string): boolean {
  return value.startsWith("__draft__/");
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

// Returns the folder portion of a vault-relative file path (without
// trailing slash). Returns "" for files at the vault root, drafts, or
// empty input.
function parentFolderOf(documentPath: string): string {
  if (!documentPath || isDraftPath(documentPath)) return "";
  const lastSlash = documentPath.lastIndexOf("/");
  return lastSlash > 0 ? documentPath.slice(0, lastSlash) : "";
}

const PREVIEW_ASSET_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpeg", ".jpg", ".pdf", ".png", ".svg", ".webp"]);

function decodePreviewLinkTarget(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function extensionOfPreviewTarget(value: string): string {
  const clean = value.split("#")[0].split("?")[0].trim();
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  const name = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function isPreviewAssetTarget(value: string): boolean {
  return PREVIEW_ASSET_EXTENSIONS.has(extensionOfPreviewTarget(value));
}

function isPreviewDocumentTarget(value: string): boolean {
  const extension = extensionOfPreviewTarget(value);
  return extension === "" || extension === ".md";
}

function previewTargetFromHref(rawHref: string): string | null {
  const href = rawHref.trim();
  if (!href || href.startsWith("#") || href.startsWith("//") || href.startsWith("/api/")) return null;

  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    try {
      const parsed = new URL(href);
      if (typeof window === "undefined" || parsed.origin !== window.location.origin || parsed.pathname.startsWith("/api/")) {
        return null;
      }
      return decodePreviewLinkTarget(`${parsed.pathname.replace(/^\/+/, "")}${parsed.search}${parsed.hash}`);
    } catch {
      return null;
    }
  }

  return decodePreviewLinkTarget(href.replace(/^\/+/, ""));
}

function folderRefreshTargetsForChangedPaths(paths: string[]): string[] {
  const targets = new Set<string>([""]);
  for (const path of paths) {
    const folderPath = parentFolderOf(path);
    if (!folderPath) continue;
    const parts = folderPath.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      targets.add(current);
    }
  }
  return Array.from(targets);
}

async function waitForPrintableAssets(doc: Document): Promise<void> {
  const stylesheetReady = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')).map(
    (link) =>
      link.sheet
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            link.addEventListener("load", () => resolve(), { once: true });
            link.addEventListener("error", () => resolve(), { once: true });
          })
  );
  const fonts = (doc as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
  const fontReady = fonts?.ready?.catch(() => undefined) ?? Promise.resolve();
  const imageReady = Array.from(doc.images)
    .filter((image) => !image.complete)
    .map(
      (image) =>
        new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        })
    );
  await Promise.race([
    Promise.all([...stylesheetReady, fontReady, ...imageReady]).then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, 1500))
  ]);
}

function isMobilePrintEnvironment(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  const ua = navigator.userAgent;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && window.matchMedia("(max-width: 860px)").matches);
}

async function printRenderedPreviewHtml(html: string, title: string): Promise<void> {
  const surface = document.createElement("div");
  surface.className = "print-surface active-print-surface";
  surface.setAttribute("aria-hidden", "true");
  surface.setAttribute("title", title);
  surface.innerHTML = `<article>${html}</article>`;

  const previousTitle = document.title;
  const previousPrintMode = document.body.dataset.printMode;
  let cleaned = false;
  let printRequestedAt = 0;
  const mobilePrint = isMobilePrintEnvironment();
  const minimumHoldMs = mobilePrint ? 12000 : 250;
  let cleanupTimer = 0;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (cleanupTimer) window.clearTimeout(cleanupTimer);
    surface.remove();
    if (previousPrintMode === undefined) {
      delete document.body.dataset.printMode;
    } else {
      document.body.dataset.printMode = previousPrintMode;
    }
    document.title = previousTitle;
    window.removeEventListener("afterprint", scheduleCleanup);
  };
  const scheduleCleanup = () => {
    if (cleaned) return;
    const elapsed = printRequestedAt ? Date.now() - printRequestedAt : 0;
    const delay = Math.max(0, minimumHoldMs - elapsed);
    if (cleanupTimer) window.clearTimeout(cleanupTimer);
    cleanupTimer = window.setTimeout(cleanup, delay);
  };

  document.body.dataset.printMode = "active";
  document.title = title;
  document.body.appendChild(surface);
  window.addEventListener("afterprint", scheduleCleanup);

  try {
    if (mobilePrint) {
      // Keep the native print call as close as possible to the tap.
      // Mobile browsers are strict about user activation; waiting for
      // timers/asset loads can make window.print() a no-op.
      surface.getBoundingClientRect();
    } else {
      await waitForPrintableAssets(document);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    window.focus();
    printRequestedAt = Date.now();
    window.print();
  } catch (error) {
    cleanup();
    throw error;
  }
  window.setTimeout(cleanup, 60000);
}

// Default path for the New Note prompt. We pre-fill the dialog with
// the user's selected folder so a new note lands where they're
// looking. Selected folder comes from (in order): an explicit folder
// tap in the tree, the parent folder of the active document, or the
// vault root.
function defaultNewNotePath(selectedFolder: string): string {
  return selectedFolder ? `${selectedFolder}/Untitled.md` : "Untitled.md";
}

function readSavedSort(): { sort: SortField; order: SortOrder } {
  const fallback: { sort: SortField; order: SortOrder } = { sort: "updatedAt", order: "desc" };
  try {
    const raw = localStorage.getItem(sortStorageKey);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as { sort?: SortField; order?: SortOrder };
    const sort: SortField = ["name", "createdAt", "updatedAt", "path", "title"].includes(saved.sort ?? "")
      ? saved.sort!
      : fallback.sort;
    const order: SortOrder = saved.order === "asc" || saved.order === "desc" ? saved.order : fallback.order;
    return { sort, order };
  } catch {
    return fallback;
  }
}

function summaryFromContent(content: DocumentContent): DocumentSummary {
  const { content: _content, frontmatter: _frontmatter, links: _links, ...summary } = content;
  return summary;
}

function compareDocumentsBy(sort: SortField, order: SortOrder) {
  const factor = order === "asc" ? 1 : -1;
  return (a: DocumentSummary, b: DocumentSummary) => {
    const aValue = a[sort] ?? "";
    const bValue = b[sort] ?? "";
    const primary = String(aValue).localeCompare(String(bValue));
    if (primary !== 0) return primary * factor;
    return a.path.localeCompare(b.path);
  };
}

// Synthesize a minimal DocumentSummary for a file entry whose
// metadata listing hasn't loaded yet. Only path + name are read
// by the tree row; the rest stays empty until the metadata fetch
// catches up.
function synthSummary(entry: DocumentTreeEntry): DocumentSummary {
  return {
    path: entry.path,
    name: entry.name,
    title: entry.name.replace(/\.md$/i, ""),
    createdAt: entry.updatedAt ?? "",
    updatedAt: entry.updatedAt ?? "",
    hash: "",
    tags: [],
    aliases: [],
    headings: []
  };
}

type StatusValue =
  | { kind: "key"; key: TKey; params?: Record<string, string | number> }
  | { kind: "text"; text: string };

const READY_STATUS: StatusValue = { kind: "key", key: "status.ready" };

export function DocumentsView(props: DocumentsViewProps = {}) {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const savedSort = useMemo(readSavedSort, []);
  const isMobile = useIsMobile();
  const [mobileSection, setMobileSection] = useState<MobileSection>("vault");
  const [muyaEditorReady, setMuyaEditorReady] = useState(false);
  const muyaEditorReadyRef = useRef(false);
  useEffect(() => {
    void loadMuyaMarkdownEditor();
  }, []);
  // Zen / Focus mode: hides the global topbar, vault sidebar and
  // Copilot panel so the editor takes the entire window. Desktop
  // only -- the mobile UI is already editor-first.
  const zenStorageKey = `owd_zen_mode:${props.username ?? ""}`;
  const [zenMode, setZenMode] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return window.localStorage.getItem(zenStorageKey) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(zenStorageKey, zenMode ? "1" : "0"); } catch { /* ignore */ }
  }, [zenMode, zenStorageKey]);
  // On desktop, reflect zen state on <body> so CSS can hide the
  // chrome. Always clear the attribute on mobile so the mobile
  // layout is unaffected.
  useEffect(() => {
    const active = zenMode && !isMobile;
    document.body.dataset.zen = active ? "true" : "false";
    return () => { document.body.dataset.zen = "false"; };
  }, [zenMode, isMobile]);
  // Escape exits zen mode -- standard "leave fullscreen" gesture.
  useEffect(() => {
    if (!zenMode) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setZenMode(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zenMode]);
  // Switching users should reset zen state to whatever the new
  // user previously had (or off if they never enabled it).
  useEffect(() => {
    try {
      setZenMode(window.localStorage.getItem(zenStorageKey) === "1");
    } catch { /* ignore */ }
  }, [zenStorageKey]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [documentCount, setDocumentCount] = useState(0);
  // Lazy-loaded folder children keyed by vault-relative folder path
  // ("" for the vault root). A folder being absent from the map
  // means we haven't loaded its children yet; an empty array means
  // we have, and the folder is empty.
  const [folderChildren, setFolderChildren] = useState<Map<string, DocumentTreeEntry[]>>(new Map());
  // Folders whose children are currently being fetched. Used to show
  // an inline spinner under the expand row.
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState("");
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const tabsRef = useRef<OpenTab[]>([]);
  const activePathRef = useRef("");
  const [previewSnapshot, setPreviewSnapshot] = useState<PreviewSnapshot | null>(null);
  const previewCacheRef = useRef<Map<string, PreviewSnapshot>>(new Map());
  const previewRequestSeq = useRef(0);
  const [sort, setSort] = useState<SortField>(savedSort.sort);
  const [order, setOrder] = useState<SortOrder>(savedSort.order);
  const [status, setStatus] = useState<StatusValue>(READY_STATUS);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [selectedFolder, setSelectedFolder] = useState<string>("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DocumentSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchHasRun, setSearchHasRun] = useState(false);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);
  // Tree row context menu (right-click on desktop, long-press on
  // mobile). Position is the viewport coordinate to anchor the
  // menu to; the menu component clamps itself inside the
  // viewport to avoid clipping at the edges.
  type TreeNodeTarget = { type: "file" | "folder"; path: string; name: string };
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; node: TreeNodeTarget } | null>(null);
  const openNodeMenu = useCallback((node: TreeNodeTarget, x: number, y: number) => {
    haptic(8);
    setNodeMenu({ node, x, y });
  }, []);
  const closeNodeMenu = useCallback(() => {
    setNodeMenu(null);
  }, []);

  // Drop-target tracking. `dragOverPath` is the folder currently
  // hovered with a draggable file/folder; CSS uses it to
  // highlight the drop target.
  const [dragSource, setDragSource] = useState<TreeNodeTarget | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);

  // Unified dialog state. Each kind is a destructive or
  // structural file-system action; `target` tells the dialog
  // what to operate on (the active document by default, or any
  // node selected from a tree-row context menu).
  type DialogState =
    | null
    | { kind: "createNote"; defaultFolder: string }
    | { kind: "createFolder"; defaultFolder: string }
    // Rename keeps the folder, only changes the basename.
    | { kind: "rename"; type: "file" | "folder"; path: string; name: string }
    // Move keeps the basename, only changes the parent folder.
    | { kind: "move"; type: "file" | "folder"; path: string; name: string }
    | { kind: "delete"; type: "file" | "folder"; path: string; name: string }
    // Confirm step shown when delete-folder hits a non-empty
    // server response. We surface the file count so the user
    // knows what they're throwing away.
    | { kind: "deleteFolderConfirm"; path: string; name: string; fileCount: number };
  const [dialog, setDialog] = useState<DialogState>(null);
  const [previewLinkError, setPreviewLinkError] = useState<PreviewLinkError | null>(null);
  function openCreateNote(defaultFolder?: string) {
    setDialog({ kind: "createNote", defaultFolder: defaultFolder ?? "" });
  }
  function openCreateFolder(defaultFolder?: string) {
    setDialog({ kind: "createFolder", defaultFolder: defaultFolder ?? "" });
  }
  function openRename(target: { type: "file" | "folder"; path: string; name: string }) {
    setDialog({ kind: "rename", ...target });
  }
  function openMove(target: { type: "file" | "folder"; path: string; name: string }) {
    setDialog({ kind: "move", ...target });
  }
  function openDelete(target: { type: "file" | "folder"; path: string; name: string }) {
    setDialog({ kind: "delete", ...target });
  }
  function closeDialog() {
    setDialog(null);
  }
  const [saving, setSaving] = useState(false);
  const [vaultTreeRefreshing, setVaultTreeRefreshing] = useState(false);
  const [sortSheetOpen, setSortSheetOpen] = useState(false);
  const [commandSheetOpen, setCommandSheetOpen] = useState(false);
  const [commandMenuAnchor, setCommandMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  // Desktop settings / indexing are now rendered as overlay
  // modals on top of the workspace instead of replacing the
  // entire main content. That way the user can dismiss the
  // modal and immediately return to the editor + tree without
  // a navigation step. Mobile keeps using full-view switching
  // because a tiny screen makes a centered modal unusable.
  const [settingsModalMode, setSettingsModalMode] = useState<SettingsModalMode | null>(null);

  function closeCommandMenu() {
    setCommandSheetOpen(false);
    setCommandMenuAnchor(null);
  }

  function openCommandMenu(event: ReactMouseEvent<HTMLButtonElement>) {
    if (isMobile) {
      setCommandMenuAnchor(null);
    } else {
      const rect = event.currentTarget.getBoundingClientRect();
      setCommandMenuAnchor({ x: rect.right, y: rect.bottom + 6 });
    }
    setCommandSheetOpen(true);
  }

  // Desktop side-panel collapse state. Both panels can be tucked
  // away into 44px rails so the editor takes the full width.
  // Persisted in localStorage so the layout survives reloads. The
  // mobile path ignores these flags entirely (mobile has its own
  // section switcher and the panels live in drawers/sheets).
  const [vaultCollapsed, setVaultCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("owd_vault_collapsed") === "true";
  });
  const [copilotCollapsed, setCopilotCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return (
      window.localStorage.getItem("owd_copilot_collapsed") ??
      window.localStorage.getItem("owd_qa_collapsed")
    ) === "true";
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("owd_vault_collapsed", String(vaultCollapsed));
    } catch {
      /* no-op: private mode / quota */
    }
  }, [vaultCollapsed]);
  useEffect(() => {
    try {
      window.localStorage.setItem("owd_copilot_collapsed", String(copilotCollapsed));
      window.localStorage.removeItem("owd_qa_collapsed");
    } catch {
      /* no-op */
    }
  }, [copilotCollapsed]);

  // On mobile we default to the editor as the always-visible main view;
  // the vault is a left drawer and Ask is a bottom sheet.
  useEffect(() => {
    if (isMobile && mobileSection !== "editor") {
      // Snap the implicit default to editor so re-entering the workspace
      // doesn't dump the user back into the file list.
      setMobileSection("editor");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);

  // Close transient menus when the viewport crosses the mobile
  // breakpoint. The sort sheet is shared with desktop so it stays
  // open across the flip; the command menu changes presentation.
  useEffect(() => {
    setCommandSheetOpen(false);
    setCommandMenuAnchor(null);
  }, [isMobile]);

  // Whenever the layout flips to mobile, drop the desktop-only
  // settings modal so we don't leave a centered floating panel
  // sitting on top of the small-screen layout.
  useEffect(() => {
    if (isMobile) setSettingsModalMode(null);
  }, [isMobile]);

  // While the settings modal is open: (1) Escape dismisses, (2)
  // we lock <body> scroll so wheel/touch on the backdrop won't
  // pan the underlying workspace, (3) we capture the previously
  // focused element and restore focus on close so keyboard
  // users land back on the More button that opened the dialog,
  // and (4) we trap Tab/Shift-Tab inside the dialog so keyboard
  // navigation can never leak back to the workspace behind it.
  const settingsModalRef = useRef<HTMLElement | null>(null);
  const settingsBodyRef = useRef<HTMLDivElement | null>(null);
  const settingsHeaderRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!settingsModalMode) return;
    // Wire a tiny scroll listener so the header gains a hairline
    // shadow once the body content has scrolled past the top edge.
    // Reflects the scroll position with a single rAF-throttled
    // attribute write so the work stays cheap even on long
    // settings pages.
    const body = settingsBodyRef.current;
    const header = settingsHeaderRef.current;
    let scrollRaf = 0;
    function syncScrolled() {
      if (!body || !header) return;
      const scrolled = body.scrollTop > 1;
      if ((header.dataset.scrolled === "true") !== scrolled) {
        header.dataset.scrolled = scrolled ? "true" : "false";
      }
    }
    function onScroll() {
      if (scrollRaf) return;
      scrollRaf = window.requestAnimationFrame(() => {
        scrollRaf = 0;
        syncScrolled();
      });
    }
    body?.addEventListener("scroll", onScroll, { passive: true });
    syncScrolled();
    const previousActive = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Selector matches every visible, non-disabled element a
    // sighted keyboard user can land on. The :not([tabindex="-1"])
    // suffix lets us mark sub-trees opt-out (e.g. the collapsed
    // pane rail buttons mirror the semantically-active one).
    const focusableSelector = [
      'a[href]:not([tabindex="-1"])',
      'button:not([disabled]):not([tabindex="-1"])',
      'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"])',
      'select:not([disabled]):not([tabindex="-1"])',
      'textarea:not([disabled]):not([tabindex="-1"])',
      '[tabindex]:not([tabindex="-1"])',
      '[contenteditable]:not([tabindex="-1"])'
    ].join(",");

    function getFocusable(): HTMLElement[] {
      const node = settingsModalRef.current;
      if (!node) return [];
      return Array.from(node.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (el) => !el.hasAttribute("disabled") && el.offsetParent !== null
      );
    }

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSettingsModalMode(null);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const node = settingsModalRef.current;
      // If focus somehow escaped the dialog, pull it back to the
      // first element.
      if (!node || !active || !node.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);

    // Move keyboard focus into the modal so screen reader / tab
    // navigation start inside the dialog, not behind it.
    const focusTimer = window.setTimeout(() => {
      const node = settingsModalRef.current;
      if (!node) return;
      const target = node.querySelector<HTMLElement>(
        '[data-autofocus], button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
      );
      target?.focus();
    }, 0);

    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(focusTimer);
      body?.removeEventListener("scroll", onScroll);
      if (scrollRaf) window.cancelAnimationFrame(scrollRaf);
      document.body.style.overflow = previousOverflow;
      previousActive?.focus?.();
    };
  }, [settingsModalMode]);

  // Escape closes the command sheet.
  useEffect(() => {
    if (!commandSheetOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeCommandMenu();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [commandSheetOpen]);

  // Global quick-note triggers: window event (used by the desktop topbar
  // button) and a keyboard shortcut (Cmd/Ctrl + Shift + N). Both spawn
  // a fresh draft tab in the editor instead of opening a separate
  // capture window.
  //
  // Cmd/Ctrl + S is also wired here. The desktop editor toolbar no
  // longer has an always-visible Save button (Save lives in the file
  // overflow menu), so the keyboard shortcut is the primary explicit
  // save affordance for power users. Auto-save every ~5s remains the
  // implicit safety net. We read the latest save/active/saving via
  // a ref (kept up to date below where save() is defined) so the
  // listener can be bound once.
  const saveRef = useRef<{ save: () => Promise<void>; canSave: boolean }>({
    save: async () => undefined,
    canSave: false
  });
  useEffect(() => {
    function open() {
      createQuickNoteDraft();
    }
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        createQuickNoteDraft();
        return;
      }
      if (!event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        const current = saveRef.current;
        if (current.canSave) void current.save();
        return;
      }
    }
    window.addEventListener("owd:quick-note", open);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("owd:quick-note", open);
      window.removeEventListener("keydown", onKey);
    };
    // createQuickNoteDraft uses closures over isMobile/locale/etc.,
    // we want the latest version each time but we don't want to rebind
    // listeners on every render either; rebind only when dependencies
    // that change rarely flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, locale]);
  // The tree always renders from the lazy folder map. We rebuild
  // it whenever children of any folder change. The /api/documents
  // metadata listing (`documents`) is no longer the source of the
  // visible structure; it's only used for the file count and
  // anywhere a real DocumentSummary is needed (e.g. open document).
  const documentsByPath = useMemo(() => {
    const map = new Map<string, DocumentSummary>();
    documents.forEach((doc) => map.set(doc.path, doc));
    return map;
  }, [documents]);

  const documentTree = useMemo(() => {
    function nodesForFolder(folderPath: string): TreeNode[] {
      const entries = folderChildren.get(folderPath);
      if (!entries) return [];
      return entries.map((entry, order) => {
        if (entry.type === "folder") {
          return {
            id: entry.path,
            name: entry.name,
            type: "folder",
            children: nodesForFolder(entry.path),
            order: 0
          } satisfies TreeNode;
        }
        const realSummary = documentsByPath.get(entry.path);
        return {
          id: entry.path,
          name: entry.name,
          type: "document",
          document: realSummary ?? synthSummary(entry),
          children: [],
          order
        } satisfies TreeNode;
      });
    }
    return nodesForFolder("");
  }, [folderChildren, documentsByPath]);
  const active = tabs.find((tab) => tab.path === activePath) ?? null;
  // Edit/preview state lives on each tab. When no tab is open we
  // still need a default so the toolbar renders sensibly; preview
  // matches the new "open notes in preview" behavior.
  const centerMode: "edit" | "preview" = active?.mode ?? "preview";
  const activeEditKind: EditKind = active?.editKind ?? "wysiwyg";
  const editKindTarget: EditKind = centerMode === "edit" && activeEditKind === "source" ? "wysiwyg" : "source";

  const openDocument = useCallback(
    (path: string) => {
      setActivePath(path);
      setSelectedFolder(parentFolderOf(path));
      if (isMobile) {
        haptic(6);
        setMobileSection("editor");
      }
    },
    [isMobile]
  );

  const switchSection = useCallback((next: MobileSection) => {
    setMobileSection((current) => {
      if (current !== next) haptic(6);
      return next;
    });
  }, []);

  const closeOverlays = useCallback(() => {
    setMobileSection("editor");
  }, []);

  // Undo support for destructive actions. We keep at most one pending
  // undo action, with a timeout to auto-dismiss.
  type PendingUndo =
    | { kind: "close-tab"; tab: OpenTab; wasActive: boolean; label: string }
    | { kind: "delete-document"; path: string; content: string; label: string };
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);
  const undoTimer = useRef<number | null>(null);
  const undoTtlMs = 6000;

  const dismissUndo = useCallback(() => {
    if (undoTimer.current != null) {
      window.clearTimeout(undoTimer.current);
      undoTimer.current = null;
    }
    setPendingUndo(null);
  }, []);

  const offerUndo = useCallback((action: PendingUndo) => {
    setPendingUndo(action);
    if (undoTimer.current != null) {
      window.clearTimeout(undoTimer.current);
    }
    undoTimer.current = window.setTimeout(() => {
      setPendingUndo(null);
      undoTimer.current = null;
    }, undoTtlMs);
  }, []);

  // Shake-to-undo (best effort: requires DeviceMotion permission on iOS).
  // We attach a one-shot tap-to-enable button if permission is required;
  // when permission is granted (or motion events arrive without a prompt
  // on Android), a strong shake triggers the most recent undo.
  const lastShakeAt = useRef(0);
  useEffect(() => {
    if (!isMobile || typeof window === "undefined") return;
    function handleMotion(event: DeviceMotionEvent) {
      const acc = event.accelerationIncludingGravity ?? event.acceleration;
      if (!acc) return;
      const magnitude = Math.sqrt((acc.x ?? 0) ** 2 + (acc.y ?? 0) ** 2 + (acc.z ?? 0) ** 2);
      if (magnitude < 28) return;
      const now = Date.now();
      if (now - lastShakeAt.current < 1200) return;
      lastShakeAt.current = now;
      if (pendingUndo) {
        performUndo();
      }
    }
    window.addEventListener("devicemotion", handleMotion);
    return () => window.removeEventListener("devicemotion", handleMotion);
    // performUndo and pendingUndo are referenced via closure; we want a
    // listener that always sees the latest state, so we re-attach when
    // these change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, pendingUndo]);

  const muyaEditorRef = useRef<MuyaMarkdownEditorHandle | null>(null);

  // Muya captures image paste events and asks this app to persist the
  // bytes in the current user's vault. The returned Obsidian embed is
  // inserted at Muya's current selection by the wrapper.
  async function uploadPastedImage(file: File): Promise<string> {
    setStatusKey("status.uploading");
    try {
      const buffer = await file.arrayBuffer();
      const params = new URLSearchParams({ type: file.type });
      if (file.name) params.set("name", file.name);
      const result = await api<{ path: string }>(`/api/documents/attachments?${params.toString()}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: buffer
      });
      setStatusKey("status.attachmentSaved");
      return `![[${result.path}]]`;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      setStatusText(`${t("status.uploadFailed")}: ${message}`);
      return `<!-- attachment upload failed: ${message.replace(/-->/g, "")} -->`;
    }
  }

  // Edge-swipe between workspace panes on mobile. A swipe that starts
  // within ~26px of either edge and travels >= 60px horizontally cycles
  // between Vault, Editor, and Ask.
  const edgeSwipe = useRef<{ startX: number; startY: number; fromEdge: "left" | "right" } | null>(null);
  function onWorkspacePointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (!isMobile || event.pointerType === "mouse") return;
    if (searchOpen) return;
    const width = window.innerWidth || document.documentElement.clientWidth;
    const x = event.clientX;
    const y = event.clientY;
    if (x <= 26) {
      edgeSwipe.current = { startX: x, startY: y, fromEdge: "left" };
    } else if (x >= width - 26) {
      edgeSwipe.current = { startX: x, startY: y, fromEdge: "right" };
    } else {
      edgeSwipe.current = null;
    }
  }
  function onWorkspacePointerUp(event: ReactPointerEvent<HTMLElement>) {
    const start = edgeSwipe.current;
    edgeSwipe.current = null;
    if (!start) return;
    const dx = event.clientX - start.startX;
    const dy = Math.abs(event.clientY - start.startY);
    if (dy > 60) return;
    // Editor-first model on mobile:
    //   swipe right from the left edge -> open vault drawer
    //   swipe left  from the right edge -> open Copilot sheet
    if (start.fromEdge === "left" && dx >= 60) {
      switchSection("vault");
    } else if (start.fromEdge === "right" && dx <= -60) {
      switchSection("ask");
    }
  }

  // Pull-to-search on the vault pane: when the document tree is already
  // scrolled to the top and the user pulls down, we open the search modal.
  const pullStartY = useRef<number | null>(null);
  const pullStartScrollTop = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  const pullThreshold = 72;
  const vaultScrollRef = useRef<HTMLDivElement | null>(null);
  const [vaultScrolled, setVaultScrolled] = useState(false);

  function onVaultScroll(event: React.UIEvent<HTMLDivElement>) {
    const top = event.currentTarget.scrollTop;
    setVaultScrolled((current) => (top > 220 ? true : top < 60 ? false : current));
  }

  function scrollVaultToTop() {
    const node = vaultScrollRef.current;
    if (!node) return;
    haptic(4);
    if (typeof node.scrollTo === "function") {
      node.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      node.scrollTop = 0;
    }
  }

  function onVaultTouchStart(event: React.TouchEvent<HTMLDivElement>) {
    if (!isMobile || event.touches.length !== 1) {
      pullStartY.current = null;
      return;
    }
    const target = event.currentTarget;
    pullStartScrollTop.current = target.scrollTop;
    pullStartY.current = event.touches[0].clientY;
    setPullDistance(0);
  }

  function onVaultTouchMove(event: React.TouchEvent<HTMLDivElement>) {
    if (!isMobile || pullStartY.current == null) return;
    if (pullStartScrollTop.current > 0) {
      pullStartY.current = null;
      setPullDistance(0);
      return;
    }
    const dy = event.touches[0].clientY - pullStartY.current;
    if (dy <= 0) {
      setPullDistance(0);
      return;
    }
    const next = Math.min(dy, pullThreshold * 1.6);
    setPullDistance((prev) => {
      if (prev < pullThreshold && next >= pullThreshold) haptic(4);
      return next;
    });
  }

  function onVaultTouchEnd() {
    if (!isMobile || pullStartY.current == null) {
      setPullDistance(0);
      return;
    }
    const dist = pullDistance;
    pullStartY.current = null;
    setPullDistance(0);
    if (dist >= pullThreshold) {
      haptic(10);
      closeOverlays();
      setSearchOpen(true);
    }
  }

  // Ref-backed deduplication for folder fetches. React state
  // (folderChildren / loadingFolders) drives the UI, but rapidly
  // fired prefetch calls all read the same render-time state and
  // would dispatch duplicate fetches. The ref reflects the
  // most-up-to-date view of "already loaded or in flight" without
  // waiting for a re-render. inFlight stores the actual Promise
  // so a foreground call landing during a background prefetch can
  // attach to it and show the spinner until it resolves.
  const folderFetchTracker = useRef({
    loaded: new Set<string>(),
    inFlight: new Map<string, Promise<DocumentTreeEntry[] | null>>(),
    generation: 0
  });
  const pendingFolderWarmup = useRef<{
    rootChildren: DocumentTreeEntry[];
    sort: SortField;
    order: SortOrder;
    generation: number;
  } | null>(null);
  const pendingDocumentCountRefresh = useRef(false);

  const handleMuyaEditorReady = useCallback(() => {
    if (muyaEditorReadyRef.current) return;
    muyaEditorReadyRef.current = true;
    window.performance?.mark?.("owd:muya-editor-ready");
    window.dispatchEvent(new CustomEvent("owd:muya-editor-ready"));
    setMuyaEditorReady(true);
  }, []);

  const loadFolderChildren = useCallback(async function loadFolderChildren(
    folderPath: string,
    options: { force?: boolean; silent?: boolean; sort?: SortField; order?: SortOrder } = {}
  ): Promise<DocumentTreeEntry[] | null> {
    const tracker = folderFetchTracker.current;
    if (!options.force && tracker.loaded.has(folderPath)) {
      return folderChildren.get(folderPath) ?? null;
    }
    const existing = tracker.inFlight.get(folderPath);
    if (existing) {
      // If a background prefetch is already loading this folder
      // and the user just expanded it, show the spinner until the
      // existing promise resolves rather than firing a duplicate.
      if (!options.silent) {
        setLoadingFolders((current) => {
          if (current.has(folderPath)) return current;
          const next = new Set(current);
          next.add(folderPath);
          return next;
        });
        existing.finally(() => {
          setLoadingFolders((current) => {
            if (!current.has(folderPath)) return current;
            const next = new Set(current);
            next.delete(folderPath);
            return next;
          });
        });
      }
      return existing;
    }

    const generation = tracker.generation;
    // Background prefetch passes silent=true so it doesn't paint a
    // spinner on every folder in the tree while it warms the cache.
    if (!options.silent) {
      setLoadingFolders((current) => {
        if (current.has(folderPath)) return current;
        const next = new Set(current);
        next.add(folderPath);
        return next;
      });
    }
    const promise = (async (): Promise<DocumentTreeEntry[] | null> => {
      try {
        const params = new URLSearchParams();
        if (folderPath) params.set("path", folderPath);
        const effectiveSort = options.sort ?? sort;
        const effectiveOrder = options.order ?? order;
        const treeSort: "name" | "updatedAt" = effectiveSort === "updatedAt" ? "updatedAt" : "name";
        params.set("sort", treeSort);
        params.set("order", effectiveOrder);
        const data = await api<DocumentTreeEntry>(`/api/documents/tree?${params.toString()}`);
        if (folderFetchTracker.current.generation !== generation) return null;
        const children = data.children ?? [];
        tracker.loaded.add(folderPath);
        setFolderChildren((current) => {
          const next = new Map(current);
          next.set(folderPath, children);
          return next;
        });
        return children;
      } catch {
        return null;
      } finally {
        tracker.inFlight.delete(folderPath);
        if (!options.silent) {
          setLoadingFolders((current) => {
            if (!current.has(folderPath)) return current;
            const next = new Set(current);
            next.delete(folderPath);
            return next;
          });
        }
      }
    })();
    tracker.inFlight.set(folderPath, promise);
    return promise;
  }, [folderChildren, order, sort]);

  // Recursive background prefetch with a small concurrency cap. This
  // only runs after Muya has reported ready, so startup keeps the
  // editor path first while later folder expands are warmed.
  const prefetchFolderTree = useCallback(async function prefetchFolderTree(rootChildren: DocumentTreeEntry[], nextSort: SortField, nextOrder: SortOrder): Promise<void> {
    const tracker = folderFetchTracker.current;
    const generation = tracker.generation;
    const queue: string[] = rootChildren
      .filter((entry) => entry.type === "folder" && (entry.hasChildren ?? true))
      .map((entry) => entry.path);
    const concurrency = 2;
    const maxPrefetchFolders = 40;
    let prefetched = 0;

    async function processOne(): Promise<void> {
      if (tracker.generation !== generation) return;
      if (prefetched >= maxPrefetchFolders) return;
      const next = queue.shift();
      if (!next) return;
      if (tracker.loaded.has(next) || tracker.inFlight.has(next)) {
        return processOne();
      }
      prefetched += 1;
      const fetched = await loadFolderChildren(next, { silent: true, sort: nextSort, order: nextOrder });
      if (tracker.generation !== generation) return;
      if (fetched) {
        for (const child of fetched) {
          if (child.type === "folder" && (child.hasChildren ?? true)) {
            queue.push(child.path);
          }
        }
      }
      await new Promise<void>((resolve) => {
        const ric = (window as typeof window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
        if (typeof ric === "function") ric(() => resolve(), { timeout: 250 });
        else window.setTimeout(resolve, 30);
      });
      if (tracker.generation !== generation) return;
      return processOne();
    }

    const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) workers.push(processOne());
    await Promise.all(workers);
  }, [loadFolderChildren]);

  async function refreshDocumentCount() {
    const result = await api<{ count: number }>("/api/documents/count");
    setDocumentCount(result.count);
  }

  async function refreshDocuments(nextSort = sort, nextOrder = order) {
    // Bumping the generation cancels any in-flight prefetch from a
    // previous refresh: stale results are dropped on the floor and
    // prefetch loops exit at their next yield point.
    folderFetchTracker.current.generation += 1;
    folderFetchTracker.current.loaded.clear();
    folderFetchTracker.current.inFlight = new Map();
    pendingFolderWarmup.current = null;

    setFolderChildren(new Map());
    // Fetch only the root folder. Subfolders are loaded on first
    // expansion so startup never competes with a recursive tree walk.
    const rootChildren = await loadFolderChildren("", { force: true, sort: nextSort, order: nextOrder });
    if (rootChildren && rootChildren.length > 0) {
      const warmup = {
        rootChildren,
        sort: nextSort,
        order: nextOrder,
        generation: folderFetchTracker.current.generation
      };
      if (muyaEditorReadyRef.current) {
        void prefetchFolderTree(warmup.rootChildren, warmup.sort, warmup.order);
      } else {
        pendingFolderWarmup.current = warmup;
      }
    }
    // Keep startup cheap: the tree already returns the visible file
    // rows, and full /api/documents parses + hashes the whole vault.
    // For the sidebar count, use a lightweight recursive count. On
    // cold start, defer even that count until Muya is ready so the
    // editor activation does not compete with a vault walk.
    if (muyaEditorReadyRef.current) {
      await refreshDocumentCount();
    } else {
      pendingDocumentCountRefresh.current = true;
    }
  }

  useEffect(() => {
    if (!muyaEditorReady) return;
    if (pendingDocumentCountRefresh.current) {
      pendingDocumentCountRefresh.current = false;
      refreshDocumentCount().catch((error) => setStatusText(error.message));
    }
    const warmup = pendingFolderWarmup.current;
    if (!warmup) return;
    pendingFolderWarmup.current = null;
    if (folderFetchTracker.current.generation !== warmup.generation) return;
    void prefetchFolderTree(warmup.rootChildren, warmup.sort, warmup.order);
  }, [muyaEditorReady]);

  async function refreshFolders(paths: string[]) {
    const uniquePaths = Array.from(new Set(paths));
    // Cancel stale background prefetches without clearing the whole
    // lazy tree. A single file move only makes the old and new parent
    // folder listings stale, so reloading the full vault is unnecessary.
    folderFetchTracker.current.generation += 1;
    folderFetchTracker.current.inFlight = new Map();
    pendingFolderWarmup.current = null;
    uniquePaths.forEach((folderPath) => {
      folderFetchTracker.current.loaded.delete(folderPath);
    });
    await Promise.all(uniquePaths.map((folderPath) => loadFolderChildren(folderPath, { force: true, silent: true })));
  }

  async function refreshVaultPaths(paths: string[]) {
    const refreshTargets = folderRefreshTargetsForChangedPaths(paths);
    try {
      await refreshFolders(refreshTargets);
      await refreshDocumentCount();
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : t("vault.refresh"));
    }
  }

  async function refreshVaultTree() {
    if (vaultTreeRefreshing) return;
    setVaultTreeRefreshing(true);
    try {
      await refreshDocuments();
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : t("vault.refresh"));
    } finally {
      setVaultTreeRefreshing(false);
    }
  }

  function setStatusKey(key: TKey, params?: Record<string, string | number>) {
    setStatus({ kind: "key", key, params });
  }
  function setStatusText(text: string) {
    setStatus({ kind: "text", text });
  }

  // Render-friendly status string used for the toast/mobile chip.
  const statusLabel =
    status.kind === "key"
      ? status === READY_STATUS ? "" : t(status.key, status.params)
      : status.text;
  // A status ends with the ellipsis when it represents an in-flight
  // operation (Saving\u2026, Uploading\u2026 etc.). Those should stay
  // visible until the operation completes; transient statuses like
  // "Saved" or "Image saved to attachments" auto-fade after 2.5 s.
  const statusIsPending = statusLabel.endsWith("\u2026");

  useEffect(() => {
    if (!statusLabel || statusIsPending) return;
    const timer = window.setTimeout(() => setStatus(READY_STATUS), 2500);
    return () => window.clearTimeout(timer);
  }, [statusLabel, statusIsPending]);

  useEffect(() => {
    // Root tree is part of the first usable shell, so it may run in
    // parallel with Muya. Deeper folder warmup and recursive count
    // wait until the editor reports ready.
    refreshDocuments().catch((error) => setStatusText(error.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On first mount, if the user lands without anything open, spawn a
  // quick-note draft so the app opens directly into a writable
  // surface instead of a blank "Select a document" placeholder.
  const didSeedDraftRef = useRef(false);
  useEffect(() => {
    if (didSeedDraftRef.current) return;
    if (tabs.length > 0 || activePath) return;
    didSeedDraftRef.current = true;
    createQuickNoteDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activePath || tabs.some((tab) => tab.path === activePath)) {
      return;
    }
    if (isDraftPath(activePath)) {
      // Drafts are created with their tab already in place; if a draft
      // path becomes active without a tab, that means the tab was
      // closed and we should clear the active path.
      setActivePath("");
      return;
    }
    api<DocumentContent>(`/api/documents/content?path=${encodeURIComponent(activePath)}`)
      .then((doc) => {
        // Existing files open in preview mode by default. Newly
        // created notes and drafts install their tabs before this
        // effect runs, so they keep their explicit edit mode.
        setTabs((current) => [...current, { ...doc, draft: doc.content, mode: "preview", editKind: "wysiwyg" }]);
      })
      .catch((error) => setStatusText(error.message));
  }, [activePath, tabs]);

  const requestPreviewHtml = useCallback(
    async (content: string, path: string, isDraft: boolean | undefined, signal?: AbortSignal): Promise<string> => {
      const result = await api<{ html: string }>("/api/documents/preview", {
        method: "POST",
        signal,
        body: JSON.stringify({
          // Don't send a synthetic draft path to the server.
          path: isDraft ? undefined : path,
          content
        })
      });
      return result.html;
    },
    []
  );

  function previewCacheKey(path: string, isDraft?: boolean): string {
    return `${isDraft ? "draft" : "doc"}:${path}`;
  }

  function rememberPreviewSnapshot(snapshot: PreviewSnapshot): void {
    previewCacheRef.current.set(previewCacheKey(snapshot.path, snapshot.isDraft), snapshot);
  }

  function showPreviewSnapshot(snapshot: PreviewSnapshot): void {
    rememberPreviewSnapshot(snapshot);
    setPreviewSnapshot(snapshot);
  }

  function clearVisiblePreview(): void {
    setPreviewSnapshot(null);
  }

  function forgetPreviewSnapshot(path: string, isDraft?: boolean): void {
    previewCacheRef.current.delete(previewCacheKey(path, isDraft));
  }

  function cachedPreviewFor(tab: OpenTab | null): string | null {
    if (!tab) return null;
    const cached = previewCacheRef.current.get(previewCacheKey(tab.path, Boolean(tab.isDraft)));
    if (!cached) return null;
    return cached.path === tab.path &&
      cached.draft === tab.draft &&
      cached.isDraft === Boolean(tab.isDraft)
      ? cached.html
      : null;
  }

  // Re-render the preview whenever the draft text or active document
  // changes. We depend on the primitive draft string + path rather than
  // the active object itself so React's identity comparison is stable
  // and tied to the actual content the preview renders from.
  useEffect(() => {
    if (!muyaEditorReady) return;
    if (!active) {
      previewRequestSeq.current += 1;
      clearVisiblePreview();
      return;
    }

    const cachedHtml = cachedPreviewFor(active);
    if (cachedHtml) {
      setPreviewSnapshot({
        path: active.path,
        draft: active.draft,
        isDraft: Boolean(active.isDraft),
        html: cachedHtml
      });
      return;
    }

    const draft = active.draft;
    const isDraft = active.isDraft;
    const path = active.path;
    const requestSeq = ++previewRequestSeq.current;
    const controller = new AbortController();
    const renderPreview = () => {
      requestPreviewHtml(draft, path, isDraft, controller.signal)
        .then((html) => {
          if (requestSeq === previewRequestSeq.current) {
            showPreviewSnapshot({ path, draft, isDraft: Boolean(isDraft), html });
          }
        })
        .catch((error) => {
          if (isAbortError(error)) return;
          if (requestSeq === previewRequestSeq.current && centerMode === "preview") {
            forgetPreviewSnapshot(path, Boolean(isDraft));
            clearVisiblePreview();
          }
        });
    };

    let idleId: number | null = null;
    const win = window as typeof window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const timer = window.setTimeout(() => {
      if (centerMode === "preview" || typeof win.requestIdleCallback !== "function") {
        renderPreview();
        return;
      }
      idleId = win.requestIdleCallback(renderPreview, { timeout: 1500 });
    }, centerMode === "preview" ? 250 : 1000);

    if (centerMode === "preview") {
      clearVisiblePreview();
    }

    return () => {
      window.clearTimeout(timer);
      if (idleId !== null) {
        if (typeof win.cancelIdleCallback === "function") {
          win.cancelIdleCallback(idleId);
        } else {
          window.clearTimeout(idleId);
        }
      }
      controller.abort();
    };
  }, [muyaEditorReady, active?.draft, active?.path, active?.isDraft, centerMode, requestPreviewHtml]);

  // Mode is per-tab: switching Edit/Preview only affects the
  // currently active tab. Other open tabs keep whatever mode the
  // user left them in. No localStorage persistence: tab modes are
  // session state, not a user preference.
  function setActiveMode(nextMode: "edit" | "preview") {
    if (!activePath) return;
    setTabs((current) => current.map((tab) => (tab.path === activePath ? { ...tab, mode: nextMode } : tab)));
  }

  function setActiveEditKind(nextEditKind: EditKind) {
    if (!activePath) return;
    setTabs((current) => current.map((tab) => (tab.path === activePath ? { ...tab, mode: "edit", editKind: nextEditKind } : tab)));
  }

  function toggleActiveEditKind() {
    setActiveEditKind(activeEditKind === "source" ? "wysiwyg" : "source");
  }

  function setActiveDraft(nextDraft: string) {
    setTabs((current) => current.map((tab) => (tab.path === activePath ? { ...tab, draft: nextDraft } : tab)));
  }

  const closeTab = useCallback((path: string) => {
    const currentTabs = tabsRef.current;
    const currentActivePath = activePathRef.current;
    const closed = currentTabs.find((tab) => tab.path === path);
    setTabs((current) => current.filter((tab) => tab.path !== path));
    const wasActive = currentActivePath === path;
    if (wasActive) {
      const remaining = currentTabs.filter((tab) => tab.path !== path);
      setActivePath(remaining[remaining.length - 1]?.path ?? "");
    }
    if (closed) {
      const label = closed.isDraft
        ? `${t("undo.closedPrefix")} ${t("quick.draftTitle")}`
        : `${t("undo.closedPrefix")} ${closed.name}`;
      offerUndo({ kind: "close-tab", tab: closed, wasActive, label });
    }
  }, [offerUndo, t]);

  // Print the rendered preview of the active document through a
  // temporary top-level print surface. Android browsers often ignore
  // iframe print targets and print the parent page instead, so the app
  // print path makes the parent page itself contain only the note.
  async function printActive(): Promise<void> {
    if (!active) return;
    let html = cachedPreviewFor(active);
    if (!html) {
      const requestSeq = ++previewRequestSeq.current;
      try {
        html = await requestPreviewHtml(active.draft, active.path, active.isDraft);
        if (requestSeq === previewRequestSeq.current) {
          showPreviewSnapshot({
            path: active.path,
            draft: active.draft,
            isDraft: Boolean(active.isDraft),
            html
          });
        }
      } catch (error) {
        setStatusText(error instanceof Error ? error.message : "Unable to render preview");
        return;
      }
    }
    if (!html) {
      setStatusKey("status.printNothing");
      return;
    }
    const docName = active.name?.replace(/\.md$/i, "") || (active.isDraft ? t("quick.draftTitle") : t("editor.title"));
    try {
      await printRenderedPreviewHtml(html, `${t("app.brand.name")} - ${docName}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "Unable to print document");
    }
  }

  // 5-second autosave loop. Stash the latest autosave callback in
  // a ref so the interval doesn't capture stale state across
  // renders, and run a single window.setInterval for the lifetime
  // of the component.
  const autoSaveRef = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => {
    const id = window.setInterval(() => {
      void autoSaveRef.current();
    }, 5000);
    return () => window.clearInterval(id);
  }, []);

  // Manual save: triggered by the user (toolbar button or Save FAB).
  // Switches to preview mode on success so the user can immediately
  // see the rendered result. Drafts go through the rename-on-save
  // flow that asks for a file name when needed.
  async function save() {
    await persistActiveDocument({ silent: false, refreshList: true });
    if (centerMode === "edit") {
      setActiveMode("preview");
    }
  }

  // Keep the Cmd/Ctrl+S handler pointed at the latest save() and
  // the freshest can-save guard. The listener itself was bound
  // once above; only the ref payload mutates here.
  saveRef.current = { save, canSave: Boolean(active) && !saving };

  // Quiet save used by the 5-second autosave loop. Same on-the-wire
  // PUT but with no mode switch, no haptic, no full document list
  // refresh (sort order updates can wait for the next manual save
  // or refresh). Drafts are skipped: they'd need a generated name
  // and forcing a file into existence on every keystroke pause is
  // intrusive.
  async function autoSaveActive(): Promise<void> {
    if (!active || active.isDraft) return;
    if (saving) return;
    if (active.draft === active.content) return;
    if (active.draft.trim().length === 0) return;
    await persistActiveDocument({ silent: true, refreshList: false });
  }

  // Keep the ref pointing at the latest closure so the interval
  // sees the current `active` / `saving` / `centerMode` state.
  autoSaveRef.current = autoSaveActive;

  async function persistActiveDocument(options: { silent: boolean; refreshList: boolean }): Promise<void> {
    if (!active || saving) return;
    setSaving(true);
    if (!options.silent) setStatusKey("status.saving");
    try {
      if (active.isDraft) {
        await commitDraft(active);
      } else {
        const savedPath = active.path;
        const sentDraft = active.draft;
        const saved = await api<DocumentContent>("/api/documents/content", {
          method: "PUT",
          body: JSON.stringify({ path: savedPath, content: sentDraft, expectedHash: active.hash })
        });
        // Never overwrite the editor buffer after a save response:
        // changing `draft` can force Muya to rehydrate its document,
        // which loses scroll/caret position during autosave. The
        // server-returned content still becomes the clean baseline.
        setTabs((current) =>
          current.map((tab) => {
            if (tab.path !== saved.path) return tab;
            return { ...saved, draft: tab.draft, mode: tab.mode, editKind: tab.editKind };
          })
        );
        if (options.refreshList) await refreshDocuments();
        if (!options.silent) setStatusKey("status.saved");
      }
    } catch (error) {
      if (error instanceof Error) setStatusText(error.message);
      else setStatusKey("status.saveFailed");
    } finally {
      setSaving(false);
    }
  }

  // Commit an unsaved draft tab: derive a name, POST to create the
  // file, then swap the synthetic draft tab for the freshly-created
  // real tab. If the derived name fell back to the timestamp (i.e. we
  // could not find a meaningful title in the content), open the
  // Rename dialog right away so the user can name it.
  async function commitDraft(draftTab: OpenTab): Promise<void> {
    const folder = "Quick notes";
    const derived = deriveQuickNoteName(draftTab.draft);
    const usedFallback = !derived;
    const baseName = derived || `${t("quick.timestampPrefix")} ${formatTimestamp(new Date())}`;
    const sanitizedBase = sanitizeFileSegment(baseName) || "untitled";
    let attempt = 0;
    while (attempt < 20) {
      const candidate = attempt === 0 ? sanitizedBase : `${sanitizedBase} (${attempt + 1})`;
      const candidatePath = `${folder}/${candidate}.md`;
      try {
        const created = await api<DocumentContent>("/api/documents", {
          method: "POST",
          body: JSON.stringify({ path: candidatePath, content: draftTab.draft })
        });
        // The draft just became a real file via a manual save, so
        // land the committed tab in preview mode (matches the
        // post-save preview switch for existing files). The next
        // edit will be one tap away on the FAB.
        setTabs((current) =>
          current.map((tab) =>
            tab.path === draftTab.path ? { ...created, draft: created.content, mode: "preview", editKind: tab.editKind } : tab
          )
        );
        setActivePath(created.path);
        await refreshDocuments();
        setStatusKey("status.saved");
        offerUndo({
          kind: "delete-document",
          path: created.path,
          content: created.content,
          label: t("quick.savedToast", { path: created.path })
        });
        if (usedFallback) {
          // No meaningful title yet — give the user a chance to name it.
          openRename({ type: "file", path: created.path, name: created.name });
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        if (message.includes("already exists")) {
          attempt += 1;
          continue;
        }
        throw error;
      }
    }
    throw new Error("Could not pick a unique file name");
  }

  // Open a brand-new draft tab in the editor and switch to it. No
  // server roundtrip; the file is only created when the user saves.
  function createQuickNoteDraft() {
    const draftPath = makeDraftPath();
    const draftName = t("quick.title");
    const now = new Date().toISOString();
    // Draft tabs always start in edit mode: a blank preview is
    // useless and the whole point of a quick note is to start
    // typing immediately.
    const draftTab: OpenTab = {
      path: draftPath,
      name: draftName,
      title: draftName,
      content: "",
      draft: "",
      hash: "",
      createdAt: now,
      updatedAt: now,
      tags: [],
      aliases: [],
      headings: [],
      frontmatter: {},
      links: [],
      isDraft: true,
      mode: "edit",
      editKind: "wysiwyg"
    };
    setTabs((current) => [...current, draftTab]);
    setActivePath(draftPath);
    if (isMobile) {
      setMobileSection("editor");
    }
    haptic(6);
    // Focus the WYSIWYG editor after the draft mounts.
    window.setTimeout(() => {
      muyaEditorRef.current?.focus();
    }, 50);
  }

  const dirty = active ? active.draft !== active.content : false;

  async function createDocument(name: string) {
    try {
      const created = await api<DocumentContent>("/api/documents", {
        method: "POST",
        body: JSON.stringify({ path: name })
      });
      await refreshDocuments();
      // A freshly created note opens in edit mode: it's empty,
      // the user is about to write into it. Existing files open
      // in preview (see the active-path effect).
      setTabs((current) => [...current.filter((tab) => tab.path !== created.path), { ...created, draft: created.content, mode: "edit", editKind: "wysiwyg" }]);
      openDocument(created.path);
      setStatusKey("status.created");
    } catch (error) {
      if (error instanceof Error) setStatusText(error.message);
      else setStatusKey("status.createFailed");
      throw error;
    }
  }

  // Rename / move a single Markdown file to `nextPath` (full
  // vault-relative path including the .md extension). Updates
  // any open editor tab pointing at the old path so the editor
  // doesn't lose track of the user's draft.
  async function renameFilePath(currentPath: string, nextPath: string) {
    if (!nextPath || nextPath === currentPath) return;
    setStatusKey("status.renaming");
    try {
      const renamed = await api<DocumentContent>("/api/documents/rename", {
        method: "PATCH",
        body: JSON.stringify({ path: currentPath, nextPath })
      });
      setTabs((current) =>
        current.map((tab) => (tab.path === currentPath ? { ...renamed, draft: tab.draft, mode: tab.mode, editKind: tab.editKind } : tab))
      );
      if (activePath === currentPath) setActivePath(renamed.path);
      if (selectedFolder !== "" && selectedFolder === parentFolderOf(currentPath)) {
        setSelectedFolder(parentFolderOf(renamed.path));
      }
      setDocuments((current) => {
        const movedSummary = summaryFromContent(renamed);
        const next = current.some((doc) => doc.path === currentPath)
          ? current.map((doc) => (doc.path === currentPath ? movedSummary : doc))
          : [...current, movedSummary];
        return next.sort(compareDocumentsBy(sort, order));
      });
      await refreshFolders([parentFolderOf(currentPath), parentFolderOf(renamed.path)]);
      setStatusKey("status.renamed");
    } catch (error) {
      if (error instanceof Error) setStatusText(error.message);
      else setStatusKey("status.renameFailed");
      throw error;
    }
  }

  // Rename / move a folder. The server moves the directory
  // atomically and rewrites cache keys for every file under it.
  // We mirror that here by rewriting the open tabs' paths so the
  // editor doesn't suddenly think its file was deleted.
  async function renameFolderPath(currentPath: string, nextPath: string) {
    if (!nextPath || nextPath === currentPath) return;
    setStatusKey("status.renaming");
    try {
      await api<{ path: string; movedFiles: number }>("/api/documents/folders/rename", {
        method: "PATCH",
        body: JSON.stringify({ path: currentPath, nextPath })
      });
      const oldPrefix = `${currentPath}/`;
      const newPrefix = `${nextPath}/`;
      setTabs((current) =>
        current.map((tab) => {
          if (!tab.path.startsWith(oldPrefix)) return tab;
          const remapped = `${newPrefix}${tab.path.slice(oldPrefix.length)}`;
          return { ...tab, path: remapped, name: tab.name };
        })
      );
      if (activePath.startsWith(oldPrefix)) {
        setActivePath(`${newPrefix}${activePath.slice(oldPrefix.length)}`);
      }
      if (selectedFolder === currentPath || selectedFolder.startsWith(oldPrefix)) {
        setSelectedFolder(`${nextPath}${selectedFolder.slice(currentPath.length)}`);
      }
      await refreshDocuments();
      setStatusKey("status.renamed");
    } catch (error) {
      if (error instanceof Error) setStatusText(error.message);
      else setStatusKey("status.renameFailed");
      throw error;
    }
  }

  // Delete a single Markdown file. Closes any tab pointing at it
  // and offers an Undo toast.
  async function deleteFilePath(filePath: string, fileName: string) {
    setStatusKey("status.deleting");
    try {
      // Snapshot content for undo BEFORE we drop the tab. If the
      // file isn't open we read it from the server so undo can
      // restore the bytes.
      const openTab = tabs.find((tab) => tab.path === filePath);
      let snapshotContent = openTab?.draft ?? null;
      if (snapshotContent === null) {
        try {
          const fetched = await api<DocumentContent>(`/api/documents/content?path=${encodeURIComponent(filePath)}`);
          snapshotContent = fetched.content;
        } catch {
          snapshotContent = "";
        }
      }
      await api("/api/documents/content", {
        method: "DELETE",
        body: JSON.stringify({ path: filePath })
      });
      setTabs((current) => current.filter((tab) => tab.path !== filePath));
      if (activePath === filePath) {
        const remaining = tabs.filter((tab) => tab.path !== filePath);
        setActivePath(remaining[remaining.length - 1]?.path ?? "");
      }
      await refreshDocuments();
      setStatusKey("status.deleted");
      offerUndo({
        kind: "delete-document",
        path: filePath,
        content: snapshotContent,
        label: `${t("undo.deletedPrefix")} ${fileName}`
      });
    } catch (error) {
      if (error instanceof Error) setStatusText(error.message);
      else setStatusKey("status.deleteFailed");
      throw error;
    }
  }

  // Delete a folder. The server refuses non-empty folders unless
  // recursive=true is passed; we surface that as a second
  // "are you sure?" confirm with the actual file count.
  async function deleteFolderPath(folderPath: string, recursive = false) {
    setStatusKey("status.deleting");
    try {
      await api(`/api/documents/folders?recursive=${recursive ? "1" : "0"}`, {
        method: "DELETE",
        body: JSON.stringify({ path: folderPath })
      });
      // Drop any open tabs that lived inside the deleted folder.
      const prefix = `${folderPath}/`;
      setTabs((current) => current.filter((tab) => !tab.path.startsWith(prefix)));
      if (activePath.startsWith(prefix)) {
        setActivePath("");
      }
      if (selectedFolder === folderPath || selectedFolder.startsWith(prefix)) {
        setSelectedFolder(parentFolderOf(folderPath));
      }
      await refreshDocuments();
      setStatusKey("status.deleted");
    } catch (error) {
      // Server returns 409 with details.fileCount when a
      // non-empty folder delete is attempted without recursive=1.
      // The dialog layer catches that and switches to a confirm
      // step; here we just rethrow.
      if (error instanceof Error) setStatusText(error.message);
      else setStatusKey("status.deleteFailed");
      throw error;
    }
  }

  // Move a tree node (file or folder) into a target folder via
  // drag-and-drop. Same underlying endpoints as the rename/move
  // dialog, but no name change — we keep the basename.
  async function moveNodeIntoFolder(source: TreeNodeTarget, targetFolder: string) {
    if (!source.path) return;
    if (source.type === "folder" && (targetFolder === source.path || targetFolder.startsWith(`${source.path}/`))) {
      setStatusKey("tree.dragDrop.refused");
      return;
    }
    const baseName = source.name;
    const nextPath = targetFolder ? `${targetFolder}/${baseName}` : baseName;
    if (nextPath === source.path) return;
    setStatusKey("tree.dragDrop.busy");
    try {
      if (source.type === "file") {
        await renameFilePath(source.path, nextPath);
      } else {
        await renameFolderPath(source.path, nextPath);
      }
    } catch {
      // renameFilePath / renameFolderPath already surface the
      // error in the status bar, so we just swallow here.
    }
  }

  // Create an empty folder via the dedicated server endpoint.
  async function createFolderPath(folderPath: string) {
    setStatusKey("status.creating");
    try {
      await api<{ path: string }>("/api/documents/folders", {
        method: "POST",
        body: JSON.stringify({ path: folderPath })
      });
      setSelectedFolder(folderPath);
      await refreshDocuments();
      setStatusKey("status.created");
    } catch (error) {
      if (error instanceof Error) setStatusText(error.message);
      else setStatusKey("status.createFailed");
      throw error;
    }
  }

  async function performUndo() {
    if (!pendingUndo) {
      return;
    }
    const action = pendingUndo;
    haptic([6, 30, 6]);
    dismissUndo();
    if (action.kind === "close-tab") {
      setTabs((current) => {
        if (current.some((tab) => tab.path === action.tab.path)) {
          return current;
        }
        return [...current, action.tab];
      });
      if (action.wasActive) {
        setActivePath(action.tab.path);
      }
      setStatusText(`${t("status.reopenedPrefix")} ${action.tab.name}`);
      return;
    }
    setStatusKey("status.restoring");
    try {
      await api<DocumentContent>("/api/documents", {
        method: "POST",
        body: JSON.stringify({ path: action.path })
      });
      const restored = await api<DocumentContent>("/api/documents/content", {
        method: "PUT",
        body: JSON.stringify({ path: action.path, content: action.content })
      });
      await refreshDocuments();
      setTabs((current) => [
        ...current.filter((tab) => tab.path !== restored.path),
        { ...restored, draft: restored.content, mode: "preview", editKind: "wysiwyg" }
      ]);
      openDocument(restored.path);
      setStatusText(`${t("status.restoredPrefix")} ${restored.name}`);
    } catch (error) {
      if (error instanceof Error) setStatusText(`${t("status.restoreFailedPrefix")}: ${error.message}`);
      else setStatusKey("status.restoreFailedPrefix");
    }
  }

  async function onSort(nextSort: SortField, nextOrder: SortOrder) {
    setSort(nextSort);
    setOrder(nextOrder);
    localStorage.setItem(sortStorageKey, JSON.stringify({ sort: nextSort, order: nextOrder }));
    await refreshDocuments(nextSort, nextOrder);
  }

  async function searchVault() {
    if (!searchQuery.trim() || searchLoading) {
      return;
    }
    setSearchLoading(true);
    setSearchError("");
    setSearchHasRun(true);
    try {
      const results = await api<DocumentSearchResult[]>(`/api/documents/search?q=${encodeURIComponent(searchQuery.trim())}`);
      setSearchResults(results);
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "Search failed");
    } finally {
      setSearchLoading(false);
    }
  }

  function openSearchResult(path: string) {
    openDocument(path);
    setSearchOpen(false);
  }

  function scrollPreviewToHeading(container: HTMLElement, heading: string): boolean {
    const normalizedHeading = heading.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    if (!normalizedHeading) return false;
    const headings = Array.from(container.querySelectorAll<HTMLElement>("article :is(h1, h2, h3, h4, h5, h6)"));
    const match = headings.find((candidate) => candidate.textContent?.trim().replace(/\s+/g, " ").toLocaleLowerCase() === normalizedHeading);
    if (!match) return false;
    match.scrollIntoView({ block: "start", behavior: "smooth" });
    return true;
  }

  function showPreviewLinkError(target: string, message: string) {
    setPreviewLinkError({ target, message });
    setStatusText(message);
  }

  async function openPreviewAsset(target: string, popup: Window | null) {
    const params = new URLSearchParams({ path: target });
    if (active && !active.isDraft) {
      params.set("base", active.path);
    }

    try {
      const asset = await api<VaultAssetLink>(`/api/documents/asset-link?${params.toString()}`);
      if (popup) {
        popup.location.href = asset.url;
      } else {
        window.open(asset.url, "_blank", "noopener,noreferrer");
      }
      setStatusText(t("preview.link.opened", { name: asset.name }));
    } catch (error) {
      popup?.close();
      showPreviewLinkError(target, error instanceof Error ? error.message : t("preview.link.openError"));
    }
  }

  async function openPreviewVaultTarget(target: string, container: HTMLElement) {
    if (target.startsWith("#")) {
      const opened = scrollPreviewToHeading(container, target.slice(1));
      if (!opened) setStatusText(t("preview.link.headingMissing", { target: target.slice(1) }));
      return;
    }

    if (isPreviewAssetTarget(target)) {
      const popup = window.open("", "_blank");
      if (popup) {
        popup.opener = null;
      }
      await openPreviewAsset(target, popup);
      return;
    }

    if (!isPreviewDocumentTarget(target)) {
      showPreviewLinkError(target, t("preview.link.unsupported", { target }));
      return;
    }

    const params = new URLSearchParams({ target });
    if (active && !active.isDraft) {
      params.set("base", active.path);
    }

    try {
      const resolved = await api<{ path: string }>(`/api/documents/resolve-link?${params.toString()}`);
      openDocument(resolved.path);
    } catch (error) {
      showPreviewLinkError(target, error instanceof Error ? error.message : t("preview.link.openError"));
    }
  }

  async function openPreviewInternalLink(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a");
    if (!(anchor instanceof HTMLAnchorElement) || !event.currentTarget.contains(anchor)) return;

    const isInternalLink = anchor.classList.contains("internal-link");
    const rawTarget = isInternalLink
      ? anchor.getAttribute("title")?.trim() || anchor.textContent?.trim()
      : previewTargetFromHref(anchor.getAttribute("href") ?? "");

    if (!rawTarget) return;

    event.preventDefault();
    await openPreviewVaultTarget(rawTarget, event.currentTarget);
  }

  const activateTab = useCallback((path: string) => {
    setActivePath(path);
  }, []);

  const toggleCopilotCollapsed = useCallback(() => {
    setCopilotCollapsed((open) => !open);
  }, []);

  const toggleTreeFolder = useCallback((folderPath: string) => {
    setExpandedFolders((current) => {
      const wasExpanded = current[folderPath] ?? false;
      if (!wasExpanded) {
        // Lazy-fetch the folder's direct children on first expand.
        // The fetch is a no-op when already loaded.
        void loadFolderChildren(folderPath);
      }
      return { ...current, [folderPath]: !wasExpanded };
    });
    setSelectedFolder(folderPath);
  }, [loadFolderChildren]);

  const endTreeDrag = useCallback(() => {
    setDragSource(null);
    setDragOverPath(null);
  }, []);

  const markTreeDragOver = useCallback((folderPath: string) => {
    setDragOverPath(folderPath);
  }, []);

  const dropTreeNodeOnFolder = useCallback((targetFolder: string) => {
    const source = dragSource;
    setDragSource(null);
    setDragOverPath(null);
    if (source) void moveNodeIntoFolder(source, targetFolder);
  }, [dragSource]);

  const activePreview =
    active &&
    previewSnapshot?.path === active.path &&
    previewSnapshot.draft === active.draft &&
    previewSnapshot.isDraft === Boolean(active.isDraft)
      ? previewSnapshot.html
      : cachedPreviewFor(active) ?? "";

  return (
    <main
      className="workspace-grid obsidian-workspace"
      data-mobile-section={mobileSection}
      data-vault-collapsed={!isMobile && vaultCollapsed ? "true" : undefined}
      data-copilot-collapsed={!isMobile && copilotCollapsed ? "true" : undefined}
      onPointerDown={onWorkspacePointerDown}
      onPointerUp={onWorkspacePointerUp}
      onPointerCancel={() => { edgeSwipe.current = null; }}
    >
      {isMobile && (mobileSection === "vault" || mobileSection === "ask") ? (
        <div
          className="mobile-overlay-backdrop"
          aria-hidden="true"
          onClick={closeOverlays}
        />
      ) : null}
      {isMobile ? (
        <header className="mobile-app-bar">
          <button
            type="button"
            className="icon-button"
            aria-label={t("section.vault")}
            aria-expanded={mobileSection === "vault"}
            onClick={() => {
              if (mobileSection === "vault") closeOverlays();
              else switchSection("vault");
            }}
          >
            <MenuIcon />
          </button>
          <div className="mobile-app-bar-title" translate={active && !active.isDraft ? "no" : undefined}>
            <strong>
              {active?.isDraft ? t("quick.draftTitle") : (active?.name ?? t("editor.title"))}
            </strong>
            {statusLabel ? (
              <span className={`status-subline ${statusIsPending ? "pending" : ""}`} aria-live="polite">{statusLabel}</span>
            ) : active && !active.isDraft ? (
              <span className="muted" translate="no">{active.path}</span>
            ) : active?.isDraft ? (
              <span className="muted">{t("quick.draftEyebrow")}</span>
            ) : null}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t("editor.moreActions")}
            aria-expanded={commandSheetOpen}
            aria-haspopup="menu"
            onClick={openCommandMenu}
          >
            <MoreIcon />
          </button>
        </header>
      ) : null}
      <section
        className="document-list panel vault-pane"
        data-section="vault"
        id={isMobile ? "section-panel-vault" : undefined}
        role={isMobile ? "tabpanel" : undefined}
        aria-labelledby={isMobile ? "section-tab-vault" : undefined}
      >
        <div className="mobile-section-header" aria-hidden={!isMobile}>
          <div className="mobile-section-title">
            <strong>{t("vault.title")}</strong>
            <span className="muted">
              {t(documentCount === 1 ? "vault.fileCount" : "vault.fileCountPlural", { count: documentCount })}
            </span>
          </div>
          <div className="mobile-section-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={t("vault.search")}
              onClick={() => {
                if (isMobile) closeOverlays();
                setSearchOpen(true);
              }}
            >
              <SearchIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t(vaultTreeRefreshing ? "vault.refreshBusy" : "vault.refresh")}
              title={t(vaultTreeRefreshing ? "vault.refreshBusy" : "vault.refresh")}
              aria-busy={vaultTreeRefreshing}
              disabled={vaultTreeRefreshing}
              onClick={() => void refreshVaultTree()}
            >
              {vaultTreeRefreshing ? <SpinnerIcon /> : <RefreshIcon />}
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t("vault.new")}
              onClick={() => {
                if (isMobile) closeOverlays();
                openCreateNote(selectedFolder);
              }}
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t("vault.newFolder")}
              onClick={() => {
                if (isMobile) closeOverlays();
                openCreateFolder(selectedFolder);
              }}
            >
              <FolderPlusIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t("vault.sort")}
              onClick={() => {
                if (isMobile) closeOverlays();
                setSortSheetOpen(true);
              }}
            >
              <SortIcon />
            </button>
          </div>
        </div>
        {/* Single-row toolbar: a primary search button takes most
            of the width; the two creation actions and a sort affordance
            sit as icon-only buttons on the right. The panel header
            (eyebrow + h2 "Vault" + file count) was removed because
            it duplicated the workspace tab label and pushed the tree
            below the fold; file count now lives as a thin caption
            directly above the tree where it doesn't compete for
            attention. */}
        {/* Single row of icon-only actions. Search stays first for
            muscle memory, but shares the same chrome as the other
            toolbar buttons. The full label still ships through
            aria-label / title for assistive tech and tooltips. */}
        <div className="vault-toolbar desktop-only">
          <button
            type="button"
            className="icon-button vault-toolbar-action vault-toolbar-search"
            aria-label={t("vault.searchVault")}
            title={t("vault.searchVault")}
            onClick={() => setSearchOpen(true)}
          >
            <SearchIcon />
          </button>
          <button
            type="button"
            className="icon-button vault-toolbar-action"
            aria-label={t(vaultTreeRefreshing ? "vault.refreshBusy" : "vault.refresh")}
            title={t(vaultTreeRefreshing ? "vault.refreshBusy" : "vault.refresh")}
            aria-busy={vaultTreeRefreshing}
            disabled={vaultTreeRefreshing}
            onClick={() => void refreshVaultTree()}
          >
            {vaultTreeRefreshing ? <SpinnerIcon /> : <RefreshIcon />}
          </button>
          <button
            type="button"
            className="icon-button vault-toolbar-action"
            aria-label={t("vault.newNote")}
            title={t("vault.newNote")}
            onClick={() => openCreateNote(selectedFolder)}
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            className="icon-button vault-toolbar-action"
            aria-label={t("vault.newFolder")}
            title={t("vault.newFolder")}
            onClick={() => openCreateFolder(selectedFolder)}
          >
            <FolderPlusIcon />
          </button>
          <button
            type="button"
            className="icon-button vault-toolbar-action"
            aria-label={t("vault.sortOptions")}
            title={t("vault.sortOptions")}
            onClick={() => setSortSheetOpen(true)}
          >
            <SortIcon />
          </button>
          <button
            type="button"
            className="icon-button vault-toolbar-action pane-collapse-toggle"
            aria-label={t("vault.collapse")}
            title={t("vault.collapse")}
            onClick={() => setVaultCollapsed(true)}
          >
            <PanelToggleIcon />
          </button>
        </div>
        {/* Collapsed rail: shown only when data-vault-collapsed="true"
            is set on the workspace. The single button restores the
            full panel; the icon stack underneath is a passive label
            so a 44px sliver still reads as "the vault is here".
            inert is the modern, browser-enforced way to make the
            sub-tree non-interactive when the rail is not the active
            UI (CSS hides it visually; inert keeps it out of the
            keyboard tab order and the a11y tree even if a future
            transition leaves it briefly visible). */}
        <div
          className="pane-collapsed-rail desktop-only"
          inert={!vaultCollapsed}
          aria-hidden={!vaultCollapsed || undefined}
        >
          <button
            type="button"
            className="icon-button pane-expand-toggle"
            aria-label={t("vault.expand")}
            title={t("vault.expand")}
            onClick={() => setVaultCollapsed(false)}
          >
            <PanelToggleIcon />
          </button>
          <span className="pane-collapsed-icon" aria-hidden="true">
            <MenuIcon />
          </span>
        </div>
        <p className="vault-meta muted desktop-only" aria-live="polite">
          {t(documentCount === 1 ? "vault.fileCount" : "vault.fileCountPlural", { count: documentCount })}
        </p>
        <div
          ref={vaultScrollRef}
          className="vault-scroll"
          onTouchStart={onVaultTouchStart}
          onTouchMove={onVaultTouchMove}
          onTouchEnd={onVaultTouchEnd}
          onTouchCancel={onVaultTouchEnd}
          onScroll={onVaultScroll}
        >
          {isMobile && pullDistance > 0 ? (
            <div
              className={`pull-indicator ${pullDistance >= pullThreshold ? "ready" : ""}`}
              style={{ height: `${pullDistance}px` }}
              aria-hidden="true"
            >
              <span>{pullDistance >= pullThreshold ? t("vault.releaseToSearch") : t("vault.pullToSearch")}</span>
            </div>
          ) : null}
          <DocumentTree
            nodes={documentTree}
            selectedPath={activePath}
            selectedFolder={selectedFolder}
            expandedFolders={expandedFolders}
            onToggleFolder={toggleTreeFolder}
            loadingFolders={loadingFolders}
            onSelect={openDocument}
            emptyLabel={t("vault.empty")}
            onContextMenu={openNodeMenu}
            dragSource={dragSource}
            dragOverPath={dragOverPath}
            onDragStartNode={setDragSource}
            onDragEndNode={endTreeDrag}
            onDragOverFolder={markTreeDragOver}
            onDropOnFolder={dropTreeNodeOnFolder}
          />
        </div>
        {isMobile && vaultScrolled ? (
          <button
            type="button"
            className="back-to-top"
            onClick={scrollVaultToTop}
            aria-label={t("vault.backToTop")}
          >
            <ChevronUpIcon />
          </button>
        ) : null}
      </section>
      <section
        className="editor panel editor-pane"
        data-section="editor"
        id={isMobile ? "section-panel-editor" : undefined}
        role={isMobile ? "tabpanel" : undefined}
        aria-labelledby={isMobile ? "section-tab-editor" : undefined}
      >
        {/* Combined tab bar: tabs scroll horizontally on the left
            while the action cluster (mode toggle / focus / "\u22ef"
            menu) stays anchored on the right. The previous
            separate editor-toolbar row collapses into this single
            band so there's only one line of chrome above the
            editor content. On desktop the "\u22ef" trigger opens
            the same command sheet that mobile uses (file actions +
            workspace nav + theme/lang/logout), which is why the
            workspace-topbar can be dropped entirely. The actions
            cluster is hidden on mobile since the mobile-app-bar
            already exposes the same trigger. */}
        <div className="editor-tabbar">
          <div className="tab-strip" role="tablist" aria-label={t("editor.tabsLabel")}>
            {tabs.map((tab) => (
              <SwipeableTab
                key={tab.path}
                path={tab.path}
                name={tab.name}
                isDraft={!!tab.isDraft}
                active={activePath === tab.path}
                isMobile={isMobile}
                closeAriaLabel={t("editor.closeTab", { name: tab.name })}
                onActivate={activateTab}
                onClose={closeTab}
              />
            ))}
            <button
              type="button"
              className="tab-strip-add"
              aria-label={t("quick.trigger")}
              title={`${t("quick.trigger")}  (\u2318\u21e7N)`}
              onClick={createQuickNoteDraft}
            >
              <PlusIcon />
            </button>
          </div>
          <div className="editor-tabbar-actions desktop-only" aria-label={t("editor.actionsLabel")}>
            <span
              className="editor-tabbar-status"
              aria-live="polite"
              title={statusLabel || undefined}
            >
              {status.kind === "key" ? t(status.key, status.params) : status.text}
            </span>
            {active && centerMode === "edit" ? (
              <button
                type="button"
                className="icon-button source-toggle"
                onClick={toggleActiveEditKind}
                aria-pressed={activeEditKind === "source"}
                aria-label={activeEditKind === "source" ? t("editor.modeWysiwyg") : t("editor.modeSource")}
                title={activeEditKind === "source" ? t("editor.modeWysiwyg") : t("editor.modeSource")}
              >
                {activeEditKind === "source" ? <PencilIcon /> : <CodeIcon />}
              </button>
            ) : null}
            <button
              type="button"
              className="icon-button mode-toggle"
              onClick={() => setActiveMode(centerMode === "edit" ? "preview" : "edit")}
              aria-pressed={centerMode === "preview"}
              aria-label={t("editor.toggleMode")}
              title={`${t("editor.toggleMode")} \u2014 ${centerMode === "edit" ? t("editor.modePreview") : t("editor.modeEdit")}`}
              disabled={!active}
            >
              {centerMode === "edit" ? <EyeIcon /> : <PencilIcon />}
            </button>
            <button
              type="button"
              className="icon-button focus-toggle"
              onClick={() => setZenMode(true)}
              aria-label={t("editor.focusEnter")}
              title={t("editor.focusEnter")}
            >
              <MaximizeIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-haspopup="menu"
              aria-expanded={commandSheetOpen}
              aria-label={t("editor.moreActions")}
              title={t("editor.moreActions")}
              onClick={openCommandMenu}
            >
              <MoreIcon />
            </button>
          </div>
        </div>
        {active && centerMode === "edit" ? (
          <div className={`editor-field${activeEditKind === "source" ? " editor-field-source" : ""}`} aria-label={t("editor.contentLabel")}>
            <Suspense
              fallback={
                <div className="muya-editor-loading" role="status" aria-live="polite">
                  <SpinnerIcon />
                  <span>{t("editor.loading")}</span>
                </div>
              }
            >
              {activeEditKind === "source" ? (
                <MarkdownSourceEditor
                  key={`${active.path}:source`}
                  value={active.draft}
                  ariaLabel={t("editor.sourceContentLabel")}
                  autoFocus
                  onChange={setActiveDraft}
                />
              ) : (
                <MuyaMarkdownEditor
                  key={active.path}
                  ref={muyaEditorRef}
                  value={active.draft}
                  documentPath={active.isDraft ? undefined : active.path}
                  language={locale === "zh" ? "zh-CN" : "en"}
                  autoFocus={active.isDraft}
                  onReady={handleMuyaEditorReady}
                  onChange={setActiveDraft}
                  onPasteImage={uploadPastedImage}
                />
              )}
            </Suspense>
          </div>
        ) : null}
        {active && centerMode === "preview" ? (
          <div className="preview-surface" onClick={openPreviewInternalLink}>
            {activePreview ? <article dangerouslySetInnerHTML={{ __html: activePreview }} /> : <div className="empty-state">{t("editor.previewEmpty")}</div>}
          </div>
        ) : null}
        {!active ? (
          <div className="blank-editor">
            <p className="eyebrow">{t("editor.blankEyebrow")}</p>
            <h2>{t("editor.blankTitle")}</h2>
            <p className="muted">{t("editor.blankBody")}</p>
          </div>
        ) : null}
      </section>
      <div
        className="copilot-section-wrapper"
        data-section="ask"
        id={isMobile ? "section-panel-ask" : undefined}
        role={isMobile ? "tabpanel" : undefined}
        aria-labelledby={isMobile ? "section-tab-ask" : undefined}
      >
        <CopilotView
          compact
          username={props.username}
          onOpenSource={openDocument}
          onVaultFilesChanged={refreshVaultPaths}
          onDismiss={isMobile ? closeOverlays : undefined}
          startupReady={muyaEditorReady}
          activeNote={
            active
              ? {
                  path: active.path,
                  title: active.title || active.name || active.path,
                  content: active.draft,
                  hash: active.hash,
                  isDraft: Boolean(active.isDraft),
                  dirty
                }
              : null
          }
          collapsed={!isMobile && copilotCollapsed}
          onToggleCollapsed={!isMobile ? toggleCopilotCollapsed : undefined}
        />
      </div>
      {isMobile && mobileSection === "editor" && active ? (
        // Mobile FAB is a single contextual button. Its role
        // depends on the current mode + dirty state:
        //   - preview         -> Edit  (flip to edit mode)
        //   - edit + clean    -> Preview (flip to preview mode)
        //   - edit + dirty    -> Save  (save, then auto-flip to preview)
        // We never show a disabled "Saved" state: the button is
        // always the most useful next action.
        centerMode === "preview" ? (
          <button
            type="button"
            className="editor-fab editor-fab-edit"
            onClick={() => setActiveMode("edit")}
            aria-label={t("editor.fab.ariaEdit")}
          >
            <PencilIcon />
            <span className="editor-fab-label">{t("editor.fab.edit")}</span>
          </button>
        ) : !dirty ? (
          <button
            type="button"
            className="editor-fab editor-fab-edit"
            onClick={() => setActiveMode("preview")}
            aria-label={t("editor.fab.ariaPreview")}
          >
            <EyeIcon />
            <span className="editor-fab-label">{t("editor.fab.preview")}</span>
          </button>
        ) : (
          <button
            type="button"
            className="editor-fab"
            onClick={save}
            disabled={saving}
            aria-busy={saving}
            aria-label={t("editor.fab.ariaSave")}
          >
            {saving ? <SpinnerIcon /> : <SaveIcon />}
            <span className="editor-fab-label">{saving ? t("editor.fab.saving") : t("editor.fab.save")}</span>
          </button>
        )
      ) : null}
      {pendingUndo ? (
        <div className="undo-toast" role="status" aria-live="polite">
          <span className="undo-toast-label" translate="no">{pendingUndo.label}</span>
          <button type="button" className="undo-toast-action" onClick={performUndo}>
            {t("undo.button")}
          </button>
          <button type="button" className="undo-toast-dismiss" aria-label={t("undo.dismiss")} onClick={dismissUndo}>
            <span aria-hidden="true">{"\u00d7"}</span>
          </button>
        </div>
      ) : null}
      {previewLinkError ? (
        <NoticeModal
          title={t("preview.link.errorTitle")}
          eyebrow={previewLinkError.target}
          description={previewLinkError.message}
          closeLabel={t("modal.close")}
          onClose={() => setPreviewLinkError(null)}
        />
      ) : null}
      {nodeMenu ? (
        <TreeNodeMenu
          x={nodeMenu.x}
          y={nodeMenu.y}
          node={nodeMenu.node}
          onClose={closeNodeMenu}
          onOpen={() => {
            if (nodeMenu.node.type === "file") {
              openDocument(nodeMenu.node.path);
            } else {
              setSelectedFolder(nodeMenu.node.path);
              setExpandedFolders((current) => ({ ...current, [nodeMenu.node.path]: true }));
              void loadFolderChildren(nodeMenu.node.path);
            }
            closeNodeMenu();
          }}
          onRename={() => {
            if (isMobile) closeOverlays();
            openRename(nodeMenu.node);
            closeNodeMenu();
          }}
          onMove={() => {
            if (isMobile) closeOverlays();
            openMove(nodeMenu.node);
            closeNodeMenu();
          }}
          onDelete={() => {
            if (isMobile) closeOverlays();
            openDelete(nodeMenu.node);
            closeNodeMenu();
          }}
          onNewNoteHere={() => {
            const folder = nodeMenu.node.type === "folder" ? nodeMenu.node.path : parentFolderOf(nodeMenu.node.path);
            if (isMobile) closeOverlays();
            openCreateNote(folder);
            closeNodeMenu();
          }}
          onNewFolderHere={() => {
            const folder = nodeMenu.node.type === "folder" ? nodeMenu.node.path : parentFolderOf(nodeMenu.node.path);
            if (isMobile) closeOverlays();
            openCreateFolder(folder);
            closeNodeMenu();
          }}
          onCopyPath={async () => {
            try {
              await navigator.clipboard.writeText(nodeMenu.node.path);
              setStatusKey("tree.menu.copied");
            } catch {
              setStatusKey("tree.menu.copyFailed");
            }
            closeNodeMenu();
          }}
        />
      ) : null}
      {dialog?.kind === "createNote" ? (
        <PathPickerModal
          mode="create-note"
          title={t("prompt.create.title")}
          eyebrow={t("prompt.create.eyebrow")}
          description={t("prompt.create.description")}
          submitLabel={t("prompt.create.submit")}
          submitLoadingLabel={t("prompt.create.submitBusy")}
          cancelLabel={t("prompt.cancel")}
          errorFallback={t("error.actionFailed")}
          initialFolder={dialog.defaultFolder}
          initialName="Untitled"
          folderChildren={folderChildren}
          loadingFolders={loadingFolders}
          loadFolder={loadFolderChildren}
          onCancel={closeDialog}
          onSubmit={async ({ folder, name }) => {
            const sanitized = name.replace(/\.md$/i, "").trim();
            if (!sanitized) throw new Error(t("prompt.error.emptyName"));
            const path = folder ? `${folder}/${sanitized}.md` : `${sanitized}.md`;
            await createDocument(path);
            closeDialog();
          }}
        />
      ) : null}
      {dialog?.kind === "createFolder" ? (
        <PathPickerModal
          mode="create-folder"
          title={t("prompt.createFolder.title")}
          eyebrow={t("prompt.createFolder.eyebrow")}
          description={t("prompt.createFolder.description")}
          submitLabel={t("prompt.createFolder.submit")}
          submitLoadingLabel={t("prompt.createFolder.submitBusy")}
          cancelLabel={t("prompt.cancel")}
          errorFallback={t("error.actionFailed")}
          initialFolder={dialog.defaultFolder}
          initialName=""
          folderChildren={folderChildren}
          loadingFolders={loadingFolders}
          loadFolder={loadFolderChildren}
          onCancel={closeDialog}
          onSubmit={async ({ folder, name }) => {
            const sanitized = name.trim().replace(/\/+$/, "");
            if (!sanitized) throw new Error(t("prompt.error.emptyName"));
            const path = folder ? `${folder}/${sanitized}` : sanitized;
            await createFolderPath(path);
            closeDialog();
          }}
        />
      ) : null}
      {dialog?.kind === "rename" ? (
        // Rename only changes the basename; the FolderPicker is
        // hidden so the user makes one focused decision. Move
        // lives behind a separate "Move to..." action.
        <PathPickerModal
          mode={dialog.type === "folder" ? "rename-folder" : "rename-file"}
          title={dialog.type === "folder" ? t("prompt.rename.titleFolder") : t("prompt.rename.title")}
          eyebrow={dialog.path}
          description={dialog.type === "folder" ? t("prompt.rename.descriptionFolder") : t("prompt.rename.description")}
          submitLabel={t("prompt.rename.submit")}
          submitLoadingLabel={t("prompt.rename.submitBusy")}
          cancelLabel={t("prompt.cancel")}
          errorFallback={t("error.actionFailed")}
          initialFolder={parentFolderOf(dialog.path)}
          initialName={dialog.type === "file" ? dialog.name.replace(/\.md$/i, "") : dialog.name}
          folderChildren={folderChildren}
          loadingFolders={loadingFolders}
          loadFolder={loadFolderChildren}
          hideFolder
          onCancel={closeDialog}
          onSubmit={async ({ folder, name }) => {
            const trimmed = name.trim();
            if (!trimmed) throw new Error(t("prompt.error.emptyName"));
            if (dialog.type === "file") {
              const sanitized = trimmed.replace(/\.md$/i, "");
              const nextPath = folder ? `${folder}/${sanitized}.md` : `${sanitized}.md`;
              await renameFilePath(dialog.path, nextPath);
            } else {
              const sanitized = trimmed.replace(/\/+$/, "");
              const nextPath = folder ? `${folder}/${sanitized}` : sanitized;
              await renameFolderPath(dialog.path, nextPath);
            }
            closeDialog();
          }}
        />
      ) : null}
      {dialog?.kind === "move" ? (
        // Move only changes the parent folder; the name input is
        // hidden so the user makes one focused decision. Rename
        // lives behind a separate "Rename..." action.
        <PathPickerModal
          mode={dialog.type === "folder" ? "move-folder" : "move-file"}
          title={dialog.type === "folder" ? t("prompt.move.titleFolder") : t("prompt.move.title")}
          eyebrow={dialog.path}
          description={t("prompt.move.description", { name: dialog.name })}
          submitLabel={t("prompt.move.submit")}
          submitLoadingLabel={t("prompt.move.submitBusy")}
          cancelLabel={t("prompt.cancel")}
          errorFallback={t("error.actionFailed")}
          initialFolder={parentFolderOf(dialog.path)}
          // Name stays at the original basename; we never read it
          // in submit() but PathPickerModal still needs *some*
          // value so the disabled-state logic doesn't trip.
          initialName={dialog.name}
          folderChildren={folderChildren}
          loadingFolders={loadingFolders}
          loadFolder={loadFolderChildren}
          // Block moving a folder into itself or its own subtree.
          disabledFolderPrefixes={dialog.type === "folder" ? [dialog.path] : []}
          hideName
          onCancel={closeDialog}
          onSubmit={async ({ folder }) => {
            // Same parent? Treat as a no-op so the user's click
            // doesn't surface a misleading "moved" message.
            if (folder === parentFolderOf(dialog.path)) {
              closeDialog();
              return;
            }
            if (dialog.type === "file") {
              const baseName = dialog.name; // already includes .md
              const nextPath = folder ? `${folder}/${baseName}` : baseName;
              await renameFilePath(dialog.path, nextPath);
            } else {
              const baseName = dialog.name;
              const nextPath = folder ? `${folder}/${baseName}` : baseName;
              await renameFolderPath(dialog.path, nextPath);
            }
            closeDialog();
          }}
        />
      ) : null}
      {dialog?.kind === "delete" ? (
        <ConfirmModal
          title={
            dialog.type === "folder"
              ? t("confirm.delete.titleFolder", { name: dialog.name })
              : t("confirm.delete.title", { name: dialog.name })
          }
          eyebrow={dialog.path}
          description={
            dialog.type === "folder"
              ? t("confirm.delete.descriptionFolder")
              : t("confirm.delete.description")
          }
          confirmLabel={t("confirm.delete.submit")}
          confirmLoadingLabel={t("confirm.delete.submitBusy")}
          cancelLabel={t("prompt.cancel")}
          errorFallback={t("error.actionFailed")}
          danger
          onCancel={closeDialog}
          onConfirm={async () => {
            if (dialog.type === "file") {
              await deleteFilePath(dialog.path, dialog.name);
              closeDialog();
              return;
            }
            // Folder: try non-recursive first; if the server says
            // "non-empty", switch to a second confirm step that
            // surfaces the file count.
            try {
              await deleteFolderPath(dialog.path, false);
              closeDialog();
            } catch (error) {
              const message = error instanceof Error ? error.message : "";
              const match = message.match(/\((\d+) files?\)/);
              const fileCount = match ? Number(match[1]) : 0;
              if (fileCount > 0) {
                setDialog({ kind: "deleteFolderConfirm", path: dialog.path, name: dialog.name, fileCount });
              } else {
                throw error;
              }
            }
          }}
        />
      ) : null}
      {dialog?.kind === "deleteFolderConfirm" ? (
        <ConfirmModal
          title={t("confirm.deleteFolderRecursive.title", { name: dialog.name })}
          eyebrow={dialog.path}
          description={t("confirm.deleteFolderRecursive.description", { count: dialog.fileCount })}
          confirmLabel={t("confirm.deleteFolderRecursive.submit")}
          confirmLoadingLabel={t("confirm.delete.submitBusy")}
          cancelLabel={t("prompt.cancel")}
          errorFallback={t("error.actionFailed")}
          danger
          onCancel={closeDialog}
          onConfirm={async () => {
            await deleteFolderPath(dialog.path, true);
            closeDialog();
          }}
        />
      ) : null}
      {commandSheetOpen && !isMobile && commandMenuAnchor ? (
        <AnchoredMenu
          x={commandMenuAnchor.x}
          y={commandMenuAnchor.y}
          align="right"
          className="editor-command-menu"
          ariaLabel={t("editor.moreActions")}
          onClose={closeCommandMenu}
        >
          {active ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeCommandMenu();
                  setActiveMode(centerMode === "edit" ? "preview" : "edit");
                }}
              >
                {centerMode === "edit" ? <EyeIcon /> : <PencilIcon />}
                <span>{centerMode === "edit" ? t("editor.modePreview") : t("editor.modeEdit")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeCommandMenu();
                  setActiveEditKind(editKindTarget);
                }}
              >
                {editKindTarget === "source" ? <CodeIcon /> : <PencilIcon />}
                <span>{editKindTarget === "source" ? t("editor.modeSource") : t("editor.modeWysiwyg")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!dirty || saving}
                onClick={() => {
                  closeCommandMenu();
                  save();
                }}
              >
                <SaveIcon />
                <span>{t("editor.save")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeCommandMenu();
                  printActive();
                }}
              >
                <PrintIcon />
                <span>{t("editor.print")}</span>
              </button>
              {!active.isDraft ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeCommandMenu();
                      if (active) openRename({ type: "file", path: active.path, name: active.name });
                    }}
                  >
                    <PencilIcon />
                    <span>{t("editor.rename")}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeCommandMenu();
                      if (active) openMove({ type: "file", path: active.path, name: active.name });
                    }}
                  >
                    <FolderPlusIcon />
                    <span>{t("editor.move")}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="danger"
                    onClick={() => {
                      closeCommandMenu();
                      if (active) openDelete({ type: "file", path: active.path, name: active.name });
                    }}
                  >
                    <TrashIcon />
                    <span>{t("editor.delete")}</span>
                  </button>
                </>
              ) : null}
              <hr />
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeCommandMenu();
              setSettingsModalMode("indexing");
            }}
          >
            <IndexingIcon />
            <span>{t("nav.indexing")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeCommandMenu();
              setSettingsModalMode("settings");
            }}
          >
            <SettingsIcon />
            <span>{t("nav.settings")}</span>
          </button>
          <hr />
          {props.onToggleTheme ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeCommandMenu();
                props.onToggleTheme!();
              }}
            >
              {props.theme === "dark" ? <SunIcon /> : <MoonIcon />}
              <span>{props.theme === "dark" ? t("topbar.themeLight") : t("topbar.themeDark")}</span>
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const next = locale === "en" ? "zh" : "en";
              closeCommandMenu();
              setLocale(next);
            }}
          >
            <GlobeIcon />
            <span>{locale === "en" ? "\u4e2d\u6587" : "English"}</span>
          </button>
          {props.onLogout ? (
            <button
              type="button"
              role="menuitem"
              className="danger"
              disabled={props.loggingOut}
              onClick={() => {
                closeCommandMenu();
                props.onLogout!();
              }}
            >
              <LogoutIcon />
              <span>
                <BusyLabel busy={!!props.loggingOut} busyText={t("topbar.logoutBusy")}>{t("topbar.logout")}</BusyLabel>
              </span>
            </button>
          ) : null}
        </AnchoredMenu>
      ) : null}
      {commandSheetOpen && isMobile ? (
        <div className="modal-backdrop sheet-backdrop" role="presentation" onMouseDown={closeCommandMenu}>
          <section
            className="action-sheet panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="command-sheet-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="action-sheet-header">
              <h2 id="command-sheet-title">{t("editor.moreActions")}</h2>
              <button type="button" onClick={() => setCommandSheetOpen(false)}>{t("vault.done")}</button>
            </header>
            {/* Editor actions (only when there is an active document). */}
            {active ? (
              <div className="action-sheet-group" aria-label={t("editor.actionsLabel")}>
                <button
                  type="button"
                  onClick={() => {
                    setCommandSheetOpen(false);
                    setActiveMode(centerMode === "edit" ? "preview" : "edit");
                  }}
                >
                  <span className="action-sheet-icon" aria-hidden="true">
                    {centerMode === "edit" ? <EyeIcon /> : <PencilIcon />}
                  </span>
                  <span>{centerMode === "edit" ? t("editor.modePreview") : t("editor.modeEdit")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCommandSheetOpen(false);
                    setActiveEditKind(editKindTarget);
                  }}
                >
                  <span className="action-sheet-icon" aria-hidden="true">
                    {editKindTarget === "source" ? <CodeIcon /> : <PencilIcon />}
                  </span>
                  <span>{editKindTarget === "source" ? t("editor.modeSource") : t("editor.modeWysiwyg")}</span>
                </button>
                <button
                  type="button"
                  disabled={!dirty || saving}
                  onClick={() => {
                    setCommandSheetOpen(false);
                    save();
                  }}
                >
                  <span className="action-sheet-icon" aria-hidden="true"><SaveIcon /></span>
                  <span>{t("editor.save")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCommandSheetOpen(false);
                    printActive();
                  }}
                >
                  <span className="action-sheet-icon" aria-hidden="true"><PrintIcon /></span>
                  <span>{t("editor.print")}</span>
                </button>
                {!active.isDraft ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setCommandSheetOpen(false);
                        if (active) openRename({ type: "file", path: active.path, name: active.name });
                      }}
                    >
                      <span className="action-sheet-icon" aria-hidden="true"><PencilIcon /></span>
                      <span>{t("editor.rename")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCommandSheetOpen(false);
                        if (active) openMove({ type: "file", path: active.path, name: active.name });
                      }}
                    >
                      <span className="action-sheet-icon" aria-hidden="true"><FolderPlusIcon /></span>
                      <span>{t("editor.move")}</span>
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        setCommandSheetOpen(false);
                        if (active) openDelete({ type: "file", path: active.path, name: active.name });
                      }}
                    >
                      <span className="action-sheet-icon" aria-hidden="true"><TrashIcon /></span>
                      <span>{t("editor.delete")}</span>
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
            {/* Workspace navigation. On mobile we expose "Ask"
                because Copilot lives behind a section switch; on
                desktop the Copilot panel is always rendered (or
                visible as a 44px rail), so the Ask shortcut is
                redundant and is hidden. Indexing / Settings now
                open as overlay modals on desktop so dismissing
                the panel returns the user straight to the editor;
                on mobile they still switch the full view since a
                centered modal would be unusable on a small screen. */}
            <div className="action-sheet-group">
              {isMobile ? (
                <button
                  type="button"
                  onClick={() => {
                    setCommandSheetOpen(false);
                    switchSection("ask");
                  }}
                >
                  <span className="action-sheet-icon" aria-hidden="true"><AskIcon /></span>
                  <span>{t("section.ask")}</span>
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setCommandSheetOpen(false);
                  if (isMobile) {
                    props.onSwitchView?.("indexing");
                  } else {
                    setSettingsModalMode("indexing");
                  }
                }}
              >
                <span className="action-sheet-icon" aria-hidden="true"><IndexingIcon /></span>
                <span>{t("nav.indexing")}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setCommandSheetOpen(false);
                  if (isMobile) {
                    props.onSwitchView?.("settings");
                  } else {
                    setSettingsModalMode("settings");
                  }
                }}
              >
                <span className="action-sheet-icon" aria-hidden="true"><SettingsIcon /></span>
                <span>{t("nav.settings")}</span>
              </button>
            </div>
            {/* Preferences: theme, language, logout. */}
            <div className="action-sheet-group">
              {props.onToggleTheme ? (
                <button
                  type="button"
                  onClick={() => {
                    setCommandSheetOpen(false);
                    props.onToggleTheme!();
                  }}
                >
                  <span className="action-sheet-icon" aria-hidden="true">
                    {props.theme === "dark" ? <SunIcon /> : <MoonIcon />}
                  </span>
                  <span>{props.theme === "dark" ? t("topbar.themeLight") : t("topbar.themeDark")}</span>
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  const next = locale === "en" ? "zh" : "en";
                  setLocale(next);
                }}
              >
                <span className="action-sheet-icon" aria-hidden="true"><GlobeIcon /></span>
                <span>{locale === "en" ? "\u4e2d\u6587" : "English"}</span>
              </button>
              {props.onLogout ? (
                <button
                  type="button"
                  className="danger"
                  disabled={props.loggingOut}
                  onClick={() => {
                    setCommandSheetOpen(false);
                    props.onLogout!();
                  }}
                >
                  <span className="action-sheet-icon" aria-hidden="true"><LogoutIcon /></span>
                  <span>
                    <BusyLabel busy={!!props.loggingOut} busyText={t("topbar.logoutBusy")}>{t("topbar.logout")}</BusyLabel>
                  </span>
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
      {sortSheetOpen ? (
        <div className="modal-backdrop sheet-backdrop" role="presentation" onMouseDown={() => setSortSheetOpen(false)}>
          <section
            className="action-sheet panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sort-sheet-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="action-sheet-header">
              <h2 id="sort-sheet-title">{t("vault.sortOptions")}</h2>
              <button type="button" onClick={() => setSortSheetOpen(false)}>{t("vault.done")}</button>
            </header>
            <div className="action-sheet-group" role="radiogroup" aria-label={t("vault.sortBy")}>
              {([
                ["name", t("vault.sortName")],
                ["createdAt", t("vault.sortCreated")],
                ["updatedAt", t("vault.sortUpdated")],
                ["path", t("vault.sortPath")],
                ["title", t("vault.sortTitle")]
              ] as Array<[SortField, string]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={sort === value}
                  className={sort === value ? "active" : ""}
                  onClick={() => onSort(value, order)}
                >
                  <span>{label}</span>
                  {sort === value ? <CheckMark /> : null}
                </button>
              ))}
            </div>
            <div className="action-sheet-group" role="radiogroup" aria-label={t("vault.order")}>
              {([
                ["asc", t("vault.orderAsc")],
                ["desc", t("vault.orderDesc")]
              ] as Array<[SortOrder, string]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={order === value}
                  className={order === value ? "active" : ""}
                  onClick={() => onSort(sort, value)}
                >
                  <span>{label}</span>
                  {order === value ? <CheckMark /> : null}
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}
      {searchOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSearchOpen(false)}>
          <section className="search-modal panel" role="dialog" aria-modal="true" aria-labelledby="vault-search-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-header">
              <div>
                <p className="eyebrow">{t("search.eyebrow")}</p>
                <h2 id="vault-search-title">{t("search.title")}</h2>
                <p className="muted">{t("search.description")}</p>
              </div>
              <button type="button" onClick={() => setSearchOpen(false)}>{t("search.close")}</button>
            </div>
            <form
              className="search-form"
              onSubmit={(event) => {
                event.preventDefault();
                searchVault();
              }}
            >
              <label>
                {t("search.queryLabel")}
                <input
                  type="search"
                  inputMode="search"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus={!isMobile}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t("search.placeholder")}
                />
              </label>
              <button
                className="primary"
                type="submit"
                disabled={!searchQuery.trim() || searchLoading}
                aria-busy={searchLoading}
              >
                <BusyLabel busy={searchLoading} busyText={t("search.submitBusy")}>{t("search.submit")}</BusyLabel>
              </button>
            </form>
            {searchError ? <div className="error" aria-live="polite">{searchError}</div> : null}
            <div className="search-results" aria-live="polite">
              {!searchHasRun ? <div className="empty-state">{t("search.empty")}</div> : null}
              {searchHasRun && !searchLoading && searchResults.length === 0 ? <div className="empty-state">{t("search.noResults")}</div> : null}
              {searchResults.map((result) => (
                <button key={result.path} className="search-result" type="button" onClick={() => openSearchResult(result.path)}>
                  <strong translate="no">{result.name}</strong>
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}
      {zenMode && !isMobile ? (
        <button
          type="button"
          className="zen-exit-button"
          onClick={() => setZenMode(false)}
          aria-label={t("editor.focusExit")}
          title={t("editor.focusExit")}
        >
          <MinimizeIcon />
          <span>{t("editor.focusExit")}</span>
        </button>
      ) : null}
      {/* Settings / indexing overlay modal. Desktop only; mobile
          uses the full-view switch via onSwitchView. The dialog
          loads SettingsView with no internal back-bar so the
          modal's own close button is the single dismiss
          affordance. Outside-click and Escape both close. */}
      {!isMobile && settingsModalMode ? (
        <div
          className="modal-backdrop settings-modal-backdrop"
          role="presentation"
          onMouseDown={() => setSettingsModalMode(null)}
        >
          <section
            ref={settingsModalRef}
            className="settings-modal panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header ref={settingsHeaderRef} className="settings-modal-header">
              <div className="settings-modal-titles">
                <p className="eyebrow">
                  {settingsModalMode === "indexing" ? t("settings.eyebrowKb") : t("settings.eyebrowConfig")}
                </p>
                <h2 id="settings-modal-title">
                  {settingsModalMode === "indexing" ? t("settings.titleIndexing") : t("settings.titleSettings")}
                </h2>
              </div>
              <button
                type="button"
                className="icon-button settings-modal-close"
                onClick={() => setSettingsModalMode(null)}
                aria-label={t("modal.close")}
                title={t("modal.close")}
                data-autofocus="true"
              >
                {/* Plain SVG \u00d7 close glyph. */}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 6l12 12M6 18L18 6" />
                </svg>
              </button>
            </header>
            <div ref={settingsBodyRef} className="settings-modal-body">
              <SettingsView mode={settingsModalMode} role={props.role} />
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

const SwipeableTab = memo(function SwipeableTab(props: {
  path: string;
  name: string;
  isDraft: boolean;
  active: boolean;
  isMobile: boolean;
  closeAriaLabel: string;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const { path, name, isDraft, active, isMobile, closeAriaLabel, onActivate, onClose } = props;
  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const horizontal = useRef(false);
  const [dx, setDx] = useState(0);
  const [closing, setClosing] = useState(false);
  const swipeThreshold = 96;

  function reset(animate = false) {
    if (animate) {
      setDx(0);
    } else {
      setDx(0);
    }
    startX.current = null;
    startY.current = null;
    horizontal.current = false;
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!isMobile || event.pointerType === "mouse") return;
    startX.current = event.clientX;
    startY.current = event.clientY;
    horizontal.current = false;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // setPointerCapture can fail if the element has lost focus
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!isMobile || startX.current == null || startY.current == null) return;
    const deltaX = event.clientX - startX.current;
    const deltaY = event.clientY - startY.current;
    if (!horizontal.current) {
      if (Math.abs(deltaY) > 10 && Math.abs(deltaY) > Math.abs(deltaX)) {
        startX.current = null;
        startY.current = null;
        return;
      }
      if (Math.abs(deltaX) > 8) {
        horizontal.current = true;
      } else {
        return;
      }
    }
    if (deltaX < 0) {
      const next = Math.max(deltaX, -160);
      setDx((prev) => {
        if (-prev < swipeThreshold && -next >= swipeThreshold) haptic(4);
        return next;
      });
    } else {
      setDx(0);
    }
  }

  function onPointerUp() {
    if (!isMobile) return;
    const distance = -dx;
    startX.current = null;
    startY.current = null;
    horizontal.current = false;
    if (distance >= swipeThreshold) {
      haptic(12);
      setClosing(true);
      setDx(-260);
      window.setTimeout(() => onClose(path), 160);
      return;
    }
    setDx(0);
  }

  return (
    <div
      className={`editor-tab-shell ${active ? "active" : ""} ${closing ? "closing" : ""} ${isDraft ? "draft" : ""}`}
      style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dx === 0 || closing ? "transform 160ms ease" : "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => reset()}
    >
      <button role="tab" aria-selected={active} className="editor-tab" onClick={() => onActivate(path)}>
        <span translate={isDraft ? undefined : "no"}>{name}</span>
        {isDraft ? null : <span className="tab-path" translate="no">{path}</span>}
      </button>
      <button
        className="tab-close"
        type="button"
        aria-label={closeAriaLabel}
        onClick={(event) => {
          event.stopPropagation();
          onClose(path);
        }}
      >
        <span aria-hidden="true">{"\u00d7"}</span>
      </button>
    </div>
  );
});

interface TreeRowExtras {
  // Right-click on desktop, long-press on mobile.
  onContextMenu?: (
    node: { type: "file" | "folder"; path: string; name: string },
    x: number,
    y: number
  ) => void;
  // Drag-and-drop coordination state. dragSource is the node
  // currently being dragged (so we can hide its own row's drop
  // target highlighting); dragOverPath is the folder currently
  // hovered.
  dragSource?: { type: "file" | "folder"; path: string; name: string } | null;
  dragOverPath?: string | null;
  onDragStartNode?: (node: { type: "file" | "folder"; path: string; name: string }) => void;
  onDragEndNode?: () => void;
  onDragOverFolder?: (path: string) => void;
  onDropOnFolder?: (path: string) => void;
}

const DocumentTree = memo(function DocumentTree(props: {
  nodes: TreeNode[];
  selectedPath: string;
  selectedFolder: string;
  expandedFolders: Record<string, boolean>;
  loadingFolders?: Set<string>;
  onToggleFolder: (folderPath: string) => void;
  onSelect: (path: string) => void;
  emptyLabel: string;
} & TreeRowExtras) {
  if (props.nodes.length === 0) {
    return <div className="empty-state">{props.emptyLabel}</div>;
  }

  const { emptyLabel: _empty, ...rowProps } = props;

  return (
    <div className="doc-tree">
      {props.nodes.map((node) => (
        <TreeNodeRow key={node.id} node={node} depth={0} {...rowProps} />
      ))}
    </div>
  );
});

const TreeNodeRow = memo(function TreeNodeRow(props: {
  node: TreeNode;
  depth: number;
  selectedPath: string;
  selectedFolder: string;
  expandedFolders: Record<string, boolean>;
  loadingFolders?: Set<string>;
  onToggleFolder: (folderPath: string) => void;
  onSelect: (path: string) => void;
} & TreeRowExtras) {
  const isExpanded = props.expandedFolders[props.node.id] ?? false;
  // Long-press detection for mobile context menu. Pointer events
  // unify mouse and touch; we start a timer on pointerdown and
  // cancel it on move/up. We don't want the press to also count
  // as a click if it actually fired the menu, so we set a flag.
  const longPressRef = useRef<{ timer: number | null; fired: boolean; startX: number; startY: number }>({ timer: null, fired: false, startX: 0, startY: 0 });

  function fireMenu(target: { type: "file" | "folder"; path: string; name: string }, x: number, y: number) {
    props.onContextMenu?.(target, x, y);
  }

  function handlePointerDown(event: ReactPointerEvent, target: { type: "file" | "folder"; path: string; name: string }) {
    if (event.pointerType === "mouse") return; // desktop uses contextmenu
    longPressRef.current.fired = false;
    longPressRef.current.startX = event.clientX;
    longPressRef.current.startY = event.clientY;
    // Capture the DOM node synchronously -- React recycles the
    // synthetic event, so currentTarget is null inside setTimeout.
    const el = event.currentTarget as HTMLElement;
    longPressRef.current.timer = window.setTimeout(() => {
      longPressRef.current.fired = true;
      // Suppress the native context menu that mobile browsers fire
      // after a long touch so only our custom menu appears.
      const suppress = (e: Event) => { e.preventDefault(); };
      el.addEventListener("contextmenu", suppress, { once: true, capture: true });
      window.setTimeout(() => el.removeEventListener("contextmenu", suppress, true), 600);
      fireMenu(target, longPressRef.current.startX, longPressRef.current.startY);
    }, 500);
  }
  function handlePointerMove(event: ReactPointerEvent) {
    if (longPressRef.current.timer == null) return;
    const dx = Math.abs(event.clientX - longPressRef.current.startX);
    const dy = Math.abs(event.clientY - longPressRef.current.startY);
    if (dx > 10 || dy > 10) {
      window.clearTimeout(longPressRef.current.timer);
      longPressRef.current.timer = null;
    }
  }
  function handlePointerUp() {
    if (longPressRef.current.timer != null) {
      window.clearTimeout(longPressRef.current.timer);
      longPressRef.current.timer = null;
    }
  }

  if (props.node.type === "folder") {
    const isSelected = props.selectedFolder === props.node.id;
    const isLoading = props.loadingFolders?.has(props.node.id) ?? false;
    const showLoadingPlaceholder = isExpanded && isLoading && props.node.children.length === 0;
    const folderTarget = { type: "folder" as const, path: props.node.id, name: props.node.name || "/" };
    const isDropTarget = props.dragOverPath === props.node.id && props.dragSource && props.dragSource.path !== props.node.id;
    return (
      <div className="tree-group">
        <button
          className={`tree-row folder-row ${isSelected ? "selected" : ""} ${isDropTarget ? "drop-target" : ""}`}
          aria-expanded={isExpanded}
          aria-current={isSelected ? "true" : undefined}
          style={{ paddingLeft: `${0.65 + props.depth * 0.85}rem` }}
          onClick={(event) => {
            // Don't fire toggle when the long-press menu just popped.
            if (longPressRef.current.fired) {
              event.preventDefault();
              longPressRef.current.fired = false;
              return;
            }
            props.onToggleFolder(props.node.id);
          }}
          onContextMenu={(event) => {
            if (!props.onContextMenu) return;
            event.preventDefault();
            fireMenu(folderTarget, event.clientX, event.clientY);
          }}
          onPointerDown={(event) => handlePointerDown(event, folderTarget)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          // Drag a folder to move the whole subtree.
          draggable={Boolean(props.node.id && props.onDragStartNode)}
          onDragStart={(event) => {
            if (!props.node.id) return;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", props.node.id);
            props.onDragStartNode?.(folderTarget);
          }}
          onDragEnd={() => props.onDragEndNode?.()}
          // Accept drops from other tree nodes onto this folder.
          onDragOver={(event) => {
            if (!props.dragSource) return;
            // Forbid dropping a folder onto itself or into its
            // own subtree at the visual level too.
            if (props.dragSource.type === "folder" && (props.dragSource.path === props.node.id || props.node.id.startsWith(`${props.dragSource.path}/`))) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            if (props.dragOverPath !== props.node.id) {
              props.onDragOverFolder?.(props.node.id);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            props.onDropOnFolder?.(props.node.id);
          }}
        >
          <span className="tree-caret" aria-hidden="true">
            {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </span>
          <span className="tree-label" translate="no">{props.node.name}</span>
          {isLoading ? <span className="tree-spinner" aria-hidden="true"><SpinnerIcon /></span> : null}
        </button>
        {isExpanded
          ? props.node.children.map((child) => <TreeNodeRow key={child.id} {...props} node={child} depth={props.depth + 1} />)
          : null}
        {showLoadingPlaceholder ? (
          <div className="tree-row tree-row-placeholder" style={{ paddingLeft: `${0.65 + (props.depth + 1) * 0.85}rem` }}>
            <SpinnerIcon />
          </div>
        ) : null}
      </div>
    );
  }

  const fileTarget = props.node.document
    ? { type: "file" as const, path: props.node.document.path, name: props.node.name }
    : null;

  return (
    <button
      className={`tree-row file-row ${props.selectedPath === props.node.document?.path ? "selected" : ""}`}
      style={{ paddingLeft: `${0.65 + props.depth * 0.85}rem` }}
      aria-current={props.selectedPath === props.node.document?.path ? "true" : undefined}
      onClick={(event) => {
        if (longPressRef.current.fired) {
          event.preventDefault();
          longPressRef.current.fired = false;
          return;
        }
        props.node.document && props.onSelect(props.node.document.path);
      }}
      onContextMenu={(event) => {
        if (!fileTarget || !props.onContextMenu) return;
        event.preventDefault();
        fireMenu(fileTarget, event.clientX, event.clientY);
      }}
      onPointerDown={(event) => fileTarget && handlePointerDown(event, fileTarget)}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      draggable={Boolean(fileTarget && props.onDragStartNode)}
      onDragStart={(event) => {
        if (!fileTarget) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", fileTarget.path);
        props.onDragStartNode?.(fileTarget);
      }}
      onDragEnd={() => props.onDragEndNode?.()}
    >
      <span className="tree-file-dot" />
      <span className="tree-file-text" translate="no">
        <span className="tree-file-name">{props.node.name}</span>
        <small>{props.node.document?.path}</small>
      </span>
    </button>
  );
});

function CheckMark() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M5 12l5 5 9-11" />
    </svg>
  );
}

function AnchoredMenu(props: {
  x: number;
  y: number;
  align?: "left" | "right";
  className?: string;
  ariaLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { x, y, align = "left", className, ariaLabel, onClose, children } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y, ready: false });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const pad = 8;
    const desiredX = align === "right" ? x - rect.width : x;
    const maxX = Math.max(pad, window.innerWidth - rect.width - pad);
    const maxY = Math.max(pad, window.innerHeight - rect.height - pad);
    setPos({
      x: Math.max(pad, Math.min(desiredX, maxX)),
      y: Math.max(pad, Math.min(y, maxY)),
      ready: true
    });
  }, [align, x, y]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    function onScroll() {
      onClose();
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className={`tree-context-menu anchored-menu${className ? ` ${className}` : ""}`}
      role="menu"
      aria-label={ariaLabel}
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        visibility: pos.ready ? "visible" : "hidden",
        zIndex: 60
      }}
    >
      {children}
    </div>
  );
}

// Floating context menu shown next to a tree row. Anchored at
// the click/long-press position; clamps to the viewport so it
// never gets clipped at the edges. Closes on outside click,
// scroll, Escape, or any item click.
function TreeNodeMenu(props: {
  x: number;
  y: number;
  node: { type: "file" | "folder"; path: string; name: string };
  onClose: () => void;
  onOpen: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
  onNewNoteHere: () => void;
  onNewFolderHere: () => void;
  onCopyPath: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x: props.x, y: props.y, ready: false });

  // After mount, measure the menu and clamp it inside the
  // viewport. The first paint uses the raw click coordinate;
  // the layoutEffect-style measure runs synchronously before
  // the user can perceive the menu.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const pad = 8;
    const maxX = window.innerWidth - rect.width - pad;
    const maxY = window.innerHeight - rect.height - pad;
    setPos({
      x: Math.max(pad, Math.min(props.x, maxX)),
      y: Math.max(pad, Math.min(props.y, maxY)),
      ready: true
    });
  }, [props.x, props.y]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        props.onClose();
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") props.onClose();
    }
    function onScroll() {
      props.onClose();
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [props]);

  const isFolder = props.node.type === "folder";

  return (
    <div
      ref={ref}
      className="tree-context-menu"
      role="menu"
      aria-label={props.node.path || "/"}
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        visibility: pos.ready ? "visible" : "hidden",
        zIndex: 50
      }}
    >
      <button type="button" role="menuitem" onClick={props.onOpen}>
        {t("tree.menu.open")}
      </button>
      {isFolder ? (
        <>
          <button type="button" role="menuitem" onClick={props.onNewNoteHere}>
            {t("tree.menu.newNoteHere")}
          </button>
          <button type="button" role="menuitem" onClick={props.onNewFolderHere}>
            {t("tree.menu.newFolderHere")}
          </button>
        </>
      ) : null}
      <button type="button" role="menuitem" onClick={props.onRename}>
        {t("tree.menu.rename")}
      </button>
      <button type="button" role="menuitem" onClick={props.onMove}>
        {t("tree.menu.move")}
      </button>
      <button type="button" role="menuitem" onClick={props.onCopyPath}>
        {t("tree.menu.copyPath")}
      </button>
      <hr />
      <button type="button" role="menuitem" className="danger" onClick={props.onDelete}>
        {t("tree.menu.delete")}
      </button>
    </div>
  );
}

// Modal that combines a folder picker with a name input. Used by
// New Note, New Folder, and Rename/Move dialogs. The user picks a
// destination folder from the (folders-only) tree and types a
// name; on submit the parent constructs the final path. Errors
// from onSubmit are surfaced inline so the user can retry without
// closing the dialog.
function PathPickerModal(props: {
  mode: "create-note" | "create-folder" | "rename-file" | "rename-folder" | "move-file" | "move-folder";
  title: string;
  eyebrow?: string;
  description?: string;
  submitLabel: string;
  submitLoadingLabel: string;
  cancelLabel: string;
  errorFallback: string;
  initialFolder: string;
  initialName: string;
  folderChildren: Map<string, DocumentTreeEntry[]>;
  loadingFolders: ReadonlySet<string>;
  loadFolder: (path: string) => Promise<DocumentTreeEntry[] | null>;
  disabledFolderPrefixes?: string[];
  // Single-purpose dialogs (Rename / Move) hide one of the two
  // fields so the user only deals with one decision at a time:
  // `hideFolder` is set by the Rename dialog (only the name
  // changes); `hideName` is set by the Move dialog (only the
  // folder changes). Validators upstream still receive both
  // fields — the hidden one stays at its initial value.
  hideFolder?: boolean;
  hideName?: boolean;
  onCancel: () => void;
  onSubmit: (value: { folder: string; name: string }) => Promise<void>;
}) {
  const t = useT();
  const [folder, setFolder] = useState(props.initialFolder);
  const [name, setName] = useState(props.initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Focus + select the name input on mount so the user can
    // start typing immediately. For renames the existing name
    // is pre-selected so a single keystroke replaces it. Move
    // dialogs hide the input entirely; nothing to focus.
    if (props.hideName) return;
    const node = inputRef.current;
    if (!node) return;
    node.focus();
    if (typeof node.setSelectionRange === "function") {
      node.setSelectionRange(0, node.value.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await props.onSubmit({ folder, name });
    } catch (err) {
      setError(err instanceof Error ? err.message : props.errorFallback);
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={() => !busy && props.onCancel()}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) props.onCancel();
      }}
    >
      <section
        className="prompt-modal panel path-picker-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="path-picker-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {props.eyebrow ? <p className="eyebrow" translate="no">{props.eyebrow}</p> : null}
        <h2 id="path-picker-title">{props.title}</h2>
        {props.description ? <p className="muted">{props.description}</p> : null}
        <form
          className="prompt-form path-picker-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {props.hideFolder ? null : (
            <div>
              <label className="path-picker-section-label">{t("prompt.pickFolder")}</label>
              <FolderPicker
                folderChildren={props.folderChildren}
                loadingFolders={props.loadingFolders}
                loadFolder={props.loadFolder}
                value={folder}
                onChange={setFolder}
                disabledPrefixes={props.disabledFolderPrefixes}
              />
              <p className="muted path-picker-current" translate="no">
                {t("prompt.targetFolder", { folder: folder || t("folderPicker.vaultRoot") })}
              </p>
            </div>
          )}
          {props.hideName ? null : (
            <label>
              {props.mode === "create-folder" || props.mode === "rename-folder" ? t("prompt.folderName") : t("prompt.fileName")}
              <input
                ref={inputRef}
                name="path-picker-name"
                autoComplete="off"
                spellCheck={false}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}
          {error ? <div className="error" role="alert">{error}</div> : null}
          <div className="prompt-actions">
            <button type="button" onClick={props.onCancel} disabled={busy}>{props.cancelLabel}</button>
            <button
              type="submit"
              className="primary"
              disabled={busy || (!props.hideName && !name.trim())}
              aria-busy={busy}
            >
              <BusyLabel busy={busy} busyText={props.submitLoadingLabel}>{props.submitLabel}</BusyLabel>
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function NoticeModal(props: {
  title: string;
  eyebrow?: string;
  description: string;
  closeLabel: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        props.onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={props.onClose}>
      <section
        className="prompt-modal panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="panel-header">
          <div>
            {props.eyebrow ? <p className="eyebrow" translate="no">{props.eyebrow}</p> : null}
            <h2 id={titleId}>{props.title}</h2>
            <p className="muted" id={descId}>{props.description}</p>
          </div>
        </div>
        <div className="prompt-actions">
          <button ref={closeRef} type="button" className="primary" onClick={props.onClose}>
            {props.closeLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function ConfirmModal(props: {
  title: string;
  eyebrow?: string;
  description?: string;
  confirmLabel: string;
  confirmLoadingLabel: string;
  cancelLabel: string;
  errorFallback: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (!submitting) props.onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props, submitting]);

  async function confirm() {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await props.onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : props.errorFallback);
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!submitting) props.onCancel(); }}>
      <section
        className="prompt-modal panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={props.description ? descId : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="panel-header">
          <div>
            {props.eyebrow ? <p className="eyebrow">{props.eyebrow}</p> : null}
            <h2 id={titleId}>{props.title}</h2>
            {props.description ? <p className="muted" id={descId}>{props.description}</p> : null}
          </div>
        </div>
        {error ? <div className="error" aria-live="polite">{error}</div> : null}
        <div className="prompt-actions">
          <button ref={cancelRef} type="button" onClick={props.onCancel} disabled={submitting}>
            {props.cancelLabel}
          </button>
          <button
            className={props.danger ? "danger" : "primary"}
            type="button"
            onClick={confirm}
            disabled={submitting}
            aria-busy={submitting}
          >
            <BusyLabel busy={submitting} busyText={props.confirmLoadingLabel}>{props.confirmLabel}</BusyLabel>
          </button>
        </div>
      </section>
    </div>
  );
}
