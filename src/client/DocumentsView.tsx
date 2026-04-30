import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { DocumentContent, DocumentSearchResult, DocumentSummary, SortField, SortOrder } from "../shared/types";
import { api } from "./api";
import { QaView } from "./QaView";

type MobileSection = "vault" | "editor" | "ask";

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

export function DocumentsView() {
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
  const [status, setStatus] = useState("Ready");
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DocumentSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchHasRun, setSearchHasRun] = useState(false);
  const documentTree = useMemo(() => buildDocumentTree(documents), [documents]);
  const active = tabs.find((tab) => tab.path === activePath) ?? null;

  const openDocument = useCallback(
    (path: string) => {
      setActivePath(path);
      if (isMobile) {
        setMobileSection("editor");
      }
    },
    [isMobile]
  );

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
      setMobileSection(sections[idx - 1]);
    } else if (start.fromEdge === "right" && dx <= -60 && idx < sections.length - 1) {
      setMobileSection(sections[idx + 1]);
    }
  }

  // Pull-to-search on the vault pane: when the document tree is already
  // scrolled to the top and the user pulls down, we open the search modal.
  const pullStartY = useRef<number | null>(null);
  const pullStartScrollTop = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  const pullThreshold = 72;

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
    setPullDistance(Math.min(dy, pullThreshold * 1.6));
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
      setSearchOpen(true);
    }
  }

  async function refreshDocuments(nextSort = sort, nextOrder = order) {
    const docs = await api<DocumentSummary[]>(`/api/documents?sort=${nextSort}&order=${nextOrder}`);
    setDocuments(docs);
  }

  useEffect(() => {
    refreshDocuments().catch((error) => setStatus(error.message));
  }, []);

  useEffect(() => {
    if (!activePath || tabs.some((tab) => tab.path === activePath)) {
      return;
    }
    api<DocumentContent>(`/api/documents/content?path=${encodeURIComponent(activePath)}`)
      .then((doc) => {
        setTabs((current) => [...current, { ...doc, draft: doc.content }]);
      })
      .catch((error) => setStatus(error.message));
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
      offerUndo({ kind: "close-tab", tab: closed, wasActive, label: `Closed ${closed.name}` });
    }
  }

  async function save() {
    if (!active) {
      return;
    }
    setStatus("Saving...");
    try {
      const saved = await api<DocumentContent>("/api/documents/content", {
        method: "PUT",
        body: JSON.stringify({ path: active.path, content: active.draft, expectedHash: active.hash })
      });
      setTabs((current) => current.map((tab) => (tab.path === saved.path ? { ...saved, draft: saved.content } : tab)));
      await refreshDocuments();
      setStatus("Saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Save failed");
    }
  }

  async function createDocument() {
    const name = window.prompt("New Markdown file path", "Untitled.md");
    if (!name) {
      return;
    }
    try {
      const created = await api<DocumentContent>("/api/documents", {
        method: "POST",
        body: JSON.stringify({ path: name })
      });
      await refreshDocuments();
      setTabs((current) => [...current.filter((tab) => tab.path !== created.path), { ...created, draft: created.content }]);
      openDocument(created.path);
      setStatus("Created");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Create failed");
    }
  }

  async function renameActive() {
    if (!active) {
      return;
    }
    const nextPath = window.prompt("Rename Markdown file", active.path);
    if (!nextPath || nextPath === active.path) {
      return;
    }
    setStatus("Renaming...");
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
      setStatus("Renamed");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Rename failed");
    }
  }

  async function deleteActive() {
    if (!active || !window.confirm(`Delete ${active.path}?`)) {
      return;
    }
    const snapshotPath = active.path;
    const snapshotContent = active.draft;
    const snapshotName = active.name;
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
    offerUndo({
      kind: "delete-document",
      path: snapshotPath,
      content: snapshotContent,
      label: `Deleted ${snapshotName}`
    });
  }

  async function performUndo() {
    if (!pendingUndo) {
      return;
    }
    const action = pendingUndo;
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
      setStatus(`Reopened ${action.tab.name}`);
      return;
    }
    setStatus("Restoring...");
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
      setStatus(`Restored ${restored.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? `Restore failed: ${error.message}` : "Restore failed");
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
      <section className="document-list panel vault-pane" data-section="vault">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Vault</p>
            <h2>Documents</h2>
            <p className="muted">{documents.length} Markdown file{documents.length === 1 ? "" : "s"}</p>
          </div>
        </div>
        <div className="vault-toolbar">
          <button className="primary" onClick={() => setSearchOpen(true)}>Search Vault</button>
          <button onClick={createDocument}>New Note</button>
        </div>
        <div className="sort-row">
          <label>
            Sort By
            <select name="document-sort" value={sort} onChange={(event) => onSort(event.target.value as SortField, order)}>
              <option value="name">Name</option>
              <option value="createdAt">Created</option>
              <option value="updatedAt">Updated</option>
              <option value="path">Path</option>
              <option value="title">Title</option>
            </select>
          </label>
          <label>
            Order
            <select name="document-order" value={order} onChange={(event) => onSort(sort, event.target.value as SortOrder)}>
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </label>
        </div>
        <div
          className="vault-scroll"
          onTouchStart={onVaultTouchStart}
          onTouchMove={onVaultTouchMove}
          onTouchEnd={onVaultTouchEnd}
          onTouchCancel={onVaultTouchEnd}
        >
          {isMobile && pullDistance > 0 ? (
            <div
              className={`pull-indicator ${pullDistance >= pullThreshold ? "ready" : ""}`}
              style={{ height: `${pullDistance}px` }}
              aria-hidden="true"
            >
              <span>{pullDistance >= pullThreshold ? "Release to search" : "Pull to search"}</span>
            </div>
          ) : null}
          <DocumentTree
            nodes={documentTree}
            selectedPath={activePath}
            expandedFolders={expandedFolders}
            onToggleFolder={(folderPath) => setExpandedFolders((current) => ({ ...current, [folderPath]: !(current[folderPath] ?? false) }))}
            onSelect={openDocument}
          />
        </div>
      </section>
      <section className="editor panel editor-pane" data-section="editor">
        <div className="panel-header">
          <div>
            <p className="eyebrow">{active?.path ?? "No document selected"}</p>
            <h2>{active?.name ?? "Editor"}</h2>
          </div>
          <span className="status status-pill" aria-live="polite">{status}</span>
        </div>
        <div className="editor-toolbar" aria-label="Editor actions">
          <div className="mode-switch" role="group" aria-label="Editor display mode">
            <button className={centerMode === "edit" ? "active" : ""} aria-pressed={centerMode === "edit"} onClick={() => setGlobalCenterMode("edit")}>
              Edit
            </button>
            <button className={centerMode === "preview" ? "active" : ""} aria-pressed={centerMode === "preview"} onClick={() => setGlobalCenterMode("preview")}>
              Preview
            </button>
          </div>
          <div className="file-actions">
            <button onClick={renameActive} disabled={!active}>
              Rename
            </button>
            <button className="danger" onClick={deleteActive} disabled={!active}>
              Delete
            </button>
            <button className="primary" onClick={save} disabled={!active}>
              Save Note
            </button>
          </div>
        </div>
        {tabs.length > 0 ? (
          <div className="tab-strip" role="tablist" aria-label="Open documents">
            {tabs.map((tab) => (
              <SwipeableTab
                key={tab.path}
                tab={tab}
                active={activePath === tab.path}
                isMobile={isMobile}
                onActivate={() => setActivePath(tab.path)}
                onClose={() => closeTab(tab.path)}
              />
            ))}
          </div>
        ) : null}
        {active && centerMode === "edit" ? (
          <label className="editor-field">
            <span className="sr-only">Markdown Content</span>
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
            {preview ? <article dangerouslySetInnerHTML={{ __html: preview }} /> : <div className="empty-state">No preview yet.</div>}
          </div>
        ) : null}
        {!active ? (
          <div className="blank-editor">
            <p className="eyebrow">No file open</p>
            <h2>Select a document from the tree</h2>
            <p className="muted">The editor starts blank by default. Open one or more files to work with tabs.</p>
          </div>
        ) : null}
      </section>
      <div className="qa-section-wrapper" data-section="ask">
        <QaView compact onOpenSource={openDocument} />
      </div>
      {isMobile ? (
        <nav className="mobile-tabbar" aria-label="Workspace sections">
          <button
            type="button"
            className={mobileSection === "vault" ? "active" : ""}
            aria-current={mobileSection === "vault" ? "page" : undefined}
            onClick={() => setMobileSection("vault")}
          >
            <span className="mobile-tabbar-icon" aria-hidden="true">V</span>
            <span className="mobile-tabbar-label">Vault</span>
          </button>
          <button
            type="button"
            className={mobileSection === "editor" ? "active" : ""}
            aria-current={mobileSection === "editor" ? "page" : undefined}
            onClick={() => setMobileSection("editor")}
          >
            <span className="mobile-tabbar-icon" aria-hidden="true">E</span>
            <span className="mobile-tabbar-label">Editor</span>
          </button>
          <button
            type="button"
            className={mobileSection === "ask" ? "active" : ""}
            aria-current={mobileSection === "ask" ? "page" : undefined}
            onClick={() => setMobileSection("ask")}
          >
            <span className="mobile-tabbar-icon" aria-hidden="true">A</span>
            <span className="mobile-tabbar-label">Ask</span>
          </button>
        </nav>
      ) : null}
      {pendingUndo ? (
        <div className="undo-toast" role="status" aria-live="polite">
          <span className="undo-toast-label">{pendingUndo.label}</span>
          <button type="button" className="undo-toast-action" onClick={performUndo}>
            Undo
          </button>
          <button type="button" className="undo-toast-dismiss" aria-label="Dismiss" onClick={dismissUndo}>
            x
          </button>
        </div>
      ) : null}
      {searchOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSearchOpen(false)}>
          <section className="search-modal panel" role="dialog" aria-modal="true" aria-labelledby="vault-search-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-header">
              <div>
                <p className="eyebrow">Vault Search</p>
                <h2 id="vault-search-title">Search Documents</h2>
                <p className="muted">Uses obsidian-cli first, with filesystem search as fallback.</p>
              </div>
              <button type="button" onClick={() => setSearchOpen(false)}>Close</button>
            </div>
            <form
              className="search-form"
              onSubmit={(event) => {
                event.preventDefault();
                searchVault();
              }}
            >
              <label>
                Search query
                <input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search file names, tags, headings, or content" />
              </label>
              <button className="primary" type="submit" disabled={!searchQuery.trim() || searchLoading}>
                {searchLoading ? "Searching..." : "Search"}
              </button>
            </form>
            {searchError ? <div className="error" aria-live="polite">{searchError}</div> : null}
            <div className="search-results" aria-live="polite">
              {!searchHasRun ? <div className="empty-state">Enter a query to search the vault.</div> : null}
              {searchHasRun && !searchLoading && searchResults.length === 0 ? <div className="empty-state">No matching files found.</div> : null}
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
  onActivate: () => void;
  onClose: () => void;
}) {
  const { tab, active, isMobile, onActivate, onClose } = props;
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
      setDx(Math.max(deltaX, -160));
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
        aria-label={`Close ${tab.name}`}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      >
        x
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
}) {
  if (props.nodes.length === 0) {
    return <div className="empty-state">No Markdown documents yet. Create your first note.</div>;
  }

  return (
    <div className="doc-tree">
      {props.nodes.map((node) => (
        <TreeNodeRow key={node.id} node={node} depth={0} {...props} />
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
          <span className="tree-caret">{isExpanded ? "-" : "+"}</span>
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
      aria-current={props.selectedPath === props.node.document?.path ? "page" : undefined}
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
