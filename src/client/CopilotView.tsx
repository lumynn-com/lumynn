import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import fuzzysort from "fuzzysort";
import type { DocumentContent, DocumentSummary, DocumentTreeEntry } from "../shared/types";
import { api } from "./api";
import { AskIcon, CloseIcon, CopyIcon, EyeIcon, HistoryIcon, PanelToggleIcon, PlusIcon, SaveIcon, SendIcon, StopIcon, TrashIcon } from "./icons";
import { useT } from "./i18n";
import { parseSseChunk } from "./copilot/sse";
import { FolderPicker } from "./FolderPicker";

type ChatRole = "user" | "assistant";

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  citations?: Citation[];
}

interface Citation {
  path: string;
  title: string;
  snippet: string;
  score?: number;
  source?: string;
}

interface NoteContext {
  path: string;
  title: string;
  content?: string;
  hash?: string;
  isCurrent?: boolean;
  isDraft?: boolean;
  dirty?: boolean;
}

interface FileEditProposal {
  id: string;
  kind: "writeFile" | "editFile";
  path: string;
  title: string;
  originalContent: string;
  proposedContent: string;
  expectedHash: string | null;
  diff: string;
  createdAt: string;
  status: "pending" | "applied" | "rejected" | "conflict";
  message?: string;
}

interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  path?: string;
}

interface CopilotProviderStatus {
  ok: boolean;
  toolsAvailable: boolean;
  reason?: string;
}

interface ToolActivity {
  id: string;
  name: string;
  status: "running" | "done";
  args?: unknown;
  result?: unknown;
}

interface NotePickerState {
  open: boolean;
  query: string;
  cursor: number;
  start: number | null;
  category: "notes" | "folders" | null;
}

interface NotePickerPosition {
  left: number;
  bottom: number;
  width: number;
  maxHeight: number;
}

interface AnswerSaveState {
  content: string;
  folder: string;
  name: string;
  busy: boolean;
  error: string;
}

type NotePickerOption =
  | {
      kind: "back";
      key: string;
      title: string;
      subtitle: string;
      badge: string;
    }
  | {
      kind: "active";
      key: string;
      title: string;
      subtitle: string;
      badge: string;
    }
  | {
      kind: "category";
      key: string;
      title: string;
      subtitle: string;
      badge: string;
      category: "notes" | "folders";
    }
  | {
      kind: "note";
      key: string;
      title: string;
      subtitle: string;
      badge: string;
      note: NoteContext;
    }
  | {
      kind: "folder";
      key: string;
      title: string;
      subtitle: string;
      badge: string;
      path: string;
    };

interface SavedCopilotState {
  conversationId: string;
  conversationPath: string;
  title: string;
  messages: ChatMessage[];
  citations: Citation[];
  proposals: FileEditProposal[];
}

interface CopilotState extends SavedCopilotState {
  input: string;
  loading: boolean;
  error: string;
  status: string;
  activities: ToolActivity[];
}

const COPILOT_STATE_KEY_PREFIX = "owd_copilot_state:";
const MAX_REQUEST_NOTE_CONTENT_CHARS = 500_000;
const MAX_VISIBLE_CITATIONS = 5;
const MAX_MENTION_RESULTS = 30;
const NOTE_PICKER_ID = "copilot-note-picker-listbox";

function stateKey(username: string): string {
  return `${COPILOT_STATE_KEY_PREFIX}${username}`;
}

const emptySavedState: SavedCopilotState = {
  conversationId: "",
  conversationPath: "",
  title: "",
  messages: [],
  citations: [],
  proposals: []
};

const emptyState: CopilotState = {
  ...emptySavedState,
  input: "",
  loading: false,
  error: "",
  status: "",
  activities: []
};

function randomId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function readSavedState(username: string): SavedCopilotState {
  try {
    return { ...emptySavedState, ...JSON.parse(localStorage.getItem(stateKey(username)) ?? "{}") };
  } catch {
    return emptySavedState;
  }
}

function savedSlice(state: CopilotState): SavedCopilotState {
  return {
    conversationId: state.conversationId,
    conversationPath: state.conversationPath,
    title: state.title,
    messages: state.messages,
    citations: state.citations,
    proposals: state.proposals
  };
}

function writeSavedState(username: string, state: CopilotState): void {
  try {
    localStorage.setItem(stateKey(username), JSON.stringify(savedSlice(state)));
  } catch {
    // Ignore storage failures; chat still works for the active mount.
  }
}

function conversationAutoSaveKey(messages: ChatMessage[]): string {
  return messages.map((message) => `${message.id}\u0000${message.role}\u0000${message.createdAt}\u0000${message.content}`).join("\u0001");
}

function formatHistoryTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function mergeCitation(citations: Citation[], next: Citation): Citation[] {
  const merged = new Map<string, Citation>();
  for (const citation of [...citations, next]) {
    const existing = merged.get(citation.path);
    if (!existing || citationRank(citation) > citationRank(existing)) {
      merged.set(citation.path, citation);
    }
  }
  return sortCitations(Array.from(merged.values())).slice(0, 12);
}

function mergeProposal(proposals: FileEditProposal[], next: FileEditProposal): FileEditProposal[] {
  const existing = proposals.findIndex((proposal) => proposal.id === next.id);
  if (existing === -1) return [...proposals, next];
  return proposals.map((proposal, index) => (index === existing ? next : proposal));
}

function noteTitle(note: Pick<NoteContext, "path" | "title">): string {
  return note.title || note.path.split("/").pop()?.replace(/\.md$/i, "") || note.path;
}

function noteMentionLabel(note: Pick<NoteContext, "path" | "title">): string {
  return noteTitle(note).trim() || note.path;
}

function noteMentionText(note: Pick<NoteContext, "path" | "title">): string {
  return `@${noteMentionLabel(note)}`;
}

function inputIncludesNoteMention(input: string, note: Pick<NoteContext, "path" | "title">): boolean {
  return input.includes(noteMentionText(note)) || input.includes(`@${note.path}`);
}

function noteFromDocument(doc: DocumentSummary): NoteContext {
  return {
    path: doc.path,
    title: doc.title || doc.name || doc.path,
    hash: doc.hash
  };
}

function noteForRequest(note: NoteContext): NoteContext {
  return {
    ...note,
    content: note.content !== undefined ? note.content.slice(0, MAX_REQUEST_NOTE_CONTENT_CHARS) : undefined
  };
}

function citationRank(citation: Citation): number {
  const score = typeof citation.score === "number" && Number.isFinite(citation.score) ? citation.score : 0;
  const sourceBonus = citation.source === "localSearch" || citation.source === "timeRange" ? 4 : citation.source === "readNote" ? 2 : 0;
  return score + sourceBonus;
}

function sortCitations(citations: Citation[]): Citation[] {
  return [...citations].sort((a, b) => citationRank(b) - citationRank(a) || a.path.localeCompare(b.path));
}

function notePickerOptionId(index: number): string {
  return `${NOTE_PICKER_ID}-option-${index}`;
}

function mentionAtCursor(value: string, cursor: number): { query: string; start: number } | null {
  const beforeCursor = value.slice(0, cursor);
  const start = beforeCursor.lastIndexOf("@");
  if (start === -1) return null;
  const query = beforeCursor.slice(start + 1);
  return /\s/.test(query) ? null : { query, start };
}

function folderName(folderPath: string): string {
  return folderPath.split("/").filter(Boolean).pop() || "/";
}

function parentFolderOfPath(documentPath: string): string {
  const index = documentPath.lastIndexOf("/");
  return index === -1 ? "" : documentPath.slice(0, index);
}

function sanitizeFileNameSegment(input: string): string {
  return input
    .replace(/[\\/:*?"<>|#\[\]\n\r\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function formatAnswerTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function defaultAnswerFileName(content: string): string {
  const heading = content.match(/^#{1,6}\s+(.+)$/m)?.[1];
  const firstLine = heading || content.split(/\r?\n/).find((line) => line.trim()) || "";
  const base = sanitizeFileNameSegment(firstLine.replace(/[*_`[\]()]/g, " ")) || `Copilot answer ${formatAnswerTimestamp()}`;
  return `${base}.md`;
}

function normalizeAnswerFileName(input: string): string {
  const cleaned = sanitizeFileNameSegment(input.replace(/\.md$/i, ""));
  return cleaned ? `${cleaned}.md` : "";
}

function answerPath(folder: string, fileName: string): string {
  return folder ? `${folder.replace(/\/+$/, "")}/${fileName}` : fileName;
}

function folderPathsFromDocuments(documents: DocumentSummary[]): string[] {
  const folders = new Set<string>();
  for (const doc of documents) {
    const segments = doc.path.split("/").slice(0, -1);
    for (let index = 0; index < segments.length; index += 1) {
      folders.add(segments.slice(0, index + 1).join("/"));
    }
  }
  return Array.from(folders).sort((a, b) => a.localeCompare(b));
}

function friendlyToolStatus(name: string, phase: "running" | "done", result?: unknown): string {
  if (phase === "running") {
    if (name === "localSearch") return "Searching vault...";
    if (name === "readNote") return "Reading note...";
    if (name === "getFileTree") return "Checking file tree...";
    if (name === "writeFile" || name === "editFile") return "Preparing edit proposal...";
    if (name === "getCurrentTime" || name === "getTimeRangeMs") return "Resolving time...";
    return "Using a tool...";
  }

  const resultRecord = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (name === "localSearch" && typeof resultRecord.resultCount === "number") {
    return `Found ${resultRecord.resultCount} source${resultRecord.resultCount === 1 ? "" : "s"}.`;
  }
  if (name === "readNote" && typeof resultRecord.notePath === "string") {
    return `Read ${resultRecord.notePath}.`;
  }
  if (name === "writeFile" || name === "editFile") {
    return "Edit proposal ready.";
  }
  return "Continuing with tool results...";
}

export const CopilotView = memo(function CopilotView(props: {
  compact?: boolean;
  username?: string;
  onOpenSource?: (path: string) => void;
  onVaultFilesChanged?: (paths: string[]) => void | Promise<void>;
  onDismiss?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  activeNote?: NoteContext | null;
}) {
  const t = useT();
  const username = props.username || "__anonymous__";
  const [state, setState] = useState<CopilotState>(() => ({ ...emptyState, ...readSavedState(username) }));
  const [providerStatus, setProviderStatus] = useState<CopilotProviderStatus | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [saving, setSaving] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [documentOptions, setDocumentOptions] = useState<DocumentSummary[]>([]);
  const [documentOptionsLoading, setDocumentOptionsLoading] = useState(false);
  const [documentOptionsError, setDocumentOptionsError] = useState("");
  const [includeCurrentNote, setIncludeCurrentNote] = useState(true);
  const [attachedNotes, setAttachedNotes] = useState<NoteContext[]>([]);
  const [notePicker, setNotePicker] = useState<NotePickerState>({ open: false, query: "", cursor: 0, start: null, category: null });
  const [notePickerActiveIndex, setNotePickerActiveIndex] = useState(0);
  const [notePickerPosition, setNotePickerPosition] = useState<NotePickerPosition | null>(null);
  const [renderedMessages, setRenderedMessages] = useState<Record<string, string>>({});
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [deletingConversationId, setDeletingConversationId] = useState("");
  const [answerSave, setAnswerSave] = useState<AnswerSaveState | null>(null);
  const [folderChildren, setFolderChildren] = useState<Map<string, DocumentTreeEntry[]>>(() => new Map());
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(() => new Set());
  const abortRef = useRef<AbortController | null>(null);
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const notePickerRef = useRef<HTMLDivElement | null>(null);
  const historyMenuRef = useRef<HTMLDivElement | null>(null);
  const previewCacheRef = useRef(new Map<string, { content: string; html: string }>());
  const folderRequestsRef = useRef(new Map<string, Promise<DocumentTreeEntry[] | null>>());
  const deletedConversationIdsRef = useRef(new Set<string>());
  const deletedConversationPathsRef = useRef(new Set<string>());
  const lastAutoSaveKeyRef = useRef("");
  const autoSaveTimerRef = useRef<number | null>(null);

  function notifyVaultFilesChanged(paths: string[]) {
    const changedPaths = paths.filter(Boolean);
    if (changedPaths.length === 0) return;
    void Promise.resolve(props.onVaultFilesChanged?.(changedPaths)).catch(() => undefined);
  }

  useEffect(() => {
    setState({ ...emptyState, ...readSavedState(username) });
    setRenderedMessages({});
    setFolderChildren(new Map());
    setLoadingFolders(new Set());
    folderRequestsRef.current.clear();
  }, [username]);

  useEffect(() => {
    writeSavedState(username, state);
  }, [state, username]);

  useEffect(() => {
    api<CopilotProviderStatus>("/api/copilot/status")
      .then(setProviderStatus)
      .catch((error) => setProviderStatus({ ok: false, toolsAvailable: false, reason: error instanceof Error ? error.message : "Provider unavailable" }));
    refreshConversations();
    refreshDocumentOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  useEffect(() => {
    if (state.loading || state.messages.length === 0) return;
    const signature = conversationAutoSaveKey(state.messages);
    if (!signature || signature === lastAutoSaveKeyRef.current) return;
    if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      void persistConversation({ signature });
    }, 800);
    return () => {
      if (autoSaveTimerRef.current) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [state.loading, state.messages]);

  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const node = chatLogRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [state.messages, state.activities, state.proposals, state.loading]);

  useEffect(() => {
    if (!notePicker.open || documentOptions.length > 0 || documentOptionsLoading || documentOptionsError) return;
    void refreshDocumentOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notePicker.open, documentOptions.length, documentOptionsLoading, documentOptionsError]);

  useEffect(() => {
    if (!notePicker.open) {
      setNotePickerPosition(null);
      return;
    }

    const update = () => updateNotePickerPosition();
    update();
    const frame = window.requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    document.addEventListener("scroll", update, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [notePicker.open, documentOptions.length, notePicker.query, state.input]);

  useEffect(() => {
    if (!notePicker.open) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (inputRef.current?.contains(target) || notePickerRef.current?.contains(target)) return;
      setNotePicker({ open: false, query: "", cursor: 0, start: null, category: null });
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [notePicker.open]);

  useEffect(() => {
    if (!historyMenuOpen) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (historyMenuRef.current?.contains(target)) return;
      setHistoryMenuOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setHistoryMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [historyMenuOpen]);

  useEffect(() => {
    const assistantMessages = state.messages.filter((message) => message.role === "assistant" && message.content.trim());
    if (assistantMessages.length === 0) {
      setRenderedMessages({});
      return;
    }

    const timeout = window.setTimeout(() => {
      void Promise.all(
        assistantMessages.map(async (message) => {
          const cached = previewCacheRef.current.get(message.id);
          if (cached?.content === message.content) return null;
          const result = await api<{ html: string }>("/api/documents/preview", {
            method: "POST",
            body: JSON.stringify({ content: message.content, path: "copilot/assistant.md" })
          }).catch(() => null);
          if (!result) return null;
          previewCacheRef.current.set(message.id, { content: message.content, html: result.html });
          return [message.id, result.html] as const;
        })
      ).then((entries) => {
        const rendered = entries.filter((entry): entry is readonly [string, string] => Boolean(entry));
        if (rendered.length === 0) return;
        setRenderedMessages((current) => ({
          ...current,
          ...Object.fromEntries(rendered)
        }));
      });
    }, state.loading ? 350 : 0);

    return () => window.clearTimeout(timeout);
  }, [state.messages, state.loading]);

  async function refreshConversations() {
    try {
      const result = await api<{ conversations: ConversationSummary[] }>("/api/copilot/conversations");
      setConversations(result.conversations);
    } catch {
      setConversations([]);
    }
  }

  async function refreshDocumentOptions() {
    setDocumentOptionsLoading(true);
    setDocumentOptionsError("");
    try {
      const result = await api<DocumentSummary[]>("/api/documents?sort=updatedAt&order=desc");
      setDocumentOptions(result.filter((doc) => !doc.path.toLowerCase().startsWith("copilot/")));
    } catch (error) {
      setDocumentOptions([]);
      setDocumentOptionsError(error instanceof Error ? error.message : t("copilot.notePicker.loadError"));
    } finally {
      setDocumentOptionsLoading(false);
    }
  }

  function clearPendingAutoSave() {
    if (autoSaveTimerRef.current) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }

  async function loadFolder(path: string): Promise<DocumentTreeEntry[] | null> {
    if (folderChildren.has(path)) return folderChildren.get(path) ?? null;
    const existing = folderRequestsRef.current.get(path);
    if (existing) return existing;

    setLoadingFolders((current) => {
      if (current.has(path)) return current;
      const next = new Set(current);
      next.add(path);
      return next;
    });

    const promise = (async () => {
      try {
        const params = new URLSearchParams({ sort: "name", order: "asc" });
        if (path) params.set("path", path);
        const data = await api<DocumentTreeEntry>(`/api/documents/tree?${params.toString()}`);
        const children = data.children ?? [];
        setFolderChildren((current) => {
          const next = new Map(current);
          next.set(path, children);
          return next;
        });
        return children;
      } catch {
        return null;
      } finally {
        folderRequestsRef.current.delete(path);
        setLoadingFolders((current) => {
          if (!current.has(path)) return current;
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      }
    })();

    folderRequestsRef.current.set(path, promise);
    return promise;
  }

  function setStateAndPersist(updater: (current: CopilotState) => CopilotState) {
    setState(updater);
  }

  function updateNotePicker(value: string, cursor: number) {
    const mention = mentionAtCursor(value, cursor);
    setNotePicker((current) => {
      if (mention) {
        return {
          open: true,
          query: mention.query,
          cursor,
          start: mention.start,
          category: current.open && current.start === mention.start ? current.category : null
        };
      }
      if (current.open && current.start === null) return { ...current, cursor };
      return { open: false, query: "", cursor, start: null, category: null };
    });
  }

  function handleInputChange(value: string, cursor: number) {
    setStateAndPersist((current) => ({ ...current, input: value }));
    setAttachedNotes((current) => current.filter((note) => inputIncludesNoteMention(value, note)));
    updateNotePicker(value, cursor);
  }

  function syncNotePickerFromInput(element: HTMLTextAreaElement) {
    updateNotePicker(element.value, element.selectionStart ?? element.value.length);
  }

  function updateNotePickerPosition() {
    const input = inputRef.current;
    if (!input || typeof window === "undefined") {
      setNotePickerPosition(null);
      return;
    }
    const anchor = input.closest(".copilot-input-shell") as HTMLElement | null;
    const rect = (anchor ?? input).getBoundingClientRect();
    const margin = 12;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const width = Math.min(Math.max(rect.width, 280), Math.max(280, viewportWidth - margin * 2));
    const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin));
    const bottom = Math.max(margin, viewportHeight - rect.top + 8);
    const availableAbove = Math.max(180, rect.top - margin * 2);
    setNotePickerPosition({
      left,
      bottom,
      width,
      maxHeight: Math.min(460, availableAbove)
    });
  }

  function replaceMentionText(label: string, keepOpen = false, nextQuery = "") {
    setStateAndPersist((current) => {
      const cursor = Math.min(notePicker.cursor || current.input.length, current.input.length);
      const start = notePicker.start ?? cursor;
      const before = current.input.slice(0, start);
      const after = current.input.slice(cursor);
      const prefix = before && !/\s$/.test(before) ? " " : "";
      return { ...current, input: `${before}${prefix}@${label}${keepOpen ? "" : " "}${after}` };
    });
    if (keepOpen) {
      const start = notePicker.start ?? (inputRef.current?.selectionStart ?? state.input.length);
      setNotePicker((current) => ({
        ...current,
        open: true,
        query: nextQuery,
        cursor: start + 1 + nextQuery.length,
        start,
        category: null
      }));
    }
  }

  function clearMentionText() {
    const targetCursor = notePicker.start ?? inputRef.current?.selectionStart ?? state.input.length;
    setStateAndPersist((current) => {
      const cursor = Math.min(notePicker.cursor || current.input.length, current.input.length);
      const start = Math.min(notePicker.start ?? cursor, cursor);
      const before = current.input.slice(0, start);
      const after = current.input.slice(cursor);
      const spacer = before && after && !/\s$/.test(before) && !/^\s/.test(after) ? " " : "";
      return { ...current, input: `${before}${spacer}${after}` };
    });
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      const cursor = Math.min(targetCursor, input.value.length);
      input.setSelectionRange(cursor, cursor);
    });
  }

  function insertNoteMention(note: NoteContext) {
    const label = noteMentionLabel(note);
    let nextCursor = state.input.length;
    setStateAndPersist((current) => {
      const cursor = Math.min(notePicker.cursor || current.input.length, current.input.length);
      const start = Math.min(notePicker.start ?? cursor, cursor);
      const before = current.input.slice(0, start);
      const after = current.input.slice(cursor);
      const prefix = before && !/\s$/.test(before) ? " " : "";
      const suffix = after && !/^\s/.test(after) ? " " : "";
      const mention = `${prefix}@${label} `;
      nextCursor = before.length + mention.length;
      return { ...current, input: `${before}${mention}${suffix}${after}` };
    });
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function attachNote(note: NoteContext) {
    setAttachedNotes((current) => (current.some((item) => item.path === note.path) ? current : [...current, note].slice(-6)));
    insertNoteMention(note);
    setNotePicker({ open: false, query: "", cursor: 0, start: null, category: null });
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }

  function selectActiveNote() {
    setIncludeCurrentNote(true);
    clearMentionText();
    setNotePicker({ open: false, query: "", cursor: 0, start: null, category: null });
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }

  function selectFolderPath(folderPath: string) {
    const query = `${folderPath.replace(/\/+$/, "")}/`;
    replaceMentionText(query, true, query);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      const cursor = (notePicker.start ?? 0) + 1 + query.length;
      inputRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  function selectCategory(category: "notes" | "folders") {
    setNotePicker((current) => ({ ...current, category, query: "" }));
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }

  function resetCategory() {
    setNotePicker((current) => ({ ...current, category: null, query: "" }));
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }

  function handlePickerOption(option: NotePickerOption) {
    if (option.kind === "active") {
      selectActiveNote();
      return;
    }
    if (option.kind === "category") {
      selectCategory(option.category);
      return;
    }
    if (option.kind === "back") {
      resetCategory();
      return;
    }
    if (option.kind === "folder") {
      selectFolderPath(option.path);
      return;
    }
    if (option.note.path.toLowerCase() === props.activeNote?.path.toLowerCase()) {
      selectActiveNote();
      return;
    }
    attachNote(option.note);
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const content = state.input.trim();
    if (!content || state.loading || providerStatus?.ok === false) return;

    const now = new Date().toISOString();
    const userMessage: ChatMessage = { id: randomId(), role: "user", content, createdAt: now };
    const assistantMessage: ChatMessage = { id: randomId(), role: "assistant", content: "", createdAt: now };
    const requestMessages = [...state.messages, userMessage];
    const assistantId = assistantMessage.id;
    const controller = new AbortController();
    const activeNote = includeCurrentNote && props.activeNote ? noteForRequest({ ...props.activeNote, isCurrent: true }) : undefined;
    const referencedNotes = attachedNotes.map(noteForRequest);
    abortRef.current = controller;

    setAttachedNotes([]);
    setStateAndPersist((current) => ({
      ...current,
      input: "",
      loading: true,
      error: "",
      status: t("copilot.status.thinking"),
      activities: [],
      messages: [...current.messages, userMessage, assistantMessage]
    }));

    try {
      const response = await fetch("/api/copilot/chat/stream", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: state.conversationId || undefined,
          messages: requestMessages,
          activeNote,
          referencedNotes
        }),
        signal: controller.signal
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error ?? t("copilot.error.stream"));
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      while (!done) {
        const read = await reader.read();
        done = read.done;
        const parsed = parseSseChunk(buffer, read.value ? decoder.decode(read.value, { stream: !done }) : "");
        buffer = parsed.buffer;
        for (const parsedEvent of parsed.events) {
          handleStreamEvent(parsedEvent.data, assistantId);
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        setStateAndPersist((current) => ({ ...current, loading: false, status: t("copilot.status.stopped") }));
      } else {
        setStateAndPersist((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : t("copilot.error.stream")
        }));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setStateAndPersist((current) => ({ ...current, loading: false }));
    }
  }

  function handleStreamEvent(rawData: string, assistantId: string) {
    let event: any;
    try {
      event = JSON.parse(rawData);
    } catch {
      return;
    }
    setStateAndPersist((current) => {
      if (event.type === "message_delta") {
        return {
          ...current,
          messages: current.messages.map((message) =>
            message.id === assistantId ? { ...message, content: `${message.content}${event.text ?? ""}` } : message
          )
        };
      }
      if (event.type === "status") {
        return { ...current, status: event.message ?? "" };
      }
      if (event.type === "tool_call") {
        return {
          ...current,
          status: friendlyToolStatus(event.name, "running"),
          activities: [...current.activities, { id: event.id, name: event.name, args: event.args, status: "running" }]
        };
      }
      if (event.type === "tool_result") {
        return {
          ...current,
          status: friendlyToolStatus(event.name, "done", event.result),
          activities: current.activities.map((activity) =>
            activity.id === event.id ? { ...activity, status: "done", result: event.result } : activity
          )
        };
      }
      if (event.type === "citation" && event.citation) {
        return {
          ...current,
          citations: mergeCitation(current.citations, event.citation),
          messages: current.messages.map((message) =>
            message.id === assistantId
              ? { ...message, citations: mergeCitation(message.citations ?? [], event.citation) }
              : message
          )
        };
      }
      if (event.type === "edit_proposal" && event.proposal) {
        return { ...current, proposals: mergeProposal(current.proposals, event.proposal) };
      }
      if (event.type === "error") {
        return { ...current, error: event.message ?? t("copilot.error.stream"), loading: false };
      }
      if (event.type === "done") {
        return { ...current, loading: false, status: "" };
      }
      return current;
    });
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function newChat() {
    stop();
    if (!state.loading && state.messages.length > 0) {
      await persistConversation({ signature: conversationAutoSaveKey(state.messages) });
    }
    setHistoryMenuOpen(false);
    setAttachedNotes([]);
    setIncludeCurrentNote(true);
    setNotePicker({ open: false, query: "", cursor: 0, start: null, category: null });
    setRenderedMessages({});
    setState({ ...emptyState });
  }

  async function persistConversation(options: { closeHistory?: boolean; signature?: string } = {}) {
    const signature = options.signature ?? conversationAutoSaveKey(state.messages);
    if (state.messages.length === 0 || saving || signature === lastAutoSaveKeyRef.current) return;
    if (state.conversationId && deletedConversationIdsRef.current.has(state.conversationId)) return;
    if (state.conversationPath && deletedConversationPathsRef.current.has(state.conversationPath)) return;
    setSaving(true);
    try {
      const saved = await api<SavedCopilotState & { id: string; path?: string; title: string; createdAt: string; updatedAt: string }>("/api/copilot/conversations", {
        method: "POST",
        body: JSON.stringify({
          id: state.conversationId || undefined,
          path: state.conversationPath || undefined,
          title: state.title || undefined,
          messages: state.messages
        })
      });
      lastAutoSaveKeyRef.current = signature;
      setStateAndPersist((current) => ({
        ...current,
        conversationId: saved.id,
        conversationPath: saved.path ?? current.conversationPath,
        title: saved.title
      }));
      await refreshConversations();
      if (options.closeHistory) setHistoryMenuOpen(false);
    } catch (error) {
      setStateAndPersist((current) => ({ ...current, error: error instanceof Error ? error.message : t("copilot.error.save") }));
    } finally {
      setSaving(false);
    }
  }

  async function loadConversation(conversationId: string) {
    if (!conversationId || loadingConversation) return;
    setLoadingConversation(true);
    try {
      if (!state.loading && state.messages.length > 0) {
        await persistConversation({ signature: conversationAutoSaveKey(state.messages) });
      }
      const conversation = await api<{
        id: string;
        title: string;
        path?: string;
        messages: ChatMessage[];
        createdAt: string;
        updatedAt: string;
      }>(`/api/copilot/conversations/${encodeURIComponent(conversationId)}`);
      deletedConversationIdsRef.current.delete(conversation.id);
      if (conversation.path) deletedConversationPathsRef.current.delete(conversation.path);
      lastAutoSaveKeyRef.current = conversationAutoSaveKey(conversation.messages);
      setState({
        ...emptyState,
        conversationId: conversation.id,
        conversationPath: conversation.path ?? "",
        title: conversation.title,
        messages: conversation.messages,
        status: t("copilot.status.loaded")
      });
      setAttachedNotes([]);
      setIncludeCurrentNote(true);
      setNotePicker({ open: false, query: "", cursor: 0, start: null, category: null });
      setRenderedMessages({});
      setHistoryMenuOpen(false);
    } catch (error) {
      setStateAndPersist((current) => ({ ...current, error: error instanceof Error ? error.message : t("copilot.error.load") }));
    } finally {
      setLoadingConversation(false);
    }
  }

  async function deleteConversationHistory(conversation: ConversationSummary) {
    if (loadingConversation || saving || deletingConversationId) return;
    const deletingCurrent = conversation.id === state.conversationId || Boolean(conversation.path && conversation.path === state.conversationPath);
    deletedConversationIdsRef.current.add(conversation.id);
    if (conversation.path) deletedConversationPathsRef.current.add(conversation.path);
    if (deletingCurrent) {
      clearPendingAutoSave();
      lastAutoSaveKeyRef.current = conversationAutoSaveKey(state.messages);
    }
    setDeletingConversationId(conversation.id);
    try {
      const params = new URLSearchParams();
      if (conversation.path) params.set("path", conversation.path);
      const query = params.toString();
      const deleted = await api<{ ok: true; path: string; paths?: string[] }>(`/api/copilot/conversations/${encodeURIComponent(conversation.id)}${query ? `?${query}` : ""}`, {
        method: "DELETE"
      });
      notifyVaultFilesChanged(deleted.paths?.length ? deleted.paths : [deleted.path]);
      setConversations((current) => current.filter((item) => item.id !== conversation.id && item.path !== conversation.path));
      if (deletingCurrent) {
        setAttachedNotes([]);
        setIncludeCurrentNote(true);
        setNotePicker({ open: false, query: "", cursor: 0, start: null, category: null });
        setRenderedMessages({});
        setState({ ...emptyState });
      }
      await refreshConversations();
    } catch (error) {
      deletedConversationIdsRef.current.delete(conversation.id);
      if (conversation.path) deletedConversationPathsRef.current.delete(conversation.path);
      await refreshConversations();
      setStateAndPersist((current) => ({ ...current, error: error instanceof Error ? error.message : t("copilot.error.delete") }));
    } finally {
      setDeletingConversationId("");
    }
  }

  async function applyProposal(proposal: FileEditProposal) {
    try {
      const updated = await api<FileEditProposal>(`/api/copilot/file-edits/${encodeURIComponent(proposal.id)}/apply`, {
        method: "POST"
      });
      setStateAndPersist((current) => ({ ...current, proposals: mergeProposal(current.proposals, updated) }));
      notifyVaultFilesChanged([updated.path]);
      void refreshDocumentOptions();
      props.onOpenSource?.(updated.path);
    } catch (error) {
      setStateAndPersist((current) => ({
        ...current,
        proposals: current.proposals.map((item) =>
          item.id === proposal.id
            ? { ...item, status: "conflict", message: error instanceof Error ? error.message : t("copilot.error.apply") }
            : item
        )
      }));
    }
  }

  async function rejectProposal(proposal: FileEditProposal) {
    try {
      const updated = await api<FileEditProposal>(`/api/copilot/file-edits/${encodeURIComponent(proposal.id)}`, {
        method: "DELETE"
      });
      setStateAndPersist((current) => ({ ...current, proposals: mergeProposal(current.proposals, updated) }));
    } catch {
      setStateAndPersist((current) => ({
        ...current,
        proposals: current.proposals.map((item) => (item.id === proposal.id ? { ...item, status: "rejected", message: t("copilot.proposal.rejected") } : item))
      }));
    }
  }

  async function copyAnswerMarkdown(message: ChatMessage) {
    if (!message.content.trim()) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(message.content);
      setStateAndPersist((current) => ({ ...current, status: t("copilot.answer.copied"), error: "" }));
    } catch {
      setStateAndPersist((current) => ({ ...current, error: t("copilot.answer.copyError") }));
    }
  }

  function openAnswerSave(message: ChatMessage) {
    if (!message.content.trim()) return;
    setAnswerSave({
      content: message.content,
      folder: props.activeNote?.path && !props.activeNote.isDraft ? parentFolderOfPath(props.activeNote.path) : "",
      name: defaultAnswerFileName(message.content),
      busy: false,
      error: ""
    });
  }

  async function saveAnswerMarkdown() {
    if (!answerSave || answerSave.busy) return;
    const fileName = normalizeAnswerFileName(answerSave.name);
    if (!fileName) {
      setAnswerSave((current) => (current ? { ...current, error: t("copilot.answer.saveNameError") } : current));
      return;
    }

    const targetPath = answerPath(answerSave.folder, fileName);
    setAnswerSave((current) => (current ? { ...current, busy: true, error: "" } : current));
    try {
      const created = await api<DocumentContent>("/api/documents", {
        method: "POST",
        body: JSON.stringify({ path: targetPath, content: answerSave.content })
      });
      notifyVaultFilesChanged([created.path]);
      setAnswerSave(null);
      setStateAndPersist((current) => ({ ...current, status: t("copilot.answer.saved", { path: created.path }), error: "" }));
      await refreshDocumentOptions();
    } catch (error) {
      setAnswerSave((current) => (
        current
          ? {
              ...current,
              busy: false,
              error: error instanceof Error ? error.message : t("copilot.answer.saveError")
            }
          : current
      ));
    }
  }

  async function openRenderedInternalLink(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a.internal-link");
    if (!(anchor instanceof HTMLAnchorElement) || !event.currentTarget.contains(anchor)) return;

    const rawTarget = anchor.getAttribute("title")?.trim() || anchor.textContent?.trim();
    if (!rawTarget || rawTarget.startsWith("#")) return;

    event.preventDefault();
    const params = new URLSearchParams({ target: rawTarget, base: "copilot/assistant.md" });
    try {
      const resolved = await api<{ path: string }>(`/api/documents/resolve-link?${params.toString()}`);
      props.onOpenSource?.(resolved.path);
    } catch {
      props.onOpenSource?.(rawTarget.endsWith(".md") ? rawTarget : `${rawTarget}.md`);
    }
  }

  const providerUnavailable = providerStatus?.ok === false;
  const activePath = props.activeNote?.path.toLowerCase() ?? "";
  const attachedPaths = new Set(attachedNotes.map((note) => note.path.toLowerCase()));
  const noteQuery = notePicker.query.trim();
  const folderPaths = useMemo(() => folderPathsFromDocuments(documentOptions), [documentOptions]);
  const notePickerOptions = useMemo<NotePickerOption[]>(() => {
    if (!notePicker.open) return [];

    const noteItems = documentOptions
      .map(noteFromDocument)
      .filter((note) => {
        const pathName = note.path.toLowerCase();
        return pathName !== activePath && !attachedPaths.has(pathName);
      });
    const folderItems = folderPaths.map((folderPath) => ({
      path: folderPath,
      title: folderName(folderPath),
      subtitle: folderPath
    }));
    const makeNoteOption = (note: NoteContext): NotePickerOption => ({
      kind: "note",
      key: `note:${note.path}`,
      title: noteTitle(note),
      subtitle: note.path,
      badge: t("copilot.notePicker.noteBadge"),
      note
    });
    const makeFolderOption = (folderPath: string): NotePickerOption => ({
      kind: "folder",
      key: `folder:${folderPath}`,
      title: `${folderName(folderPath)}/`,
      subtitle: `${folderPath}/`,
      badge: t("copilot.notePicker.folderBadge"),
      path: folderPath
    });
    if (!noteQuery && !notePicker.category) {
      return [
        ...noteItems.slice(0, 24).map(makeNoteOption),
        ...folderPaths.slice(0, 6).map(makeFolderOption)
      ].slice(0, MAX_MENTION_RESULTS);
    }

    if (noteQuery.includes("/")) {
      const rawPathQuery = noteQuery.replace(/^\/+/, "");
      const lastSlash = rawPathQuery.lastIndexOf("/");
      const parentPrefix = rawPathQuery.endsWith("/")
        ? rawPathQuery.replace(/\/+$/, "")
        : lastSlash === -1
          ? ""
          : rawPathQuery.slice(0, lastSlash);
      const fragment = rawPathQuery.endsWith("/") || lastSlash === -1 ? "" : rawPathQuery.slice(lastSlash + 1);
      const fragmentLower = fragment.toLowerCase();
      const directFolders = folderPaths.filter((folderPath) => {
        if (parentFolderOfPath(folderPath) !== parentPrefix) return false;
        return !fragmentLower || folderName(folderPath).toLowerCase().includes(fragmentLower);
      });
      const directNotes = noteItems.filter((note) => {
        if (parentFolderOfPath(note.path) !== parentPrefix) return false;
        const basename = note.path.split("/").pop() ?? note.path;
        return !fragmentLower || `${note.title} ${basename}`.toLowerCase().includes(fragmentLower);
      });
      const sortedFolders = fragment
        ? fuzzysort.go(fragment, directFolders.map((pathName) => ({ path: pathName, title: folderName(pathName) })), {
            keys: ["title", "path"],
            limit: MAX_MENTION_RESULTS,
            threshold: -10000
          }).map((result) => result.obj.path)
        : directFolders;
      const sortedNotes = fragment
        ? fuzzysort.go(fragment, directNotes, {
            keys: ["title", "path"],
            limit: MAX_MENTION_RESULTS,
            threshold: -10000
          }).map((result) => result.obj)
        : directNotes;
      return [
        ...sortedFolders.map(makeFolderOption),
        ...sortedNotes.map(makeNoteOption)
      ].slice(0, MAX_MENTION_RESULTS);
    }

    if (notePicker.category === "notes") {
      const results = noteQuery
        ? fuzzysort.go(noteQuery, noteItems, {
            keys: ["title", "path"],
            limit: MAX_MENTION_RESULTS,
            threshold: -10000
          }).map((result) => result.obj)
        : noteItems.slice(0, MAX_MENTION_RESULTS);
      return [
        {
          kind: "back",
          key: "back",
          title: t("copilot.notePicker.back"),
          subtitle: t("copilot.notePicker.backSubtitle"),
          badge: ""
        },
        ...results.map(makeNoteOption)
      ];
    }

    if (notePicker.category === "folders") {
      const results = noteQuery
        ? fuzzysort.go(noteQuery, folderItems, {
            keys: ["title", "subtitle"],
            limit: MAX_MENTION_RESULTS,
            threshold: -10000
          }).map((result) => result.obj.path)
        : folderPaths.slice(0, MAX_MENTION_RESULTS);
      return [
        {
          kind: "back",
          key: "back",
          title: t("copilot.notePicker.back"),
          subtitle: t("copilot.notePicker.backSubtitle"),
          badge: ""
        },
        ...results.map(makeFolderOption)
      ];
    }

    const noteResults = fuzzysort.go(noteQuery, noteItems, {
      keys: ["title", "path"],
      limit: MAX_MENTION_RESULTS,
      threshold: -10000
    }).map((result) => result.obj);
    const folderResults = fuzzysort.go(noteQuery, folderItems, {
      keys: ["title", "subtitle"],
      limit: MAX_MENTION_RESULTS,
      threshold: -10000
    }).map((result) => result.obj.path);
    return [
      ...noteResults.map(makeNoteOption),
      ...folderResults.map(makeFolderOption)
    ].slice(0, MAX_MENTION_RESULTS);
  }, [activePath, attachedNotes, documentOptions, folderPaths, notePicker.category, notePicker.open, noteQuery, props.activeNote, t]);

  useEffect(() => {
    setNotePickerActiveIndex(0);
  }, [notePicker.category, notePicker.open, notePicker.query, notePicker.start]);

  useEffect(() => {
    if (!notePicker.open || notePickerOptions.length === 0) return;
    setNotePickerActiveIndex((current) => Math.max(0, Math.min(current, notePickerOptions.length - 1)));
  }, [notePicker.open, notePickerOptions.length]);

  useEffect(() => {
    if (!notePicker.open) return;
    const activeOption = notePickerRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    activeOption?.scrollIntoView({ block: "nearest" });
  }, [notePicker.open, notePickerActiveIndex, notePickerOptions.length]);

  const clampedPickerIndex = notePickerOptions.length === 0 ? 0 : Math.min(notePickerActiveIndex, notePickerOptions.length - 1);
  const activePickerOption = notePickerOptions[clampedPickerIndex];
  const activePickerDescendant = notePicker.open && activePickerOption ? notePickerOptionId(clampedPickerIndex) : undefined;
  const notePickerEmptyMessage =
    documentOptionsLoading && documentOptions.length === 0
      ? t("copilot.notePicker.loading")
      : documentOptionsError
        ? t("copilot.notePicker.error", { message: documentOptionsError })
        : t("copilot.notePicker.empty");
  const notePickerStyle: CSSProperties | undefined = notePickerPosition
    ? {
        left: `${notePickerPosition.left}px`,
        bottom: `${notePickerPosition.bottom}px`,
        width: `${notePickerPosition.width}px`,
        maxHeight: `${notePickerPosition.maxHeight}px`
      }
    : undefined;
  const notePickerNode =
    notePicker.open && typeof document !== "undefined"
      ? createPortal(
          <div
            id={NOTE_PICKER_ID}
            ref={notePickerRef}
            className="copilot-note-picker copilot-note-picker-floating"
            role="listbox"
            aria-label={t("copilot.notePicker.label")}
            style={notePickerStyle}
          >
            {notePickerOptions.length === 0 ? <div className="copilot-note-picker-empty">{notePickerEmptyMessage}</div> : null}
            {notePickerOptions.map((option, index) => (
              <button
                id={notePickerOptionId(index)}
                type="button"
                role="option"
                aria-selected={index === clampedPickerIndex}
                key={option.key}
                data-active={index === clampedPickerIndex ? "true" : undefined}
                data-kind={option.kind}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setNotePickerActiveIndex(index)}
                onClick={() => handlePickerOption(option)}
              >
                <strong translate="no">{option.title}</strong>
                <span translate="no">{option.subtitle}</span>
                {option.badge ? <em>{option.badge}</em> : null}
              </button>
            ))}
          </div>,
          document.body
        )
      : null;
  const answerSaveNode =
    answerSave && typeof document !== "undefined"
      ? createPortal(
          <div
            className="modal-backdrop"
            role="presentation"
            onMouseDown={() => !answerSave.busy && setAnswerSave(null)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !answerSave.busy) setAnswerSave(null);
            }}
          >
            <section
              className="prompt-modal path-picker-modal copilot-answer-save-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="copilot-answer-save-title"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <p className="eyebrow">{t("copilot.answer.saveEyebrow")}</p>
              <h2 id="copilot-answer-save-title">{t("copilot.answer.saveTitle")}</h2>
              <p className="muted">{t("copilot.answer.saveDescription")}</p>
              <form
                className="prompt-form path-picker-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveAnswerMarkdown();
                }}
              >
                <div>
                  <label className="path-picker-section-label">{t("prompt.pickFolder")}</label>
                  <FolderPicker
                    folderChildren={folderChildren}
                    loadingFolders={loadingFolders}
                    loadFolder={loadFolder}
                    value={answerSave.folder}
                    onChange={(folder) => setAnswerSave((current) => (current ? { ...current, folder } : current))}
                    maxHeight="min(42dvh, 300px)"
                  />
                  <p className="muted path-picker-current" translate="no">
                    {t("prompt.targetFolder", { folder: answerSave.folder || t("folderPicker.vaultRoot") })}
                  </p>
                </div>
                <label>
                  {t("copilot.answer.fileName")}
                  <input
                    name="copilot-answer-file-name"
                    autoComplete="off"
                    spellCheck={false}
                    value={answerSave.name}
                    disabled={answerSave.busy}
                    onChange={(event) => setAnswerSave((current) => (current ? { ...current, name: event.target.value } : current))}
                  />
                </label>
                {answerSave.error ? <div className="error" role="alert">{answerSave.error}</div> : null}
                <div className="prompt-actions">
                  <button type="button" onClick={() => setAnswerSave(null)} disabled={answerSave.busy}>{t("prompt.cancel")}</button>
                  <button type="submit" className="primary" disabled={answerSave.busy || !answerSave.name.trim()} aria-busy={answerSave.busy}>
                    {answerSave.busy ? t("copilot.answer.saveBusy") : t("copilot.answer.saveSubmit")}
                  </button>
                </div>
              </form>
            </section>
          </div>,
          document.body
        )
      : null;

  function renderCitationButtons(citations: Citation[], totalCount: number) {
    return (
      <>
        {citations.map((citation, index) => (
          <button
            className="copilot-message-source"
            type="button"
            key={`${citation.path}-${index}`}
            onClick={() => props.onOpenSource?.(citation.path)}
            disabled={!props.onOpenSource}
            title={`${citation.title}\n${citation.path}`}
            aria-label={`${t("copilot.sources")}: ${citation.title}`}
          >
            <strong translate="no">{citation.title}</strong>
            <span translate="no">{citation.path}</span>
          </button>
        ))}
        {totalCount > citations.length ? (
          <div className="copilot-citation-more">{t("copilot.sources.moreCompact", { count: totalCount - citations.length })}</div>
        ) : null}
      </>
    );
  }

  function renderAnswerActions(message: ChatMessage) {
    if (message.role !== "assistant" || !message.content.trim()) return null;
    if (state.loading && state.messages[state.messages.length - 1]?.id === message.id) return null;
    return (
      <div className="copilot-message-actions" role="group" aria-label={t("copilot.answer.actions")}>
        <button
          type="button"
          className="icon-button copilot-answer-action"
          onClick={() => copyAnswerMarkdown(message)}
          aria-label={t("copilot.answer.copy")}
          title={t("copilot.answer.copy")}
        >
          <CopyIcon />
        </button>
        <button
          type="button"
          className="icon-button copilot-answer-action"
          onClick={() => openAnswerSave(message)}
          aria-label={t("copilot.answer.save")}
          title={t("copilot.answer.save")}
        >
          <SaveIcon />
        </button>
      </div>
    );
  }

  return (
    <aside
      className={`qa-view copilot-view ${props.compact ? "qa-panel panel" : ""}`}
      aria-label={t("copilot.eyebrow")}
      data-collapsed={props.compact && props.collapsed ? "true" : undefined}
    >
      {props.compact && props.onToggleCollapsed ? (
        <div className="pane-collapsed-rail desktop-only" inert={!props.collapsed} aria-hidden={!props.collapsed || undefined}>
          <button type="button" className="icon-button pane-expand-toggle" aria-label={t("qa.expand")} title={t("qa.expand")} onClick={props.onToggleCollapsed}>
            <PanelToggleIcon />
          </button>
          <span className="pane-collapsed-icon" aria-hidden="true">
            <AskIcon />
          </span>
        </div>
      ) : null}

      {props.onDismiss ? (
        <div className="copilot-mobile-header">
          <strong>{t("copilot.title")}</strong>
          <button type="button" className="icon-button" aria-label={t("copilot.close")} onClick={props.onDismiss}>
            <CloseIcon />
          </button>
        </div>
      ) : null}

      <section className={props.compact ? "qa-hero copilot-hero" : "panel hero copilot-hero"}>
        {props.compact && props.onToggleCollapsed ? (
          <div className="qa-hero-top desktop-only">
            <button type="button" className="icon-button pane-collapse-toggle qa-collapse-toggle" aria-label={t("qa.collapse")} title={t("qa.collapse")} onClick={props.onToggleCollapsed}>
              <PanelToggleIcon />
            </button>
            <p className="eyebrow">{t("copilot.eyebrow")}</p>
          </div>
        ) : (
          <p className="eyebrow desktop-only">{t("copilot.eyebrow")}</p>
        )}
        {props.compact ? <h2 className="desktop-only">{t("copilot.title")}</h2> : <h1>{t("copilot.title")}</h1>}
        {providerUnavailable ? <div className="error">{providerStatus.reason}</div> : null}
      </section>

      <div className="copilot-chat-log" ref={chatLogRef} aria-live="polite">
        {state.messages.length === 0 ? <div className="empty-state">{t("copilot.empty")}</div> : null}
        {state.messages.map((message) => {
          const messageCitations = message.role === "assistant" ? sortCitations(message.citations ?? []) : [];
          const visibleMessageCitations = messageCitations.slice(0, MAX_VISIBLE_CITATIONS);
          return (
            <article className={`copilot-message copilot-message-${message.role}`} key={message.id}>
              <div className="copilot-message-role">{message.role === "user" ? t("copilot.user") : t("copilot.assistant")}</div>
              {message.role === "assistant" && renderedMessages[message.id] ? (
                <div
                  className="qa-answer copilot-message-content copilot-rendered-preview"
                  onClick={openRenderedInternalLink}
                  dangerouslySetInnerHTML={{ __html: renderedMessages[message.id] }}
                />
              ) : (
                <div className="qa-answer copilot-message-content">
                  {message.content || (message.role === "assistant" && state.loading ? t("copilot.status.thinking") : "")}
                </div>
              )}
              {renderAnswerActions(message)}
              {visibleMessageCitations.length > 0 ? (
                <section className="copilot-message-sources" aria-label={t("copilot.sources")}>
                  <div className="copilot-message-sources-title">
                    <span>{t("copilot.sources")}</span>
                    <strong>{messageCitations.length}</strong>
                  </div>
                  <div className="copilot-message-source-list">
                    {renderCitationButtons(visibleMessageCitations, messageCitations.length)}
                  </div>
                </section>
              ) : null}
            </article>
          );
        })}
        {state.proposals.map((proposal) => (
          <article className="copilot-proposal-card" key={proposal.id}>
            <div className="copilot-tool-title">
              <strong>{proposal.title}</strong>
              <span className="status-pill">{proposal.status}</span>
            </div>
            {proposal.message ? <p className={proposal.status === "conflict" ? "error" : "muted"}>{proposal.message}</p> : null}
            <pre className="copilot-diff" translate="no">{proposal.diff}</pre>
            <div className="copilot-proposal-actions">
              <button type="button" className="primary" onClick={() => applyProposal(proposal)} disabled={proposal.status !== "pending" && proposal.status !== "conflict"}>
                {t("copilot.proposal.apply")}
              </button>
              <button type="button" onClick={() => rejectProposal(proposal)} disabled={proposal.status !== "pending"}>
                {t("copilot.proposal.reject")}
              </button>
            </div>
          </article>
        ))}
      </div>

      {notePickerNode}
      {answerSaveNode}

      <div className="copilot-composer">
        <div className="copilot-composer-toolbar" aria-label={t("copilot.toolbar")}>
          <div className="copilot-mode-label">
            <span>{t("copilot.mode.vaultQa")}</span>
          </div>
          <div className="copilot-composer-actions">
            <button
              type="button"
              className="icon-button copilot-icon-button copilot-new-chat"
              onClick={newChat}
              disabled={state.loading}
              aria-label={t("copilot.new")}
              title={t("copilot.new")}
            >
              <PlusIcon />
            </button>
            <div className="copilot-history-menu" ref={historyMenuRef}>
              <button
                type="button"
                className="icon-button copilot-icon-button copilot-history-trigger"
                aria-haspopup="dialog"
                aria-expanded={historyMenuOpen}
                aria-label={t("copilot.history")}
                title={t("copilot.history")}
                onClick={() => {
                  const nextOpen = !historyMenuOpen;
                  setHistoryMenuOpen(nextOpen);
                  if (nextOpen) void refreshConversations();
                }}
              >
                <HistoryIcon />
              </button>
              {historyMenuOpen ? (
                <div className="copilot-history-popover" role="dialog" aria-label={t("copilot.history")} aria-busy={saving || loadingConversation}>
                  {conversations.length === 0 ? (
                    <div className="copilot-history-empty">{t("copilot.history.empty")}</div>
                  ) : (
                    <div className="copilot-history-list">
                      {conversations.map((conversation) => (
                        <div
                          className="copilot-history-item"
                          key={conversation.id}
                          data-active={conversation.id === state.conversationId ? "true" : undefined}
                        >
                          <button
                            type="button"
                            className="copilot-history-load"
                            onClick={() => loadConversation(conversation.id)}
                            disabled={state.loading || loadingConversation}
                          >
                            <strong translate="no">{conversation.title}</strong>
                            <span>{formatHistoryTime(conversation.updatedAt)}</span>
                          </button>
                          <div className="copilot-history-item-actions">
                            <button
                              type="button"
                              className="icon-button copilot-history-action"
                              onClick={() => conversation.path && props.onOpenSource?.(conversation.path)}
                              disabled={!conversation.path || !props.onOpenSource}
                              aria-label={t("copilot.history.open")}
                              title={t("copilot.history.open")}
                            >
                              <EyeIcon />
                            </button>
                            <button
                              type="button"
                              className="icon-button copilot-history-action danger"
                              onClick={() => deleteConversationHistory(conversation)}
                              disabled={state.loading || loadingConversation || saving || deletingConversationId === conversation.id}
                              aria-label={t("copilot.history.delete")}
                              title={t("copilot.history.delete")}
                            >
                              <TrashIcon />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <form className="ask-row copilot-input-row" onSubmit={sendMessage}>
          <div className="copilot-input-shell">
            <label className="sr-only" htmlFor="copilot-message">{t("copilot.input")}</label>
            <textarea
              id="copilot-message"
              ref={inputRef}
              value={state.input}
              onChange={(event) => handleInputChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
              onClick={(event) => syncNotePickerFromInput(event.currentTarget)}
              onFocus={(event) => syncNotePickerFromInput(event.currentTarget)}
              onKeyUp={(event) => {
                if (!["Escape", "ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)) syncNotePickerFromInput(event.currentTarget);
              }}
              onSelect={(event) => updateNotePicker(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
              placeholder={providerUnavailable ? t("copilot.disabledPlaceholder") : t("copilot.placeholder")}
              rows={3}
              disabled={state.loading || providerUnavailable}
              aria-controls={notePicker.open ? NOTE_PICKER_ID : undefined}
              aria-expanded={notePicker.open}
              aria-haspopup="listbox"
              aria-activedescendant={activePickerDescendant}
              onKeyDown={(event) => {
                if (event.key === "Escape" && notePicker.open) {
                  event.preventDefault();
                  setNotePicker({ open: false, query: "", cursor: 0, start: null, category: null });
                  return;
                }
                if (notePicker.open && notePickerOptions.length > 0 && event.key === "ArrowDown") {
                  event.preventDefault();
                  setNotePickerActiveIndex((current) => (current + 1) % notePickerOptions.length);
                  return;
                }
                if (notePicker.open && notePickerOptions.length > 0 && event.key === "ArrowUp") {
                  event.preventDefault();
                  setNotePickerActiveIndex((current) => (current - 1 + notePickerOptions.length) % notePickerOptions.length);
                  return;
                }
                if (notePicker.open && notePickerOptions.length > 0 && (event.key === "Tab" || (event.key === "Enter" && !event.metaKey && !event.ctrlKey))) {
                  event.preventDefault();
                  if (activePickerOption) handlePickerOption(activePickerOption);
                  return;
                }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  sendMessage();
                }
                if (event.key === "@") {
                  window.requestAnimationFrame(() => {
                    const input = inputRef.current;
                    if (input) syncNotePickerFromInput(input);
                  });
                }
              }}
            />
          </div>
          <div className="copilot-submit-row">
            {state.status ? <div className="copilot-inline-status">{state.status}</div> : null}
            {state.loading ? (
              <button type="button" className="icon-button copilot-input-action" onClick={stop} aria-label={t("copilot.stop")} title={t("copilot.stop")}>
                <StopIcon />
              </button>
            ) : (
              <button
                className="icon-button copilot-input-action"
                type="submit"
                disabled={!state.input.trim() || providerUnavailable}
                aria-label={t("copilot.send")}
                title={t("copilot.send")}
              >
                <SendIcon />
              </button>
            )}
          </div>
        </form>
        {state.error ? <div className="error" aria-live="polite">{state.error}</div> : null}
      </div>
    </aside>
  );
});
