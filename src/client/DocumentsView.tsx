import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { DocumentContent, DocumentSearchResult, DocumentSummary, SortField, SortOrder } from "../shared/types";
import { api } from "./api";
import { BusyLabel, ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, SaveIcon, SpinnerIcon } from "./icons";
import { useT } from "./i18n";
import type { TKey } from "./i18n";
import { QaView } from "./QaView";

type MobileSection = "vault" | "editor" | "ask";

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
};

const sortStorageKey = "owd_document_sort";
const editorModeStorageKey = "owd_editor_mode";

function readSavedSort(): { sort: SortField; order: SortOrder } {
  try {
    const saved = JSON.parse(localStorage.getItem(sortStorageKey) ?? "{}") as { sort?: SortField; order?: SortOrder };
    const sort: SortField = ["name", "createdAt", "updatedAt", "path", "title"].includes(saved.sort ?? "") ? saved.sort! : "name";
    const order: SortOrder = saved.order === "desc" ? "desc" : "asc";
    return { sort, order };
  } catch {
    return { sort: "name", order: "asc" };
  }
}

function readSavedEditorMode(): "edit" | "preview" {
  return localStorage.getItem(editorModeStorageKey) === "preview" ? "preview" : "edit";
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

export function DocumentsView() {
  const t = useT();
  const savedSort = useMemo(readSavedSort, []);
  const isMobile = useIsMobile();
  const [mobileSection, setMobileSection] = useState<MobileSection>("vault");
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [activePath, setActivePath] = useState("");
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [preview, setPreview] = useState("");
  const [centerMode, setCenterMode] = useState<"edit" | "preview">(readSavedEditorMode);
  const [sort, setSort] = useState<SortField>(savedSort.sort);
  const [order, setOrder] = useState<SortOrder>(savedSort.order);
  const [status, setStatus] = useState<StatusValue>(READY_STATUS);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
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
  const documentTree = useMemo(() => buildDocumentTree(documents), [documents]);
  const active = tabs.find((tab) => tab.path === activePath) ?? null;

  const openDocument = useCallback(
    (path: string) => {
      setActivePath(path);
      if (isMobile) {
        setMobileSection((current) => {
          if (current !== "editor") haptic(6);
          return "editor";
        });
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
    const sections: MobileSection[] = ["vault", "editor", "ask"];
    const idx = sections.indexOf(mobileSection);
    if (idx < 0) return;
    if (start.fromEdge === "left" && dx >= 60 && idx > 0) {
      switchSection(sections[idx - 1]);
    } else if (start.fromEdge === "right" && dx <= -60 && idx < sections.length - 1) {
      switchSection(sections[idx + 1]);
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

  async function refreshDocuments(nextSort = sort, nextOrder = order) {
    const docs = await api<DocumentSummary[]>(`/api/documents?sort=${nextSort}&order=${nextOrder}`);
    setDocuments(docs);
  }

  function setStatusKey(key: TKey, params?: Record<string, string | number>) {
    setStatus({ kind: "key", key, params });
  }
  function setStatusText(text: string) {
    setStatus({ kind: "text", text });
  }

  useEffect(() => {
    refreshDocuments().catch((error) => setStatusText(error.message));
  }, []);

  useEffect(() => {
    if (!activePath || tabs.some((tab) => tab.path === activePath)) {
      return;
    }
    api<DocumentContent>(`/api/documents/content?path=${encodeURIComponent(activePath)}`)
      .then((doc) => {
        setTabs((current) => [...current, { ...doc, draft: doc.content }]);
      })
      .catch((error) => setStatusText(error.message));
  }, [activePath, tabs]);

  useEffect(() => {
    if (!active) {
      setPreview("");
      return;
    }

    const timer = window.setTimeout(() => {
      api<{ html: string }>("/api/documents/preview", {
        method: "POST",
        body: JSON.stringify({ path: active.path, content: active.draft })
      })
        .then((result) => setPreview(result.html))
        .catch(() => setPreview(""));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [active]);

  function setGlobalCenterMode(nextMode: "edit" | "preview") {
    setCenterMode(nextMode);
    localStorage.setItem(editorModeStorageKey, nextMode);
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
      offerUndo({ kind: "close-tab", tab: closed, wasActive, label: `${t("undo.closedPrefix")} ${closed.name}` });
    }
  }

  async function save() {
    if (!active || saving) {
      return;
    }
    setSaving(true);
    setStatusKey("status.saving");
    try {
      const saved = await api<DocumentContent>("/api/documents/content", {
        method: "PUT",
        body: JSON.stringify({ path: active.path, content: active.draft, expectedHash: active.hash })
      });
      setTabs((current) => current.map((tab) => (tab.path === saved.path ? { ...saved, draft: saved.content } : tab)));
      await refreshDocuments();
      setStatusKey("status.saved");
    } catch (error) {
      if (error instanceof Error) setStatusText(error.message);
      else setStatusKey("status.saveFailed");
    } finally {
      setSaving(false);
    }
  }

  const dirty = active ? active.draft !== active.content : false;

  async function createDocument(name: string) {
    try {
      const created = await api<DocumentContent>("/api/documents", {
        method: "POST",
        body: JSON.stringify({ path: name })
      });
      await refreshDocuments();
      setTabs((current) => [...current.filter((tab) => tab.path !== created.path), { ...created, draft: created.content }]);
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
        current.map((tab) => (tab.path === active.path ? { ...renamed, draft: tab.draft } : tab))
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
        { ...restored, draft: restored.content }
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
      {isMobile ? (
        <nav
          className="mobile-segmented"
          role="tablist"
          aria-label={t("section.aria")}
          aria-orientation="horizontal"
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const sections: MobileSection[] = ["vault", "editor", "ask"];
            const idx = sections.indexOf(mobileSection);
            const nextIdx = event.key === "ArrowLeft"
              ? (idx + sections.length - 1) % sections.length
              : (idx + 1) % sections.length;
            const next = sections[nextIdx];
            switchSection(next);
            const target = event.currentTarget.querySelector<HTMLButtonElement>(`[data-section-tab="${next}"]`);
            target?.focus();
          }}
        >
          <button
            type="button"
            role="tab"
            id="section-tab-vault"
            data-section-tab="vault"
            aria-selected={mobileSection === "vault"}
            aria-controls="section-panel-vault"
            tabIndex={mobileSection === "vault" ? 0 : -1}
            className={mobileSection === "vault" ? "active" : ""}
            onClick={() => switchSection("vault")}
          >
            {t("section.vault")}
          </button>
          <button
            type="button"
            role="tab"
            id="section-tab-editor"
            data-section-tab="editor"
            aria-selected={mobileSection === "editor"}
            aria-controls="section-panel-editor"
            tabIndex={mobileSection === "editor" ? 0 : -1}
            className={mobileSection === "editor" ? "active" : ""}
            onClick={() => switchSection("editor")}
          >
            {t("section.editor")}
          </button>
          <button
            type="button"
            role="tab"
            id="section-tab-ask"
            data-section-tab="ask"
            aria-selected={mobileSection === "ask"}
            aria-controls="section-panel-ask"
            tabIndex={mobileSection === "ask" ? 0 : -1}
            className={mobileSection === "ask" ? "active" : ""}
            onClick={() => switchSection("ask")}
          >
            {t("section.ask")}
          </button>
        </nav>
      ) : null}
      <section
        className="document-list panel vault-pane"
        data-section="vault"
        id={isMobile ? "section-panel-vault" : undefined}
        role={isMobile ? "tabpanel" : undefined}
        aria-labelledby={isMobile ? "section-tab-vault" : undefined}
      >
        <div className="panel-header">
          <div>
            <p className="eyebrow">{t("vault.eyebrow")}</p>
            <h2>{t("vault.title")}</h2>
            <p className="muted">
              {t(documents.length === 1 ? "vault.fileCount" : "vault.fileCountPlural", { count: documents.length })}
            </p>
          </div>
        </div>
        <div className="vault-toolbar">
          <button className="primary" onClick={() => setSearchOpen(true)}>{t("vault.searchVault")}</button>
          <button onClick={() => setCreateOpen(true)}>{t("vault.newNote")}</button>
        </div>
        <div className="sort-row">
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
            expandedFolders={expandedFolders}
            onToggleFolder={(folderPath) => setExpandedFolders((current) => ({ ...current, [folderPath]: !(current[folderPath] ?? false) }))}
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
        <div className="panel-header">
          <div>
            <p className="eyebrow">{active?.path ?? t("editor.noDocSelected")}</p>
            <h2>{active?.name ?? t("editor.title")}</h2>
          </div>
          <span className="status status-pill" aria-live="polite">
            {status.kind === "key" ? t(status.key, status.params) : status.text}
          </span>
        </div>
        <div className="editor-toolbar" aria-label={t("editor.actionsLabel")}>
          <div className="mode-switch" role="group" aria-label={t("editor.modeLabel")}>
            <button className={centerMode === "edit" ? "active" : ""} aria-pressed={centerMode === "edit"} onClick={() => setGlobalCenterMode("edit")}>
              {t("editor.modeEdit")}
            </button>
            <button className={centerMode === "preview" ? "active" : ""} aria-pressed={centerMode === "preview"} onClick={() => setGlobalCenterMode("preview")}>
              {t("editor.modePreview")}
            </button>
          </div>
          <div className="file-actions">
            <button onClick={() => setRenameOpen(true)} disabled={!active}>
              {t("editor.rename")}
            </button>
            <button className="danger" onClick={() => setDeleteOpen(true)} disabled={!active}>
              {t("editor.delete")}
            </button>
            <button className="primary" onClick={save} disabled={!active || saving} aria-busy={saving}>
              <BusyLabel busy={saving} busyText={t("editor.saveBusy")}>{t("editor.save")}</BusyLabel>
            </button>
          </div>
        </div>
        {tabs.length > 0 ? (
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
          </div>
        ) : null}
        {active && centerMode === "edit" ? (
          <label className="editor-field">
            <span className="sr-only">{t("editor.contentLabel")}</span>
            <textarea
              ref={editorTextareaRef}
              name="markdown-content"
              value={active.draft}
              onChange={(event) => setActiveDraft(event.target.value)}
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
        <button
          type="button"
          className="editor-fab"
          onClick={save}
          disabled={!dirty || saving}
          aria-busy={saving}
          aria-label={dirty ? t("editor.fab.ariaSave") : t("editor.fab.ariaSaved")}
        >
          {saving ? <SpinnerIcon /> : <SaveIcon />}
          <span className="editor-fab-label">{saving ? t("editor.fab.saving") : dirty ? t("editor.fab.save") : t("editor.fab.saved")}</span>
        </button>
      ) : null}
      {pendingUndo ? (
        <div className="undo-toast" role="status" aria-live="polite">
          <span className="undo-toast-label">{pendingUndo.label}</span>
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
          initialValue="Untitled.md"
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
                  <strong>{result.name}</strong>
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
      className={`editor-tab-shell ${active ? "active" : ""} ${closing ? "closing" : ""}`}
      style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dx === 0 || closing ? "transform 160ms ease" : "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => reset()}
    >
      <button role="tab" aria-selected={active} className="editor-tab" onClick={onActivate}>
        <span>{tab.name}</span>
        <span className="tab-path">{tab.path}</span>
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
  expandedFolders: Record<string, boolean>;
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
  expandedFolders: Record<string, boolean>;
  onToggleFolder: (folderPath: string) => void;
  onSelect: (path: string) => void;
}) {
  const isExpanded = props.expandedFolders[props.node.id] ?? false;

  if (props.node.type === "folder") {
    return (
      <div className="tree-group">
        <button className="tree-row folder-row" aria-expanded={isExpanded} style={{ paddingLeft: `${0.65 + props.depth * 0.85}rem` }} onClick={() => props.onToggleFolder(props.node.id)}>
          <span className="tree-caret" aria-hidden="true">
            {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </span>
          <span className="tree-label">{props.node.name}</span>
          <span className="tree-count">{props.node.children.length}</span>
        </button>
        {isExpanded
          ? props.node.children.map((child) => <TreeNodeRow key={child.id} {...props} node={child} depth={props.depth + 1} />)
          : null}
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
      <span className="tree-file-text">
        <span className="tree-file-name">{props.node.name}</span>
        <small>{props.node.document?.path}</small>
      </span>
    </button>
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
          <button type="button" onClick={props.onCancel} disabled={submitting} aria-label={props.cancelLabel}>
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
