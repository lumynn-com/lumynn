import { useEffect, useMemo, useState } from "react";
import type { DocumentTreeEntry } from "../shared/types";
import { ChevronDownIcon, ChevronRightIcon, SpinnerIcon } from "./icons";
import { useT } from "./i18n";

// Reusable folder-only tree picker. Used by every dialog that asks
// the user to pick a destination folder (New Note, New Folder,
// Rename/Move). Reuses the parent's lazy-loaded folderChildren
// map so it doesn't trigger duplicate /api/documents/tree calls
// — when the user expands a node here it warms the same cache the
// main tree uses, and vice-versa.
export interface FolderPickerProps {
  // The currently lazy-loaded folder map keyed by vault-relative
  // folder path ("" for root). Same shape as the tree's own
  // folderChildren state.
  folderChildren: Map<string, DocumentTreeEntry[]>;
  // Folders that are currently loading (spinner support).
  loadingFolders: ReadonlySet<string>;
  // Async loader the parent already has; we reuse it so the
  // picker and the main tree share one cache.
  loadFolder: (path: string) => Promise<DocumentTreeEntry[] | null>;
  // Currently picked folder path ("" for vault root).
  value: string;
  onChange: (path: string) => void;
  // Disable selecting these folders + everything under them. Used
  // by the move dialog to prevent moving a folder into itself.
  disabledPrefixes?: string[];
  // Cap height so the picker fits inside small mobile dialogs.
  maxHeight?: string;
}

export function FolderPicker(props: FolderPickerProps) {
  const t = useT();
  // Track which nodes are user-expanded. Root starts expanded so
  // the user always sees the top level.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));

  // On mount, kick off the root load if it isn't cached.
  useEffect(() => {
    if (!props.folderChildren.has("")) {
      void props.loadFolder("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the value's ancestors expanded so the picked folder is
  // always visible when the dialog opens with a pre-selected
  // value.
  useEffect(() => {
    if (!props.value) return;
    const segments = props.value.split("/");
    setExpanded((current) => {
      const next = new Set(current);
      next.add("");
      let acc = "";
      for (const part of segments) {
        acc = acc ? `${acc}/${part}` : part;
        next.add(acc);
      }
      return next;
    });
    // Pre-warm the cache for each ancestor on the path so the
    // picker doesn't have to fetch them as the user expands.
    let acc = "";
    for (const part of segments) {
      const prefix = acc ? `${acc}/${part}` : part;
      acc = prefix;
      if (!props.folderChildren.has(prefix)) {
        void props.loadFolder(prefix);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);

  function toggle(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!props.folderChildren.has(path)) {
          void props.loadFolder(path);
        }
      }
      return next;
    });
  }

  const isDisabled = useMemo(() => {
    const prefixes = props.disabledPrefixes ?? [];
    return (path: string) => prefixes.some((p) => p === path || (p && path.startsWith(`${p}/`)));
  }, [props.disabledPrefixes]);

  return (
    <div className="folder-picker" style={{ maxHeight: props.maxHeight ?? "min(45dvh, 320px)" }}>
      <FolderRow
        path=""
        name={t("folderPicker.vaultRoot")}
        depth={0}
        expanded={expanded.has("")}
        loading={props.loadingFolders.has("")}
        selected={props.value === ""}
        disabled={isDisabled("")}
        onToggle={toggle}
        onSelect={props.onChange}
        hasChildren
      />
      {expanded.has("") && (
        <ChildrenList
          parentPath=""
          depth={1}
          {...props}
          expanded={expanded}
          isDisabled={isDisabled}
          onToggle={toggle}
        />
      )}
    </div>
  );
}

interface ChildrenListProps {
  parentPath: string;
  depth: number;
  folderChildren: Map<string, DocumentTreeEntry[]>;
  loadingFolders: ReadonlySet<string>;
  loadFolder: (path: string) => Promise<DocumentTreeEntry[] | null>;
  value: string;
  onChange: (path: string) => void;
  expanded: Set<string>;
  isDisabled: (path: string) => boolean;
  onToggle: (path: string) => void;
}

function ChildrenList(props: ChildrenListProps) {
  const t = useT();
  const children = props.folderChildren.get(props.parentPath);
  const loading = props.loadingFolders.has(props.parentPath);

  if (!children) {
    return loading ? (
      <div className="folder-picker-loading" style={{ paddingLeft: indent(props.depth) }}>
        <SpinnerIcon /> {t("folderPicker.loading")}
      </div>
    ) : null;
  }

  const folderEntries = children.filter((entry) => entry.type === "folder");
  if (folderEntries.length === 0) {
    return null;
  }

  return (
    <>
      {folderEntries.map((entry) => {
        const isExpanded = props.expanded.has(entry.path);
        const isLoading = props.loadingFolders.has(entry.path);
        const disabled = props.isDisabled(entry.path);
        return (
          <div key={entry.path}>
            <FolderRow
              path={entry.path}
              name={entry.name}
              depth={props.depth}
              expanded={isExpanded}
              loading={isLoading}
              selected={props.value === entry.path}
              disabled={disabled}
              onToggle={props.onToggle}
              onSelect={props.onChange}
              hasChildren={Boolean(entry.hasChildren)}
            />
            {isExpanded && (
              <ChildrenList
                {...props}
                parentPath={entry.path}
                depth={props.depth + 1}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

interface FolderRowProps {
  path: string;
  name: string;
  depth: number;
  expanded: boolean;
  loading: boolean;
  selected: boolean;
  disabled: boolean;
  hasChildren: boolean;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}

function FolderRow(props: FolderRowProps) {
  return (
    <div
      className={`folder-picker-row ${props.selected ? "selected" : ""} ${props.disabled ? "disabled" : ""}`}
      style={{ paddingLeft: indent(props.depth) }}
    >
      <button
        type="button"
        className="folder-picker-caret"
        onClick={() => props.onToggle(props.path)}
        aria-expanded={props.expanded}
        aria-label={props.expanded ? "Collapse" : "Expand"}
        // Always render a caret so click targets line up vertically;
        // hide arrow visually on leaves.
        tabIndex={props.hasChildren ? 0 : -1}
      >
        {props.loading ? (
          <SpinnerIcon />
        ) : props.hasChildren ? (
          props.expanded ? <ChevronDownIcon /> : <ChevronRightIcon />
        ) : (
          <span aria-hidden="true" style={{ display: "inline-block", width: 14 }} />
        )}
      </button>
      <button
        type="button"
        className="folder-picker-label"
        onClick={() => !props.disabled && props.onSelect(props.path)}
        disabled={props.disabled}
        title={props.path || "/"}
      >
        <FolderGlyph />
        <span className="folder-picker-name" translate="no">{props.name}</span>
      </button>
    </div>
  );
}

function indent(depth: number): string {
  return `${depth * 0.9}rem`;
}

// Tiny inline folder icon so the picker doesn't depend on a new
// SVG import.
function FolderGlyph() {
  return (
    <svg
      className="folder-picker-glyph"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}
