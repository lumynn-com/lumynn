import { useEffect, useMemo, useState } from "react";
import type { DocumentContent, DocumentSummary, SortField, SortOrder } from "../shared/types";
import { api } from "./api";

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
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [activePath, setActivePath] = useState("");
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [preview, setPreview] = useState("");
  const [sort, setSort] = useState<SortField>("name");
  const [order, setOrder] = useState<SortOrder>("asc");
  const [status, setStatus] = useState("Ready");
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const documentTree = useMemo(() => buildDocumentTree(documents), [documents]);
  const active = tabs.find((tab) => tab.path === activePath) ?? null;

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
        body: JSON.stringify({ content: active.draft })
      })
        .then((result) => setPreview(result.html))
        .catch(() => setPreview(""));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [active]);

  function setActiveDraft(nextDraft: string) {
    setTabs((current) => current.map((tab) => (tab.path === activePath ? { ...tab, draft: nextDraft } : tab)));
  }

  function closeTab(path: string) {
    setTabs((current) => current.filter((tab) => tab.path !== path));
    if (activePath === path) {
      const remaining = tabs.filter((tab) => tab.path !== path);
      setActivePath(remaining[remaining.length - 1]?.path ?? "");
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
      setActivePath(created.path);
      setStatus("Created");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Create failed");
    }
  }

  async function deleteActive() {
    if (!active || !window.confirm(`Delete ${active.path}?`)) {
      return;
    }
    await api("/api/documents/content", {
      method: "DELETE",
      body: JSON.stringify({ path: active.path })
    });
    closeTab(active.path);
    await refreshDocuments();
  }

  async function onSort(nextSort: SortField, nextOrder: SortOrder) {
    setSort(nextSort);
    setOrder(nextOrder);
    await refreshDocuments(nextSort, nextOrder);
  }

  return (
    <main className="workspace-grid">
      <section className="document-list panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Vault</p>
            <h2>Documents</h2>
            <p className="muted">{documents.length} Markdown file{documents.length === 1 ? "" : "s"}</p>
          </div>
          <button className="primary" onClick={createDocument}>New Note</button>
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
        <DocumentTree
          nodes={documentTree}
          selectedPath={activePath}
          expandedFolders={expandedFolders}
          onToggleFolder={(folderPath) => setExpandedFolders((current) => ({ ...current, [folderPath]: !(current[folderPath] ?? false) }))}
          onSelect={setActivePath}
        />
      </section>
      <section className="editor panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">{active?.path ?? "No document selected"}</p>
            <h2>{active?.title ?? "Editor"}</h2>
          </div>
          <div className="actions">
            <span className="status status-pill" aria-live="polite">{status}</span>
            <button onClick={deleteActive} disabled={!active}>
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
              <div key={tab.path} className={`editor-tab-shell ${activePath === tab.path ? "active" : ""}`}>
                <button role="tab" aria-selected={activePath === tab.path} className="editor-tab" onClick={() => setActivePath(tab.path)}>
                  <span>{tab.title}</span>
                  <span className="tab-path">{tab.path}</span>
                </button>
                <button
                  className="tab-close"
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.path);
                  }}
                >
                  x
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {active ? (
          <label className="editor-field">
            <span className="sr-only">Markdown Content</span>
            <textarea name="markdown-content" value={active.draft} onChange={(event) => setActiveDraft(event.target.value)} spellCheck={false} />
          </label>
        ) : (
          <div className="blank-editor">
            <p className="eyebrow">No file open</p>
            <h2>Select a document from the tree</h2>
            <p className="muted">The editor starts blank by default. Open one or more files to work with tabs.</p>
          </div>
        )}
      </section>
      <section className="preview panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Live</p>
            <h2>Preview</h2>
            <p className="muted">{active ? "Rendered Markdown updates as you type." : "Open a note to preview it."}</p>
          </div>
        </div>
        {preview ? <article dangerouslySetInnerHTML={{ __html: preview }} /> : <div className="empty-state">No preview yet.</div>}
      </section>
    </main>
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
        <strong>{props.node.document?.title ?? props.node.name}</strong>
        <small>{props.node.name}</small>
      </span>
    </button>
  );
}
