import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { DocumentContent, DocumentSearchResult, DocumentSummary, DocumentTreeEntry, SortField, SortOrder } from "../shared/types";
import { api } from "./api";
import {
  AskIcon,
  BusyLabel,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  EyeIcon,
  GlobeIcon,
  IndexingIcon,
  LogoutIcon,
  MenuIcon,
  MoonIcon,
  MoreIcon,
  PencilIcon,
  PlusIcon,
  PrintIcon,
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
import { QaView } from "./QaView";

type MobileSection = "vault" | "editor" | "ask";
type AppView = "workspace" | "indexing" | "settings";

interface DocumentsViewProps {
  currentView?: AppView;
  theme?: "dark" | "light";
  loggingOut?: boolean;
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

// Returns the folder portion of a vault-relative file path (without
// trailing slash). Returns "" for files at the vault root, drafts, or
// empty input.
function parentFolderOf(documentPath: string): string {
  if (!documentPath || isDraftPath(documentPath)) return "";
  const lastSlash = documentPath.lastIndexOf("/");
  return lastSlash > 0 ? documentPath.slice(0, lastSlash) : "";
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


function buildDocumentTree(documents: DocumentSummary[]): TreeNode[] {
  const root: TreeNode = { id: "", name: "", type: "folder", children: [], order: 0 };

  documents.forEach((document, order) => {
    const parts = document.path.split("/");
    let current = root;

    parts.forEach((part, index) => {
      const id = parts.slice(0, index + 1).join("/");
      const isDocument = index === parts.length - 1;
      let child = current.children.find((node) => node.id === id);

      if (!child) {
        child = {
          id,
          name: part,
          type: isDocument ? "document" : "folder",
          document: isDocument ? document : undefined,
          children: [],
          order
        };
        current.children.push(child);
      }

      if (isDocument) {
        child.document = document;
        child.order = order;
      }

      current = child;
    });
  });

  function sortNodes(nodes: TreeNode[]): TreeNode[] {
    return nodes
      .map((node) => ({ ...node, children: sortNodes(node.children) }))
      .sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === "folder" ? -1 : 1;
        }
        return a.type === "folder" ? a.name.localeCompare(b.name) : a.order - b.order;
      });
  }

  return sortNodes(root.children);
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
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
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
  const [preview, setPreview] = useState("");
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
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sortSheetOpen, setSortSheetOpen] = useState(false);
  const [commandSheetOpen, setCommandSheetOpen] = useState(false);

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

  // Close any open mobile menus when leaving mobile.
  useEffect(() => {
    if (!isMobile) {
      setSortSheetOpen(false);
      setCommandSheetOpen(false);
    }
  }, [isMobile]);

  // Escape closes the command sheet.
  useEffect(() => {
    if (!commandSheetOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setCommandSheetOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [commandSheetOpen]);

  // Global quick-note triggers: window event (used by the desktop topbar
  // button) and a keyboard shortcut (Cmd/Ctrl + Shift + N). Both spawn
  // a fresh draft tab in the editor instead of opening a separate
  // capture window.
  useEffect(() => {
    function open() {
      createQuickNoteDraft();
    }
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (!event.shiftKey) return;
      if (event.key.toLowerCase() !== "n") return;
      event.preventDefault();
      createQuickNoteDraft();
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

  // Disable iOS pinch-zoom only inside the editor textarea so users can
  // still pinch-zoom previews, the document tree, and other content.
  const editorTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Paste-image-into-editor: when the user pastes an image (clipboard
  // bytes from a screenshot or a file copy) we upload it to the
  // server's attachments folder and insert an Obsidian-style
  // ![[attachments/...]] reference at the textarea cursor. While the
  // upload is in flight we insert a sentinel placeholder so the user
  // sees feedback; the placeholder is replaced once the server returns.
  const pendingAttachmentId = useRef(0);

  function insertAtCursor(textarea: HTMLTextAreaElement, snippet: string): void {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const next = `${before}${snippet}${after}`;
    setActiveDraft(next);
    // Move the caret to just after the inserted snippet on next tick.
    requestAnimationFrame(() => {
      const caret = (before + snippet).length;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  }

  async function uploadPastedImage(file: File): Promise<void> {
    const id = ++pendingAttachmentId.current;
    const placeholder = `![[uploading-${id}]]`;
    const textarea = editorTextareaRef.current;
    if (textarea) {
      insertAtCursor(textarea, placeholder);
    } else {
      // Fallback: append to draft if the ref is detached.
      setTabs((current) => current.map((tab) => (tab.path === activePath ? { ...tab, draft: `${tab.draft}${placeholder}` } : tab)));
    }
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
      const replacement = `![[${result.path}]]`;
      // Replace the placeholder in whatever the active tab's draft is
      // *now* (the user may have continued typing during the upload).
      setTabs((current) => current.map((tab) => {
        if (tab.path !== activePath) return tab;
        if (!tab.draft.includes(placeholder)) return tab;
        return { ...tab, draft: tab.draft.replace(placeholder, replacement) };
      }));
      setStatusKey("status.attachmentSaved");
    } catch (error) {
      // Turn the placeholder into a comment so it doesn't render in
      // preview and the user sees what went wrong inline.
      const message = error instanceof Error ? error.message : "Upload failed";
      const errorMarker = `<!-- attachment upload failed: ${message.replace(/-->/g, "")} -->`;
      setTabs((current) => current.map((tab) => {
        if (tab.path !== activePath) return tab;
        if (!tab.draft.includes(placeholder)) return tab;
        return { ...tab, draft: tab.draft.replace(placeholder, errorMarker) };
      }));
      setStatusText(`${t("status.uploadFailed")}: ${message}`);
    }
  }

  function onEditorPaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
    if (!event.clipboardData || event.clipboardData.files.length === 0) return;
    const images: File[] = [];
    for (const file of Array.from(event.clipboardData.files)) {
      if (file.type.startsWith("image/")) images.push(file);
    }
    if (images.length === 0) return;
    event.preventDefault();
    images.forEach((image) => {
      uploadPastedImage(image);
    });
  }

  // Pinch-zoom suppression only inside the editor textarea so users
  // can still pinch-zoom previews, the document tree, etc.
  useEffect(() => {
    const node = editorTextareaRef.current;
    if (!node) return;
    function onTouchMove(event: TouchEvent) {
      if (event.touches.length > 1) {
        event.preventDefault();
      }
    }
    function onGestureStart(event: Event) {
      event.preventDefault();
    }
    node.addEventListener("touchmove", onTouchMove, { passive: false });
    node.addEventListener("gesturestart", onGestureStart);
    return () => {
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("gesturestart", onGestureStart);
    };
  }, [active]);

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
    //   swipe left  from the right edge -> open ask sheet
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

  async function loadFolderChildren(
    folderPath: string,
    options: { force?: boolean; silent?: boolean } = {}
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
        const treeSort: "name" | "updatedAt" = sort === "updatedAt" ? "updatedAt" : "name";
        params.set("sort", treeSort);
        params.set("order", order);
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
  }

  // Recursive background prefetch with a small concurrency cap so
  // the foreground UI stays responsive. Yields between batches via
  // requestIdleCallback (falls back to setTimeout) so user
  // interactions get processed first. Cancelled when the
  // generation counter is bumped (refreshDocuments invalidates).
  async function prefetchFolderTree(rootChildren: DocumentTreeEntry[]): Promise<void> {
    const tracker = folderFetchTracker.current;
    const generation = tracker.generation;
    const queue: string[] = rootChildren
      .filter((entry) => entry.type === "folder" && (entry.hasChildren ?? true))
      .map((entry) => entry.path);
    const concurrency = 2;

    async function processOne(): Promise<void> {
      if (tracker.generation !== generation) return;
      const next = queue.shift();
      if (!next) return;
      if (tracker.loaded.has(next) || tracker.inFlight.has(next)) {
        return processOne();
      }
      const fetched = await loadFolderChildren(next, { silent: true });
      if (tracker.generation !== generation) return;
      // Push this folder's sub-folders so the prefetch goes deep
      // but breadth-first.
      if (fetched) {
        for (const child of fetched) {
          if (child.type === "folder" && (child.hasChildren ?? true)) {
            queue.push(child.path);
          }
        }
      }
      // Yield to the event loop before scheduling the next fetch
      // so any in-flight user gesture (tap to expand a specific
      // folder, scroll) is processed first.
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
  }

  async function refreshDocuments(nextSort = sort, nextOrder = order) {
    // Bumping the generation cancels any in-flight prefetch from a
    // previous refresh: stale results are dropped on the floor and
    // prefetch loops exit at their next yield point.
    folderFetchTracker.current.generation += 1;
    folderFetchTracker.current.loaded.clear();
    folderFetchTracker.current.inFlight = new Map();

    setFolderChildren(new Map());
    // Fetch the root immediately so the sidebar appears within
    // milliseconds even on a multi-thousand-file vault.
    const rootChildren = await loadFolderChildren("", { force: true });
    // After the root renders, kick off a background prefetch of
    // every other folder. The user can keep interacting; the
    // prefetch yields to idle time. Once it finishes, expanding
    // any folder is instant because the children are already in
    // the cache.
    if (rootChildren && rootChildren.length > 0) {
      void prefetchFolderTree(rootChildren);
    }
    // /api/documents is still fetched in parallel for the file
    // count and any feature that needs real metadata. It does not
    // gate the tree appearing.
    const docs = await api<DocumentSummary[]>(`/api/documents?sort=${nextSort}&order=${nextOrder}`);
    setDocuments(docs);
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
    refreshDocuments().catch((error) => setStatusText(error.message));
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
        // Opening an existing file lands in preview mode so the
        // reader immediately sees the rendered note. Each tab
        // tracks its own mode after this.
        setTabs((current) => [...current, { ...doc, draft: doc.content, mode: "preview" }]);
      })
      .catch((error) => setStatusText(error.message));
  }, [activePath, tabs]);

  // Re-render the preview whenever the draft text or active document
  // changes. We depend on the primitive draft string + path rather than
  // the active object itself so React's identity comparison is stable
  // and tied to the actual content the preview renders from.
  useEffect(() => {
    if (!active) {
      setPreview("");
      return;
    }

    const draft = active.draft;
    const isDraft = active.isDraft;
    const path = active.path;
    const timer = window.setTimeout(() => {
      api<{ html: string }>("/api/documents/preview", {
        method: "POST",
        body: JSON.stringify({
          // Don't send a synthetic draft path to the server.
          path: isDraft ? undefined : path,
          content: draft
        })
      })
        .then((result) => setPreview(result.html))
        .catch(() => setPreview(""));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [active?.draft, active?.path, active?.isDraft]);

  // Mode is per-tab: switching Edit/Preview only affects the
  // currently active tab. Other open tabs keep whatever mode the
  // user left them in. No localStorage persistence: tab modes are
  // session state, not a user preference.
  function setActiveMode(nextMode: "edit" | "preview") {
    if (!activePath) return;
    setTabs((current) => current.map((tab) => (tab.path === activePath ? { ...tab, mode: nextMode } : tab)));
  }

  function setActiveDraft(nextDraft: string) {
    setTabs((current) => current.map((tab) => (tab.path === activePath ? { ...tab, draft: nextDraft } : tab)));
  }

  function closeTab(path: string) {
    const closed = tabs.find((tab) => tab.path === path);
    setTabs((current) => current.filter((tab) => tab.path !== path));
    const wasActive = activePath === path;
    if (wasActive) {
      const remaining = tabs.filter((tab) => tab.path !== path);
      setActivePath(remaining[remaining.length - 1]?.path ?? "");
    }
    if (closed) {
      const label = closed.isDraft
        ? `${t("undo.closedPrefix")} ${t("quick.draftTitle")}`
        : `${t("undo.closedPrefix")} ${closed.name}`;
      offerUndo({ kind: "close-tab", tab: closed, wasActive, label });
    }
  }

  // Print the rendered preview of the active document. Uses the
  // browser's native print dialog (so the user can choose AirPrint,
  // a real printer, or Save-as-PDF) and a print-only stylesheet that
  // hides app chrome and shows just the .print-surface article.
  // Drafts work too because the preview pipeline runs against the
  // draft buffer regardless of save state.
  function printActive(): void {
    if (!active) return;
    if (!preview) {
      setStatusKey("status.printNothing");
      return;
    }
    const previousTitle = document.title;
    const docName = active.name?.replace(/\.md$/i, "") || (active.isDraft ? t("quick.draftTitle") : t("editor.title"));
    document.title = `${t("app.brand.name")} - ${docName}`;
    function restore() {
      document.title = previousTitle;
      window.removeEventListener("afterprint", restore);
    }
    window.addEventListener("afterprint", restore);
    // Defer slightly so the title change makes it into the print
    // dialog (some browsers snapshot title at print() call time).
    window.setTimeout(() => {
      window.print();
      // Safari iOS doesn't always fire afterprint, so restore
      // proactively after a generous timeout too.
      window.setTimeout(restore, 6000);
    }, 30);
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
        const saved = await api<DocumentContent>("/api/documents/content", {
          method: "PUT",
          body: JSON.stringify({ path: active.path, content: active.draft, expectedHash: active.hash })
        });
        // Preserve the tab's current mode across the save: the
        // post-save preview switch is applied separately by the
        // caller, so a silent autosave never changes mode.
        setTabs((current) => current.map((tab) => (tab.path === saved.path ? { ...saved, draft: saved.content, mode: tab.mode } : tab)));
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
        setTabs((current) => current.map((tab) => (tab.path === draftTab.path ? { ...created, draft: created.content, mode: "preview" } : tab)));
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
          setRenameOpen(true);
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
      mode: "edit"
    };
    setTabs((current) => [...current, draftTab]);
    setActivePath(draftPath);
    if (isMobile) {
      setMobileSection("editor");
    }
    haptic(6);
    // Focus the editor textarea after the draft mounts.
    window.setTimeout(() => {
      editorTextareaRef.current?.focus();
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
      setTabs((current) => [...current.filter((tab) => tab.path !== created.path), { ...created, draft: created.content, mode: "edit" }]);
      openDocument(created.path);
      setStatusKey("status.created");
    } catch (error) {
      if (error instanceof Error) setStatusText(error.message);
      else setStatusKey("status.createFailed");
      throw error;
    }
  }

  async function renameActive(nextPath: string) {
    if (!active) {
      return;
    }
    if (!nextPath || nextPath === active.path) {
      return;
    }
    setStatusKey("status.renaming");
    try {
      const renamed = await api<DocumentContent>("/api/documents/rename", {
        method: "PATCH",
        body: JSON.stringify({ path: active.path, nextPath })
      });
      setTabs((current) =>
        current.map((tab) => (tab.path === active.path ? { ...renamed, draft: tab.draft, mode: tab.mode } : tab))
      );
      setActivePath(renamed.path);
      await refreshDocuments();
      setStatusKey("status.renamed");
    } catch (error) {
      if (error instanceof Error) setStatusText(error.message);
      else setStatusKey("status.renameFailed");
      throw error;
    }
  }

  async function deleteActive() {
    if (!active) {
      return;
    }
    const snapshotPath = active.path;
    const snapshotContent = active.draft;
    const snapshotName = active.name;
    setStatusKey("status.deleting");
    try {
      await api("/api/documents/content", {
        method: "DELETE",
        body: JSON.stringify({ path: snapshotPath })
      });
      setTabs((current) => current.filter((tab) => tab.path !== snapshotPath));
      if (activePath === snapshotPath) {
        const remaining = tabs.filter((tab) => tab.path !== snapshotPath);
        setActivePath(remaining[remaining.length - 1]?.path ?? "");
      }
      await refreshDocuments();
      setStatusKey("status.deleted");
      offerUndo({
        kind: "delete-document",
        path: snapshotPath,
        content: snapshotContent,
        label: `${t("undo.deletedPrefix")} ${snapshotName}`
      });
    } catch (error) {
      if (error instanceof Error) setStatusText(error.message);
      else setStatusKey("status.deleteFailed");
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
        { ...restored, draft: restored.content, mode: "preview" }
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

  return (
    <main
      className="workspace-grid obsidian-workspace"
      data-mobile-section={mobileSection}
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
            onClick={() => switchSection("vault")}
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
            onClick={() => setCommandSheetOpen(true)}
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
              {t(documents.length === 1 ? "vault.fileCount" : "vault.fileCountPlural", { count: documents.length })}
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
              aria-label={t("vault.new")}
              onClick={() => {
                if (isMobile) closeOverlays();
                setCreateOpen(true);
              }}
            >
              <PlusIcon />
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
        <div className="panel-header desktop-only">
          <div>
            <p className="eyebrow">{t("vault.eyebrow")}</p>
            <h2>{t("vault.title")}</h2>
            <p className="muted">
              {t(documents.length === 1 ? "vault.fileCount" : "vault.fileCountPlural", { count: documents.length })}
            </p>
          </div>
        </div>
        <div className="vault-toolbar desktop-only">
          <button className="primary" onClick={() => setSearchOpen(true)}>{t("vault.searchVault")}</button>
          <button onClick={() => setCreateOpen(true)}>{t("vault.newNote")}</button>
        </div>
        <div className="sort-row desktop-only">
          <label>
            {t("vault.sortBy")}
            <select name="document-sort" value={sort} onChange={(event) => onSort(event.target.value as SortField, order)}>
              <option value="name">{t("vault.sortName")}</option>
              <option value="createdAt">{t("vault.sortCreated")}</option>
              <option value="updatedAt">{t("vault.sortUpdated")}</option>
              <option value="path">{t("vault.sortPath")}</option>
              <option value="title">{t("vault.sortTitle")}</option>
            </select>
          </label>
          <label>
            {t("vault.order")}
            <select name="document-order" value={order} onChange={(event) => onSort(sort, event.target.value as SortOrder)}>
              <option value="asc">{t("vault.orderAsc")}</option>
              <option value="desc">{t("vault.orderDesc")}</option>
            </select>
          </label>
        </div>
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
            onToggleFolder={(folderPath) => {
              setExpandedFolders((current) => {
                const wasExpanded = current[folderPath] ?? false;
                if (!wasExpanded) {
                  // Lazy-fetch the folder's direct children on first
                  // expand. The fetch is a no-op when already loaded.
                  void loadFolderChildren(folderPath);
                }
                return { ...current, [folderPath]: !wasExpanded };
              });
              setSelectedFolder(folderPath);
            }}
            loadingFolders={loadingFolders}
            onSelect={openDocument}
            emptyLabel={t("vault.empty")}
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
        <div className="panel-header desktop-only">
          <div>
            <p className="eyebrow" translate={active && !active.isDraft ? "no" : undefined}>
              {active?.isDraft ? t("quick.draftEyebrow") : (active?.path ?? t("editor.noDocSelected"))}
            </p>
            <h2 translate={active && !active.isDraft ? "no" : undefined}>
              {active?.isDraft ? t("quick.draftTitle") : (active?.name ?? t("editor.title"))}
              {active?.isDraft ? <span className="draft-pill" aria-hidden="true">{t("quick.draftBadge")}</span> : null}
            </h2>
          </div>
          <span className="status status-pill" aria-live="polite">
            {status.kind === "key" ? t(status.key, status.params) : status.text}
          </span>
        </div>
        <div className="editor-toolbar desktop-only" aria-label={t("editor.actionsLabel")}>
          <div className="mode-switch" role="group" aria-label={t("editor.modeLabel")}>
            <button className={centerMode === "edit" ? "active" : ""} aria-pressed={centerMode === "edit"} onClick={() => setActiveMode("edit")}>
              {t("editor.modeEdit")}
            </button>
            <button className={centerMode === "preview" ? "active" : ""} aria-pressed={centerMode === "preview"} onClick={() => setActiveMode("preview")}>
              {t("editor.modePreview")}
            </button>
          </div>
          <div className="file-actions">
            <button onClick={printActive} disabled={!active}>
              {t("editor.print")}
            </button>
            <button onClick={() => setRenameOpen(true)} disabled={!active || active.isDraft}>
              {t("editor.rename")}
            </button>
            <button className="danger" onClick={() => setDeleteOpen(true)} disabled={!active || active.isDraft}>
              {t("editor.delete")}
            </button>
            <button className="primary" onClick={save} disabled={!active || saving} aria-busy={saving}>
              <BusyLabel busy={saving} busyText={t("editor.saveBusy")}>{t("editor.save")}</BusyLabel>
            </button>
          </div>
        </div>
        <div className="tab-strip" role="tablist" aria-label={t("editor.tabsLabel")}>
          {tabs.map((tab) => (
            <SwipeableTab
              key={tab.path}
              tab={tab}
              active={activePath === tab.path}
              isMobile={isMobile}
              closeAriaLabel={t("editor.closeTab", { name: tab.name })}
              onActivate={() => setActivePath(tab.path)}
              onClose={() => closeTab(tab.path)}
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
        {active && centerMode === "edit" ? (
          <label className="editor-field">
            <span className="sr-only">{t("editor.contentLabel")}</span>
            <textarea
              ref={editorTextareaRef}
              name="markdown-content"
              value={active.draft}
              onChange={(event) => setActiveDraft(event.target.value)}
              onPaste={onEditorPaste}
              spellCheck={false}
            />
          </label>
        ) : null}
        {active && centerMode === "preview" ? (
          <div className="preview-surface">
            {preview ? <article dangerouslySetInnerHTML={{ __html: preview }} /> : <div className="empty-state">{t("editor.previewEmpty")}</div>}
          </div>
        ) : null}
        {!active ? (
          <div className="blank-editor">
            <p className="eyebrow">{t("editor.blankEyebrow")}</p>
            <h2>{t("editor.blankTitle")}</h2>
            <p className="muted">{t("editor.blankBody")}</p>
          </div>
        ) : null}
        {/* Hidden print surface: holds the latest rendered preview for
            window.print() so the user can print directly from edit
            mode without flipping to preview first. Hidden in normal
            screen rendering and revealed by the @media print rules. */}
        {active && preview ? (
          <div className="print-surface" aria-hidden="true">
            <article dangerouslySetInnerHTML={{ __html: preview }} />
          </div>
        ) : null}
      </section>
      <div
        className="qa-section-wrapper"
        data-section="ask"
        id={isMobile ? "section-panel-ask" : undefined}
        role={isMobile ? "tabpanel" : undefined}
        aria-labelledby={isMobile ? "section-tab-ask" : undefined}
      >
        <QaView compact onOpenSource={openDocument} />
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
      {createOpen ? (
        <PromptModal
          title={t("prompt.create.title")}
          eyebrow={t("prompt.create.eyebrow")}
          description={t("prompt.create.description")}
          label={t("prompt.create.label")}
          placeholder={t("prompt.create.placeholder")}
          initialValue={defaultNewNotePath(selectedFolder)}
          submitLabel={t("prompt.create.submit")}
          submitLoadingLabel={t("prompt.create.submitBusy")}
          cancelLabel={t("prompt.cancel")}
          errorFallback={t("error.actionFailed")}
          isMobile={isMobile}
          onCancel={() => setCreateOpen(false)}
          onSubmit={async (value) => {
            await createDocument(value);
            setCreateOpen(false);
          }}
        />
      ) : null}
      {renameOpen && active ? (
        <PromptModal
          title={t("prompt.rename.title")}
          eyebrow={active.path}
          description={t("prompt.rename.description")}
          label={t("prompt.rename.label")}
          placeholder={active.path}
          initialValue={active.path}
          submitLabel={t("prompt.rename.submit")}
          submitLoadingLabel={t("prompt.rename.submitBusy")}
          cancelLabel={t("prompt.cancel")}
          errorFallback={t("error.actionFailed")}
          isMobile={isMobile}
          onCancel={() => setRenameOpen(false)}
          onSubmit={async (value) => {
            await renameActive(value);
            setRenameOpen(false);
          }}
        />
      ) : null}
      {deleteOpen && active ? (
        <ConfirmModal
          title={t("confirm.delete.title", { name: active.name })}
          eyebrow={active.path}
          description={t("confirm.delete.description")}
          confirmLabel={t("confirm.delete.submit")}
          confirmLoadingLabel={t("confirm.delete.submitBusy")}
          cancelLabel={t("prompt.cancel")}
          errorFallback={t("error.actionFailed")}
          danger
          onCancel={() => setDeleteOpen(false)}
          onConfirm={async () => {
            await deleteActive();
            setDeleteOpen(false);
          }}
        />
      ) : null}
      {commandSheetOpen ? (
        <div className="modal-backdrop sheet-backdrop" role="presentation" onMouseDown={() => setCommandSheetOpen(false)}>
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
                        setRenameOpen(true);
                      }}
                    >
                      <span className="action-sheet-icon" aria-hidden="true"><PencilIcon /></span>
                      <span>{t("editor.rename")}</span>
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        setCommandSheetOpen(false);
                        setDeleteOpen(true);
                      }}
                    >
                      <span className="action-sheet-icon" aria-hidden="true"><TrashIcon /></span>
                      <span>{t("editor.delete")}</span>
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
            {/* Workspace navigation: open Ask, jump to Indexing or Settings. */}
            <div className="action-sheet-group">
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
              {props.onSwitchView ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setCommandSheetOpen(false);
                      props.onSwitchView!("indexing");
                    }}
                  >
                    <span className="action-sheet-icon" aria-hidden="true"><IndexingIcon /></span>
                    <span>{t("nav.indexing")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCommandSheetOpen(false);
                      props.onSwitchView!("settings");
                    }}
                  >
                    <span className="action-sheet-icon" aria-hidden="true"><SettingsIcon /></span>
                    <span>{t("nav.settings")}</span>
                  </button>
                </>
              ) : null}
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
    </main>
  );
}

function SwipeableTab(props: {
  tab: OpenTab;
  active: boolean;
  isMobile: boolean;
  closeAriaLabel: string;
  onActivate: () => void;
  onClose: () => void;
}) {
  const { tab, active, isMobile, closeAriaLabel, onActivate, onClose } = props;
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
      window.setTimeout(onClose, 160);
      return;
    }
    setDx(0);
  }

  return (
    <div
      className={`editor-tab-shell ${active ? "active" : ""} ${closing ? "closing" : ""} ${tab.isDraft ? "draft" : ""}`}
      style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dx === 0 || closing ? "transform 160ms ease" : "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => reset()}
    >
      <button role="tab" aria-selected={active} className="editor-tab" onClick={onActivate}>
        <span translate={tab.isDraft ? undefined : "no"}>{tab.name}</span>
        {tab.isDraft ? null : <span className="tab-path" translate="no">{tab.path}</span>}
      </button>
      <button
        className="tab-close"
        type="button"
        aria-label={closeAriaLabel}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      >
        <span aria-hidden="true">{"\u00d7"}</span>
      </button>
    </div>
  );
}

function DocumentTree(props: {
  nodes: TreeNode[];
  selectedPath: string;
  selectedFolder: string;
  expandedFolders: Record<string, boolean>;
  loadingFolders?: Set<string>;
  onToggleFolder: (folderPath: string) => void;
  onSelect: (path: string) => void;
  emptyLabel: string;
}) {
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
}

function TreeNodeRow(props: {
  node: TreeNode;
  depth: number;
  selectedPath: string;
  selectedFolder: string;
  expandedFolders: Record<string, boolean>;
  loadingFolders?: Set<string>;
  onToggleFolder: (folderPath: string) => void;
  onSelect: (path: string) => void;
}) {
  const isExpanded = props.expandedFolders[props.node.id] ?? false;

  if (props.node.type === "folder") {
    const isSelected = props.selectedFolder === props.node.id;
    const isLoading = props.loadingFolders?.has(props.node.id) ?? false;
    const showLoadingPlaceholder = isExpanded && isLoading && props.node.children.length === 0;
    return (
      <div className="tree-group">
        <button
          className={`tree-row folder-row ${isSelected ? "selected" : ""}`}
          aria-expanded={isExpanded}
          aria-current={isSelected ? "true" : undefined}
          style={{ paddingLeft: `${0.65 + props.depth * 0.85}rem` }}
          onClick={() => props.onToggleFolder(props.node.id)}
        >
          <span className="tree-caret" aria-hidden="true">
            {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </span>
          <span className="tree-label">{props.node.name}</span>
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

  return (
    <button
      className={`tree-row file-row ${props.selectedPath === props.node.document?.path ? "selected" : ""}`}
      style={{ paddingLeft: `${0.65 + props.depth * 0.85}rem` }}
      aria-current={props.selectedPath === props.node.document?.path ? "true" : undefined}
      onClick={() => props.node.document && props.onSelect(props.node.document.path)}
    >
      <span className="tree-file-dot" />
      <span className="tree-file-text" translate="no">
        <span className="tree-file-name">{props.node.name}</span>
        <small>{props.node.document?.path}</small>
      </span>
    </button>
  );
}

function CheckMark() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M5 12l5 5 9-11" />
    </svg>
  );
}

function PromptModal(props: {
  title: string;
  eyebrow?: string;
  description?: string;
  label: string;
  placeholder: string;
  initialValue: string;
  submitLabel: string;
  submitLoadingLabel: string;
  cancelLabel: string;
  errorFallback: string;
  isMobile: boolean;
  onCancel: () => void;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(props.initialValue);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (props.isMobile) return;
    const node = inputRef.current;
    if (!node) return;
    node.focus();
    if (typeof node.setSelectionRange === "function") {
      node.setSelectionRange(0, node.value.length);
    }
  }, [props.isMobile]);

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

  async function submit() {
    const trimmed = value.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await props.onSubmit(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : props.errorFallback);
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!submitting) props.onCancel(); }}>
      <section
        className="prompt-modal panel"
        role="dialog"
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
          <button type="button" onClick={props.onCancel} disabled={submitting}>
            {props.cancelLabel}
          </button>
        </div>
        <form
          className="prompt-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label>
            {props.label}
            <input
              ref={inputRef}
              name="prompt-value"
              autoComplete="off"
              spellCheck={false}
              value={value}
              placeholder={props.placeholder}
              onChange={(event) => setValue(event.target.value)}
              disabled={submitting}
            />
          </label>
          {error ? <div className="error" aria-live="polite">{error}</div> : null}
          <div className="prompt-actions">
            <button type="button" onClick={props.onCancel} disabled={submitting}>
              {props.cancelLabel}
            </button>
            <button
              className="primary"
              type="submit"
              disabled={!value.trim() || submitting}
              aria-busy={submitting}
            >
              <BusyLabel busy={submitting} busyText={props.submitLoadingLabel}>{props.submitLabel}</BusyLabel>
            </button>
          </div>
        </form>
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
