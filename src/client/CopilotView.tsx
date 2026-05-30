import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import fuzzysort from "fuzzysort";
import type { DocumentSummary } from "../shared/types";
import { api } from "./api";
import { AskIcon, BusyLabel, PanelToggleIcon } from "./icons";
import { useT } from "./i18n";
import { parseSseChunk } from "./copilot/sse";

type ChatRole = "user" | "assistant";

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
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
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  activeNote?: NoteContext | null;
}) {
  const t = useT();
  const username = props.username || "__anonymous__";
  const [state, setState] = useState<CopilotState>(() => ({ ...emptyState, ...readSavedState(username) }));
  const [providerStatus, setProviderStatus] = useState<CopilotProviderStatus | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [documentOptions, setDocumentOptions] = useState<DocumentSummary[]>([]);
  const [documentOptionsLoading, setDocumentOptionsLoading] = useState(false);
  const [documentOptionsError, setDocumentOptionsError] = useState("");
  const [includeCurrentNote, setIncludeCurrentNote] = useState(true);
  const [attachedNotes, setAttachedNotes] = useState<NoteContext[]>([]);
  const [notePicker, setNotePicker] = useState<NotePickerState>({ open: false, query: "", cursor: 0, start: null, category: null });
  const [notePickerPosition, setNotePickerPosition] = useState<NotePickerPosition | null>(null);
  const [renderedMessages, setRenderedMessages] = useState<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const notePickerRef = useRef<HTMLDivElement | null>(null);
  const previewCacheRef = useRef(new Map<string, { content: string; html: string }>());

  useEffect(() => {
    setState({ ...emptyState, ...readSavedState(username) });
    setRenderedMessages({});
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
      setSelectedConversationId((current) => current || result.conversations[0]?.id || "");
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
    const rect = input.getBoundingClientRect();
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

  function attachNote(note: NoteContext) {
    setAttachedNotes((current) => (current.some((item) => item.path === note.path) ? current : [...current, note].slice(-6)));
    replaceMentionText(noteTitle(note));
    setNotePicker({ open: false, query: "", cursor: 0, start: null, category: null });
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }

  function selectActiveNote() {
    setIncludeCurrentNote(true);
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

  function removeAttachedNote(pathName: string) {
    setAttachedNotes((current) => current.filter((note) => note.path !== pathName));
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
        return { ...current, citations: mergeCitation(current.citations, event.citation) };
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

  function newChat() {
    stop();
    setAttachedNotes([]);
    setIncludeCurrentNote(true);
    setNotePicker({ open: false, query: "", cursor: 0, start: null, category: null });
    setRenderedMessages({});
    setState({ ...emptyState });
  }

  async function saveChat() {
    if (state.messages.length === 0 || saving) return;
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
      setStateAndPersist((current) => ({
        ...current,
        conversationId: saved.id,
        conversationPath: saved.path ?? current.conversationPath,
        title: saved.title
      }));
      await refreshConversations();
    } catch (error) {
      setStateAndPersist((current) => ({ ...current, error: error instanceof Error ? error.message : t("copilot.error.save") }));
    } finally {
      setSaving(false);
    }
  }

  async function loadSelectedConversation() {
    if (!selectedConversationId || loadingConversation) return;
    setLoadingConversation(true);
    try {
      const conversation = await api<{
        id: string;
        title: string;
        path?: string;
        messages: ChatMessage[];
        createdAt: string;
        updatedAt: string;
      }>(`/api/copilot/conversations/${encodeURIComponent(selectedConversationId)}`);
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
    } catch (error) {
      setStateAndPersist((current) => ({ ...current, error: error instanceof Error ? error.message : t("copilot.error.load") }));
    } finally {
      setLoadingConversation(false);
    }
  }

  async function applyProposal(proposal: FileEditProposal) {
    try {
      const updated = await api<FileEditProposal>(`/api/copilot/file-edits/${encodeURIComponent(proposal.id)}/apply`, {
        method: "POST"
      });
      setStateAndPersist((current) => ({ ...current, proposals: mergeProposal(current.proposals, updated) }));
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
  const normalizedNoteQuery = noteQuery.toLowerCase();
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
    const activeOption: NotePickerOption | null = props.activeNote
      ? {
          kind: "active",
          key: `active:${props.activeNote.path}`,
          title: t("copilot.notePicker.activeNote"),
          subtitle: props.activeNote.path,
          badge: t("copilot.notePicker.activeBadge")
        }
      : null;

    if (!noteQuery && !notePicker.category) {
      return [
        ...(activeOption ? [activeOption] : []),
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

    const activeMatches = activeOption && t("copilot.notePicker.activeNote").toLowerCase().includes(normalizedNoteQuery) ? [activeOption] : [];
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
      ...activeMatches,
      ...noteResults.map(makeNoteOption),
      ...folderResults.map(makeFolderOption)
    ].slice(0, MAX_MENTION_RESULTS);
  }, [activePath, attachedNotes, documentOptions, folderPaths, notePicker.category, notePicker.open, noteQuery, props.activeNote, t]);
  const visibleCitations = sortCitations(state.citations).slice(0, MAX_VISIBLE_CITATIONS);
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
            ref={notePickerRef}
            className="copilot-note-picker copilot-note-picker-floating"
            role="listbox"
            aria-label={t("copilot.notePicker.label")}
            style={notePickerStyle}
          >
            {notePickerOptions.length === 0 ? <div className="copilot-note-picker-empty">{notePickerEmptyMessage}</div> : null}
            {notePickerOptions.map((option) => (
              <button
                type="button"
                role="option"
                key={option.key}
                data-kind={option.kind}
                onMouseDown={(event) => event.preventDefault()}
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
        <div className="copilot-toolbar" aria-label={t("copilot.toolbar")}>
          <button type="button" onClick={newChat} disabled={state.loading}>{t("copilot.new")}</button>
          <button type="button" onClick={saveChat} disabled={state.messages.length === 0 || state.loading || saving} aria-busy={saving}>
            <BusyLabel busy={saving} busyText={t("copilot.saveBusy")}>{t("copilot.save")}</BusyLabel>
          </button>
          <select value={selectedConversationId} onChange={(event) => setSelectedConversationId(event.target.value)} aria-label={t("copilot.loadSelect")}>
            <option value="">{t("copilot.loadSelect")}</option>
            {conversations.map((conversation) => (
              <option key={conversation.id} value={conversation.id}>{conversation.title}</option>
            ))}
          </select>
          <button type="button" onClick={loadSelectedConversation} disabled={!selectedConversationId || state.loading || loadingConversation} aria-busy={loadingConversation}>
            <BusyLabel busy={loadingConversation} busyText={t("copilot.loadBusy")}>{t("copilot.load")}</BusyLabel>
          </button>
        </div>
        {providerUnavailable ? <div className="error">{providerStatus.reason}</div> : null}
        {props.activeNote || attachedNotes.length > 0 ? (
          <div className="copilot-context-row" aria-label={t("copilot.context.label")}>
            {props.activeNote ? (
              <button
                type="button"
                className="copilot-context-chip"
                data-active={includeCurrentNote ? "true" : "false"}
                onClick={() => setIncludeCurrentNote((current) => !current)}
              >
                <span>{includeCurrentNote ? t("copilot.context.current") : t("copilot.context.currentOff")}</span>
                <strong translate="no">{noteTitle(props.activeNote)}</strong>
                {props.activeNote.dirty ? <em>{t("copilot.context.dirty")}</em> : null}
              </button>
            ) : null}
            {attachedNotes.map((note) => (
              <span className="copilot-context-chip copilot-context-chip-attached" key={note.path}>
                <button type="button" onClick={() => props.onOpenSource?.(note.path)} disabled={!props.onOpenSource}>
                  <span>{t("copilot.context.attached")}</span>
                  <strong translate="no">{noteTitle(note)}</strong>
                </button>
                <button type="button" className="copilot-context-remove" onClick={() => removeAttachedNote(note.path)} aria-label={t("copilot.context.remove")}>
                  x
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </section>

      <div className="copilot-chat-log" ref={chatLogRef} aria-live="polite">
        {state.messages.length === 0 ? <div className="empty-state">{t("copilot.empty")}</div> : null}
        {state.messages.map((message) => (
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
          </article>
        ))}
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

      <form className="ask-row copilot-input-row" onSubmit={sendMessage}>
        <label className="sr-only" htmlFor="copilot-message">{t("copilot.input")}</label>
        <textarea
          id="copilot-message"
          ref={inputRef}
          value={state.input}
          onChange={(event) => handleInputChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
          onClick={(event) => syncNotePickerFromInput(event.currentTarget)}
          onFocus={(event) => syncNotePickerFromInput(event.currentTarget)}
          onKeyUp={(event) => {
            if (event.key !== "Escape") syncNotePickerFromInput(event.currentTarget);
          }}
          onSelect={(event) => updateNotePicker(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
          placeholder={providerUnavailable ? t("copilot.disabledPlaceholder") : t("copilot.placeholder")}
          rows={3}
          disabled={state.loading || providerUnavailable}
          onKeyDown={(event) => {
            if (event.key === "Escape" && notePicker.open) {
              event.preventDefault();
              setNotePicker({ open: false, query: "", cursor: 0, start: null, category: null });
              return;
            }
            if (event.key === "Enter" && notePicker.open && !event.metaKey && !event.ctrlKey && notePickerOptions[0]) {
              event.preventDefault();
              handlePickerOption(notePickerOptions[0]);
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
        {state.loading ? (
          <button type="button" className="query-button" onClick={stop}>{t("copilot.stop")}</button>
        ) : (
          <button className="primary query-button" type="submit" disabled={!state.input.trim() || providerUnavailable}>
            {t("copilot.send")}
          </button>
        )}
      </form>
      {state.status ? <div className="status-pill qa-query-state">{state.status}</div> : null}
      {state.error ? <div className="error" aria-live="polite">{state.error}</div> : null}

      <section className="citation-grid copilot-citations" aria-label={t("copilot.sources")}>
        {visibleCitations.map((citation, index) => (
          <article className={`${props.compact ? "" : "panel"} citation`} key={`${citation.path}-${index}`}>
            <button className="citation-source" type="button" onClick={() => props.onOpenSource?.(citation.path)} disabled={!props.onOpenSource}>
              <strong translate="no">{citation.title}</strong>
              <span translate="no">{citation.path}</span>
            </button>
          </article>
        ))}
        {state.citations.length > visibleCitations.length ? (
          <div className="copilot-citation-more">{t("copilot.sources.more", { count: state.citations.length - visibleCitations.length })}</div>
        ) : null}
      </section>
    </aside>
  );
});
