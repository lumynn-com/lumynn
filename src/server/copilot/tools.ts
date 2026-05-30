import { randomUUID } from "node:crypto";
import path from "node:path";
import { sha256 } from "../crypto";
import type { UserRecord } from "../store";
import {
  listDocuments,
  listDocumentTree,
  normalizeDocumentPath,
  readDocument,
  resolveDocumentLink,
  searchDocuments
} from "../vault/vaultService";
import { applyEditToContent, createUnifiedDiff } from "./diff";
import { putFileEditProposal } from "./proposals";
import type {
  CopilotCitation,
  CopilotToolContext,
  CopilotToolDefinition,
  CopilotToolResult,
  FileEditProposal,
  JsonSchema
} from "./types";

// Tool names, schemas, and behavioral prompts are adapted from Obsidian Copilot's
// agent tooling, but execution is implemented against this app's Fastify vault service.
const COPILOT_HISTORY_PREFIX = "copilot/";
const READ_NOTE_LINES_PER_CHUNK = 140;
const MAX_SEARCH_RESULTS = 8;
const MAX_TREE_JSON_CHARS = 500_000;

function isCopilotHistoryPath(documentPath: string): boolean {
  return documentPath.toLowerCase().startsWith(COPILOT_HISTORY_PREFIX);
}

function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactSnippet(value: string, fallback: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return (compact || fallback).slice(0, 360);
}

function citationFromDocument(pathName: string, title: string, snippet: string, score?: number, source?: string): CopilotCitation {
  return {
    path: pathName,
    title: title || path.posix.basename(pathName).replace(/\.md$/i, ""),
    snippet: compactSnippet(snippet, pathName),
    ...(score !== undefined ? { score } : {}),
    ...(source ? { source } : {})
  };
}

function tokenize(input: string): string[] {
  const normalized = input.toLowerCase();
  const asciiTokens = normalized.match(/[a-z0-9_#/-]{2,}/g) ?? [];
  const cjkSequences = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? [];
  const cjkTokens = cjkSequences.flatMap((sequence) => {
    if (sequence.length <= 2) return [sequence];
    const grams = [sequence];
    for (let index = 0; index < sequence.length - 1; index += 1) {
      grams.push(sequence.slice(index, index + 2));
    }
    return grams;
  });
  return Array.from(new Set([...asciiTokens, ...cjkTokens])).filter((token) => token.length > 1);
}

function scoreText(query: string, salientTerms: string[], haystack: string): number {
  const lower = haystack.toLowerCase();
  const terms = Array.from(new Set([...tokenize(query), ...salientTerms.map((term) => term.toLowerCase())]));
  if (terms.length === 0) return 1;
  let score = lower.includes(query.toLowerCase()) ? 25 : 0;
  for (const term of terms) {
    if (!term) continue;
    let offset = lower.indexOf(term);
    while (offset !== -1) {
      score += term.startsWith("#") ? 12 : Math.min(8, Math.max(2, term.length / 2));
      offset = lower.indexOf(term, offset + term.length);
    }
  }
  return score;
}

function parseTimeRange(value: unknown): { startTime?: number; endTime?: number } | undefined {
  const input = asRecord(value);
  const startTime = asOptionalNumber(input.startTime);
  const endTime = asOptionalNumber(input.endTime);
  return startTime !== undefined || endTime !== undefined ? { startTime, endTime } : undefined;
}

async function localSearch(args: unknown, context: CopilotToolContext): Promise<CopilotToolResult> {
  const input = asRecord(args);
  const query = asString(input.query).trim();
  const salientTerms = asStringArray(input.salientTerms);
  const timeRange = parseTimeRange(input.timeRange);
  if (!query && salientTerms.length === 0 && !timeRange) {
    return { status: "invalid", message: "localSearch requires a query, salientTerms, or timeRange.", citations: [] };
  }

  const merged = new Map<string, CopilotCitation>();

  if (timeRange) {
    const docs = (await listDocuments(context.user, "updatedAt", "desc")).filter((doc) => !isCopilotHistoryPath(doc.path));
    for (const doc of docs) {
      const updatedMs = Date.parse(doc.updatedAt);
      const createdMs = Date.parse(doc.createdAt);
      const inRange =
        (timeRange.startTime === undefined || updatedMs >= timeRange.startTime || createdMs >= timeRange.startTime) &&
        (timeRange.endTime === undefined || updatedMs <= timeRange.endTime || createdMs <= timeRange.endTime);
      if (!inRange) continue;

      const full = await readDocument(context.user, doc.path).catch(() => null);
      if (!full) continue;
      const haystack = `${full.path}\n${full.title}\n${full.tags.join(" ")}\n${full.aliases.join(" ")}\n${full.content}`;
      const score = scoreText(query, salientTerms, haystack);
      if (query || salientTerms.length > 0) {
        if (score <= 0) continue;
      }
      merged.set(full.path, citationFromDocument(full.path, full.title, full.content, score, "timeRange"));
      if (merged.size >= MAX_SEARCH_RESULTS) break;
    }
  }

  const searchQueries = Array.from(new Set([query, ...salientTerms.filter((term) => term.length >= 2)])).filter(Boolean).slice(0, 6);
  for (const searchQuery of searchQueries) {
    const results = await searchDocuments(context.user, searchQuery).catch(() => []);
    for (const result of results) {
      if (isCopilotHistoryPath(result.path) || merged.has(result.path)) continue;
      const score = scoreText(query || searchQuery, salientTerms, `${result.path}\n${result.title}\n${result.snippet}`);
      merged.set(result.path, citationFromDocument(result.path, result.title, result.snippet, score, result.source));
      if (merged.size >= MAX_SEARCH_RESULTS) break;
    }
    if (merged.size >= MAX_SEARCH_RESULTS) break;
  }

  const citations = Array.from(merged.values()).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return {
    status: "ok",
    query,
    salientTerms,
    timeRange,
    resultCount: citations.length,
    citations,
    results: citations
  };
}

function chunkContentByLines(notePath: string, content: string) {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || content.trim().length === 0) return [];
  const totalChunks = Math.max(1, Math.ceil(lines.length / READ_NOTE_LINES_PER_CHUNK));
  return Array.from({ length: totalChunks }, (_, index) => {
    const start = index * READ_NOTE_LINES_PER_CHUNK;
    const end = Math.min((index + 1) * READ_NOTE_LINES_PER_CHUNK, lines.length);
    const chunkLines = lines.slice(start, end);
    const headingLine = chunkLines.find((line) => /^#+\s+/.test(line.trim()));
    return {
      id: `${notePath}#L${start + 1}-${end}`,
      chunkIndex: index,
      content: chunkLines.join("\n").trimEnd(),
      heading: headingLine ? headingLine.trim().replace(/^#+\s+/, "") : ""
    };
  });
}

async function findReadNoteCandidates(user: UserRecord, requestedPath: string) {
  const normalized = requestedPath.replace(/^\/+/, "").toLowerCase();
  const docs = await listDocuments(user, "path", "asc");
  return docs
    .filter((doc) => !isCopilotHistoryPath(doc.path))
    .filter((doc) => {
      const lowerPath = doc.path.toLowerCase();
      const lowerName = path.posix.basename(doc.path).toLowerCase();
      return lowerPath === normalized || lowerName === normalized || lowerName === `${normalized}.md` || lowerPath.includes(normalized);
    })
    .slice(0, 8)
    .map((doc) => ({ path: doc.path, title: doc.title }));
}

async function linkedNotesFromContent(user: UserRecord, content: string, basePath: string) {
  const matches = Array.from(content.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g));
  const uniqueTargets = Array.from(new Set(matches.map((match) => match[1].trim()).filter(Boolean))).slice(0, 12);
  const linked = await Promise.all(
    uniqueTargets.map(async (target) => {
      const resolved = await resolveDocumentLink(user, target, basePath).catch(() => null);
      return resolved ? { path: resolved.path, title: path.posix.basename(resolved.path).replace(/\.md$/i, "") } : null;
    })
  );
  return linked.filter((item): item is { path: string; title: string } => Boolean(item));
}

function isActiveNoteAlias(notePath: string): boolean {
  return ["current", "active", "this", "current note", "active note", "this note", "当前", "当前笔记", "当前文档", "这篇笔记"].includes(
    notePath.trim().toLowerCase()
  );
}

async function readContextNote(context: CopilotToolContext, chunkIndex: number): Promise<CopilotToolResult | null> {
  const note = context.activeNote;
  if (!note || note.content === undefined) return null;
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return { notePath: note.path, noteTitle: note.title, status: "invalid_chunk", message: "chunkIndex must be a non-negative integer." };
  }

  const chunks = chunkContentByLines(note.path, note.content);
  if (chunks.length === 0) {
    return { notePath: note.path, noteTitle: note.title, status: "empty", message: `No readable content was found in "${note.path}".` };
  }
  if (chunkIndex >= chunks.length) {
    return {
      notePath: note.path,
      noteTitle: note.title,
      status: "out_of_range",
      message: `Chunk index ${chunkIndex} exceeds available chunks (last index ${chunks.length - 1}).`,
      totalChunks: chunks.length
    };
  }

  const chunk = chunks[chunkIndex];
  const hasMore = chunk.chunkIndex < chunks.length - 1;
  const linkedNotes = await linkedNotesFromContent(context.user, chunk.content, note.path);
  return {
    status: "ok",
    notePath: note.path,
    noteTitle: note.title || path.posix.basename(note.path).replace(/\.md$/i, ""),
    heading: chunk.heading,
    chunkId: chunk.id,
    chunkIndex: chunk.chunkIndex,
    totalChunks: chunks.length,
    hasMore,
    nextChunkIndex: hasMore ? chunk.chunkIndex + 1 : null,
    content: chunk.content,
    isCurrent: true,
    isDraft: note.isDraft,
    dirty: note.dirty,
    linkedNotes: linkedNotes.length > 0 ? linkedNotes : undefined,
    citations: [citationFromDocument(note.path, note.title, chunk.content, 1, "activeNote")]
  };
}

async function readNote(args: unknown, context: CopilotToolContext): Promise<CopilotToolResult> {
  const input = asRecord(args);
  let rawPath = asString(input.notePath).trim();
  const chunkIndexValue = input.chunkIndex;
  const chunkIndex =
    typeof chunkIndexValue === "string" && chunkIndexValue.trim()
      ? Number(chunkIndexValue)
      : typeof chunkIndexValue === "number"
        ? chunkIndexValue
        : 0;
  if (!rawPath) {
    return { status: "invalid_path", message: "readNote requires notePath." };
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return { notePath: rawPath, status: "invalid_chunk", message: "chunkIndex must be a non-negative integer." };
  }
  if (isActiveNoteAlias(rawPath) && context.activeNote) {
    const contextResult = await readContextNote(context, chunkIndex);
    if (contextResult) return contextResult;
    rawPath = context.activeNote.path;
  }
  if (rawPath.startsWith("/")) {
    return {
      notePath: rawPath,
      status: "invalid_path",
      message: "Provide the note path relative to the vault root without a leading slash."
    };
  }
  const safePath = normalizeDocumentPath(rawPath);
  const doc = await readDocument(context.user, safePath).catch(() => null);
  if (!doc) {
    const candidates = await findReadNoteCandidates(context.user, rawPath);
    return {
      notePath: rawPath,
      status: candidates.length > 1 ? "not_unique" : "not_found",
      message:
        candidates.length > 1
          ? `Multiple notes match "${rawPath}". Provide a more specific path.`
          : `Note "${rawPath}" was not found or is not a readable file.`,
      ...(candidates.length > 0 ? { candidates } : {})
    };
  }
  if (isCopilotHistoryPath(doc.path)) {
    return { notePath: doc.path, status: "not_found", message: "Copilot conversation history is excluded from agent note reads." };
  }

  const chunks = chunkContentByLines(doc.path, doc.content);
  if (chunks.length === 0) {
    return { notePath: doc.path, status: "empty", message: `No readable content was found in "${doc.path}".` };
  }
  if (chunkIndex >= chunks.length) {
    return {
      notePath: doc.path,
      status: "out_of_range",
      message: `Chunk index ${chunkIndex} exceeds available chunks (last index ${chunks.length - 1}).`,
      totalChunks: chunks.length
    };
  }

  const chunk = chunks[chunkIndex];
  const hasMore = chunk.chunkIndex < chunks.length - 1;
  const linkedNotes = await linkedNotesFromContent(context.user, chunk.content, doc.path);
  const citation = citationFromDocument(doc.path, doc.title, chunk.content, 1, "readNote");

  return {
    status: "ok",
    notePath: doc.path,
    noteTitle: doc.title,
    heading: chunk.heading,
    chunkId: chunk.id,
    chunkIndex: chunk.chunkIndex,
    totalChunks: chunks.length,
    hasMore,
    nextChunkIndex: hasMore ? chunk.chunkIndex + 1 : null,
    content: chunk.content,
    mtime: Date.parse(doc.updatedAt),
    linkedNotes: linkedNotes.length > 0 ? linkedNotes : undefined,
    citations: [citation]
  };
}

function pruneCopilotHistoryFromTree(node: any): any | null {
  if (!node || typeof node !== "object") return null;
  if (typeof node.path === "string" && isCopilotHistoryPath(node.path)) return null;
  const children = Array.isArray(node.children)
    ? node.children.map(pruneCopilotHistoryFromTree).filter(Boolean)
    : undefined;
  if (node.type === "folder" && node.path && children && children.length === 0 && !node.hasChildren) {
    return null;
  }
  return { ...node, ...(children ? { children } : {}) };
}

async function getFileTree(_args: unknown, context: CopilotToolContext): Promise<CopilotToolResult> {
  const tree = pruneCopilotHistoryFromTree(
    await listDocumentTree(context.user, {
      depth: 20,
      sort: "name",
      order: "asc"
    })
  );
  const serialized = JSON.stringify(tree);
  return {
    status: "ok",
    tree: serialized.length > MAX_TREE_JSON_CHARS ? simplifyTree(tree) : tree,
    truncated: serialized.length > MAX_TREE_JSON_CHARS
  };
}

function simplifyTree(node: any): any {
  if (!node || typeof node !== "object") return node;
  if (node.type === "file") {
    return { path: node.path, name: node.name, type: "file" };
  }
  return {
    path: node.path,
    name: node.name,
    type: "folder",
    children: Array.isArray(node.children) ? node.children.map(simplifyTree) : undefined
  };
}

function parseTimezoneOffset(offset: string): number {
  const match = offset.trim().match(/^(?:UTC|GMT)?([-+]?\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) {
    throw new Error(`Invalid timezone offset: ${offset}`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  if (!Number.isFinite(hours) || Math.abs(hours) > 14 || minutes >= 60) {
    throw new Error(`Invalid timezone offset: ${offset}`);
  }
  return hours * 60 + Math.sign(hours || 1) * minutes;
}

function timeInfoFromDate(date: Date, timezoneOffset?: string) {
  const nowMs = date.getTime();
  const offsetMinutes =
    timezoneOffset !== undefined ? parseTimezoneOffset(timezoneOffset) : -date.getTimezoneOffset();
  const shifted = new Date(nowMs + offsetMinutes * 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const zone = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return {
    epoch: nowMs,
    isoString: date.toISOString(),
    userLocaleString: `${shifted.toISOString().replace("T", " ").slice(0, 19)} ${zone}`,
    localDateString: shifted.toISOString().slice(0, 10),
    timezoneOffset: offsetMinutes,
    timezone: zone
  };
}

async function getCurrentTime(args: unknown): Promise<CopilotToolResult> {
  const input = asRecord(args);
  const timezoneOffset = typeof input.timezoneOffset === "string" ? input.timezoneOffset : undefined;
  return { status: "ok", ...timeInfoFromDate(new Date(), timezoneOffset) };
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function rangeResult(start: Date, end: Date) {
  return {
    status: "ok",
    startTime: start.getTime(),
    endTime: end.getTime(),
    startIso: start.toISOString(),
    endIso: end.toISOString()
  };
}

async function getTimeRangeMs(args: unknown): Promise<CopilotToolResult> {
  const input = asRecord(args);
  const expression = asString(input.timeExpression).toLowerCase().replace("@vault", "").trim();
  const now = new Date();
  const today = startOfDay(now);
  if (!expression) {
    return { status: "invalid", error: "timeExpression is required" };
  }
  if (expression === "today" || expression === "this day") {
    return rangeResult(today, endOfDay(now));
  }
  if (expression === "yesterday") {
    const day = addDays(today, -1);
    return rangeResult(day, endOfDay(day));
  }
  const relative = expression.match(/^(last|past|previous|prior)\s+(\d+)\s+(days?|weeks?|months?|years?)$/);
  if (relative) {
    const amount = Number(relative[2]);
    const unit = relative[3].replace(/s$/, "");
    const end = now;
    const start =
      unit === "day"
        ? addDays(today, -amount)
        : unit === "week"
          ? addDays(today, -amount * 7)
          : unit === "month"
            ? addMonths(today, -amount)
            : new Date(today.getFullYear() - amount, today.getMonth(), today.getDate());
    return rangeResult(start, end);
  }
  if (expression === "last week" || expression === "this week") {
    const day = today.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const thisWeekStart = addDays(today, mondayOffset);
    const start = expression === "last week" ? addDays(thisWeekStart, -7) : thisWeekStart;
    const end = expression === "last week" ? endOfDay(addDays(start, 6)) : endOfDay(addDays(thisWeekStart, 6));
    return rangeResult(start, end);
  }
  if (expression === "last month" || expression === "this month") {
    const thisMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const start = expression === "last month" ? new Date(today.getFullYear(), today.getMonth() - 1, 1) : thisMonthStart;
    const end = expression === "last month" ? endOfDay(new Date(today.getFullYear(), today.getMonth(), 0)) : endOfDay(new Date(today.getFullYear(), today.getMonth() + 1, 0));
    return rangeResult(start, end);
  }
  if (expression === "last year" || expression === "this year") {
    const year = expression === "last year" ? today.getFullYear() - 1 : today.getFullYear();
    return rangeResult(new Date(year, 0, 1), endOfDay(new Date(year, 11, 31)));
  }
  const isoDate = expression.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) {
    const day = new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]));
    return rangeResult(startOfDay(day), endOfDay(day));
  }
  return { status: "error", error: `Unable to parse time expression: ${expression}` };
}

function stringifyFileContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content, null, 2);
}

async function createProposal(
  user: UserRecord,
  kind: "writeFile" | "editFile",
  documentPath: string,
  proposedContent: string,
  originalContent: string,
  expectedHash: string | null,
  title: string
): Promise<FileEditProposal> {
  return putFileEditProposal({
    id: randomUUID(),
    username: user.username,
    kind,
    path: normalizeDocumentPath(documentPath),
    title,
    originalContent,
    proposedContent,
    expectedHash,
    diff: createUnifiedDiff(normalizeDocumentPath(documentPath), originalContent, proposedContent),
    createdAt: new Date().toISOString(),
    status: "pending"
  });
}

async function writeFile(args: unknown, context: CopilotToolContext): Promise<CopilotToolResult> {
  const input = asRecord(args);
  const rawPath = asString(input.path).trim();
  if (!rawPath) {
    return { status: "invalid_path", message: "writeFile requires path." };
  }
  const documentPath = normalizeDocumentPath(rawPath);
  const proposedContent = stringifyFileContent(input.content ?? "");
  const existing = await readDocument(context.user, documentPath).catch(() => null);
  const originalContent = existing?.content ?? "";
  const expectedHash = existing ? sha256(existing.content) : null;
  const proposal = await createProposal(
    context.user,
    "writeFile",
    documentPath,
    proposedContent,
    originalContent,
    expectedHash,
    existing ? `Rewrite ${documentPath}` : `Create ${documentPath}`
  );
  return {
    status: "pending_confirmation",
    message: `Prepared a file change proposal for ${documentPath}. It has not been applied.`,
    proposal
  };
}

async function editFile(args: unknown, context: CopilotToolContext): Promise<CopilotToolResult> {
  const input = asRecord(args);
  const rawPath = asString(input.path).trim();
  const oldText = asString(input.oldText);
  const newText = asString(input.newText);
  if (!rawPath) {
    return { status: "invalid_path", message: "editFile requires path." };
  }
  const documentPath = normalizeDocumentPath(rawPath);
  const existing = await readDocument(context.user, documentPath).catch(() => null);
  if (!existing) {
    return { status: "not_found", message: `File not found at path: ${documentPath}.` };
  }
  const editResult = applyEditToContent(existing.content, oldText, newText);
  if (!editResult.ok) {
    return editResult.reason === "NOT_FOUND"
      ? {
          status: "not_found",
          message: `Could not find the specified text in ${documentPath}. Include more surrounding context.`
        }
      : {
          status: "ambiguous",
          message: `Found ${editResult.occurrences} occurrences of the search text in ${documentPath}. Make oldText unique.`
        };
  }
  if (editResult.content === existing.content) {
    return { status: "no_change", message: `No changes made to ${documentPath}; replacement produced identical content.` };
  }
  const proposal = await createProposal(
    context.user,
    "editFile",
    documentPath,
    editResult.content,
    existing.content,
    sha256(existing.content),
    `Edit ${documentPath}`
  );
  return {
    status: "pending_confirmation",
    message: `Prepared a targeted edit proposal for ${documentPath}. It has not been applied.`,
    proposal
  };
}

export function createCopilotToolRegistry(): CopilotToolDefinition[] {
  return [
    {
      name: "localSearch",
      description: "Search the user's Markdown vault. Excludes Copilot conversation history by default.",
      parameters: objectSchema(
        {
          query: { type: "string", description: "The search query to find relevant notes." },
          salientTerms: {
            type: "array",
            items: { type: "string" },
            description: "Important keywords extracted from the user's original query. Preserve original language and #tags."
          },
          timeRange: objectSchema({
            startTime: { type: "number", description: "Start time as epoch milliseconds." },
            endTime: { type: "number", description: "End time as epoch milliseconds." }
          })
        },
        ["query", "salientTerms"]
      ),
      execute: localSearch
    },
    {
      name: "readNote",
      description: "Read a specific note by vault-relative path in chunks. Use when the exact note content is needed.",
      parameters: objectSchema(
        {
          notePath: { type: "string", description: "Vault-relative note path, such as 'Projects/plan.md'." },
          chunkIndex: { type: "number", minimum: 0, description: "0-based chunk index. Omit or use 0 for the first chunk." }
        },
        ["notePath"]
      ),
      execute: readNote
    },
    {
      name: "getFileTree",
      description: "Get the vault file tree so exact note and folder paths can be chosen.",
      parameters: objectSchema({}),
      execute: getFileTree
    },
    {
      name: "writeFile",
      description: "Prepare a proposal to create or rewrite a Markdown file. The proposal is not applied until the user clicks Apply.",
      parameters: objectSchema(
        {
          path: { type: "string", description: "Vault-relative file path." },
          content: {
            type: "string",
            description: "Complete intended file content. Never omit unchanged sections for rewrites."
          }
        },
        ["path", "content"]
      ),
      execute: writeFile
    },
    {
      name: "editFile",
      description: "Prepare a targeted single-match edit proposal for an existing Markdown file.",
      parameters: objectSchema(
        {
          path: { type: "string", description: "Vault-relative file path." },
          oldText: { type: "string", description: "Exact text to replace. Include enough surrounding lines to make it unique." },
          newText: { type: "string", description: "Replacement text. Can be an empty string to delete oldText." }
        },
        ["path", "oldText", "newText"]
      ),
      execute: editFile
    },
    {
      name: "getCurrentTime",
      description: "Get the current server time, optionally at a numeric UTC offset.",
      parameters: objectSchema({
        timezoneOffset: {
          type: "string",
          description: "Optional numeric UTC offset such as '+8', '-5', '+05:30', 'UTC+9'."
        }
      }),
      execute: getCurrentTime
    },
    {
      name: "getTimeRangeMs",
      description: "Convert simple natural-language time expressions to start/end epoch millisecond ranges for localSearch.",
      parameters: objectSchema(
        {
          timeExpression: { type: "string", description: "Time expression, such as 'yesterday', 'last week', 'past 30 days', or '2026-05-29'." }
        },
        ["timeExpression"]
      ),
      execute: getTimeRangeMs
    }
  ];
}
