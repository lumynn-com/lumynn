import path from "node:path";
import { randomUUID } from "node:crypto";
import type { UserRecord } from "../store";
import { deleteDocument, listDocuments, normalizeDocumentPath, readDocument, writeDocument } from "../vault/vaultService";
import type { CopilotChatMessage, CopilotConversation } from "./types";

export const COPILOT_CONVERSATION_FOLDER = "copilot/copilot-conversations";
const DATA_MARKER = "owd-copilot-conversation";

function nowIso(): string {
  return new Date().toISOString();
}

function encodeData(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeData<T>(encoded: string): T | null {
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function safeFilenameSegment(input: string): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|#\[\]\n\r\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
  return cleaned || "copilot-chat";
}

function deriveTitle(messages: Array<Pick<CopilotChatMessage, "role" | "content">>): string {
  const firstUser = messages.find((message) => message.role === "user" && message.content.trim());
  const title = firstUser?.content.replace(/\s+/g, " ").trim().slice(0, 80);
  return title || "Copilot chat";
}

function escapeYamlString(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatMessageForMarkdown(message: CopilotChatMessage): string {
  const label = message.role === "user" ? "User" : "Assistant";
  const timestamp = message.createdAt ? ` _${message.createdAt}_` : "";
  const sources =
    message.role === "assistant" && message.citations?.length
      ? [
          "",
          "Sources:",
          ...message.citations.map((citation) => `- [[${citation.path}|${citation.title || citation.path}]]`)
        ]
      : [];
  return [`## ${label}${timestamp}`, "", message.content.trim() || "_No content_", ...sources, ""].join("\n");
}

export function serializeConversation(conversation: CopilotConversation): string {
  const data = {
    schemaVersion: 1,
    conversation
  };
  return [
    "---",
    "owdType: copilot-conversation",
    "schemaVersion: 1",
    `conversationId: "${escapeYamlString(conversation.id)}"`,
    `title: "${escapeYamlString(conversation.title)}"`,
    `createdAt: "${conversation.createdAt}"`,
    `updatedAt: "${conversation.updatedAt}"`,
    "---",
    "",
    `# ${conversation.title}`,
    "",
    `<!-- ${DATA_MARKER}:${encodeData(data)} -->`,
    "",
    ...conversation.messages.map(formatMessageForMarkdown)
  ].join("\n");
}

export function parseConversationMarkdown(content: string, fallbackPath?: string): CopilotConversation | null {
  const match = content.match(new RegExp(`<!--\\s*${DATA_MARKER}:([A-Za-z0-9_-]+)\\s*-->`));
  if (!match) {
    return null;
  }
  const decoded = decodeData<{ schemaVersion: number; conversation: CopilotConversation }>(match[1]);
  if (!decoded?.conversation || decoded.schemaVersion !== 1) {
    return null;
  }
  return {
    ...decoded.conversation,
    ...(fallbackPath ? { path: fallbackPath } : {})
  };
}

type ConversationInputMessage = Omit<CopilotChatMessage, "id" | "createdAt"> & Partial<Pick<CopilotChatMessage, "id" | "createdAt">>;
type ConversationSaveInput = Partial<Omit<CopilotConversation, "messages">> & { messages: ConversationInputMessage[] };
type ConversationListItem = Pick<CopilotConversation, "id" | "title" | "createdAt" | "updatedAt" | "path">;

async function findConversationPath(user: UserRecord, id: string): Promise<string | null> {
  const docs = await listDocuments(user, "updatedAt", "desc").catch(() => []);
  for (const doc of docs) {
    if (!doc.path.startsWith(`${COPILOT_CONVERSATION_FOLDER}/`)) continue;
    const full = await readDocument(user, doc.path).catch(() => null);
    if (!full) continue;
    const conversation = parseConversationMarkdown(full.content, full.path);
    if (conversation?.id === id) {
      return full.path;
    }
  }
  return null;
}

export async function saveConversation(user: UserRecord, input: ConversationSaveInput): Promise<CopilotConversation> {
  const now = nowIso();
  const id = input.id?.trim() || randomUUID();
  const createdAt = input.createdAt || input.messages[0]?.createdAt || now;
  const title = (input.title?.trim() || deriveTitle(input.messages)).slice(0, 120);
  const existingPath = input.path?.startsWith(`${COPILOT_CONVERSATION_FOLDER}/`)
    ? normalizeDocumentPath(input.path)
    : await findConversationPath(user, id);
  const targetPath =
    existingPath ?? `${COPILOT_CONVERSATION_FOLDER}/${safeFilenameSegment(title)}-${Date.parse(createdAt) || Date.now()}.md`;
  const conversation: CopilotConversation = {
    id,
    title,
    messages: input.messages.map((message) => ({
      ...message,
      id: message.id || randomUUID(),
      createdAt: message.createdAt || now
    })),
    createdAt,
    updatedAt: now,
    path: targetPath
  };
  await writeDocument(user, targetPath, serializeConversation(conversation));
  return conversation;
}

export async function loadConversation(user: UserRecord, conversationIdOrPath: string): Promise<CopilotConversation> {
  const requestedPath = conversationIdOrPath.includes("/") ? normalizeDocumentPath(conversationIdOrPath) : null;
  const targetPath = requestedPath ?? (await findConversationPath(user, conversationIdOrPath));
  if (!targetPath) {
    throw new Error("Conversation not found");
  }
  const full = await readDocument(user, targetPath);
  const conversation = parseConversationMarkdown(full.content, full.path);
  if (!conversation) {
    throw new Error("Conversation file does not contain Copilot metadata");
  }
  return conversation;
}

export async function deleteConversation(user: UserRecord, conversationIdOrPath: string): Promise<{ ok: true; path: string }> {
  const requestedPath = conversationIdOrPath.includes("/") ? normalizeDocumentPath(conversationIdOrPath) : null;
  const targetPath = requestedPath ?? (await findConversationPath(user, conversationIdOrPath));
  if (!targetPath || !targetPath.startsWith(`${COPILOT_CONVERSATION_FOLDER}/`)) {
    throw new Error("Conversation not found");
  }
  await deleteDocument(user, targetPath);
  return { ok: true, path: targetPath };
}

export async function listConversations(user: UserRecord): Promise<ConversationListItem[]> {
  const docs = await listDocuments(user, "updatedAt", "desc").catch(() => []);
  const conversations: Array<ConversationListItem | null> = await Promise.all(
    docs
      .filter((doc) => doc.path.startsWith(`${COPILOT_CONVERSATION_FOLDER}/`))
      .map(async (doc) => {
        const full = await readDocument(user, doc.path).catch(() => null);
        if (!full) return null;
        const conversation = parseConversationMarkdown(full.content, full.path);
        if (!conversation) return null;
        return {
          id: conversation.id,
          title: conversation.title,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          path: conversation.path ?? doc.path
        };
      })
  );
  return conversations
    .filter((item): item is ConversationListItem => item !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function defaultConversationTitleFromPath(filePath: string): string {
  return path.posix.basename(filePath, ".md").replace(/-\d+$/, "").replace(/[-_]+/g, " ");
}
