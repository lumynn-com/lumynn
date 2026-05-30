import type { UserRecord } from "../store";

export type CopilotChatRole = "user" | "assistant";

export interface CopilotChatMessage {
  id: string;
  role: CopilotChatRole;
  content: string;
  createdAt?: string;
  citations?: CopilotCitation[];
}

export interface CopilotConversation {
  id: string;
  title: string;
  messages: CopilotChatMessage[];
  createdAt: string;
  updatedAt: string;
  path?: string;
}

export interface CopilotCitation {
  path: string;
  title: string;
  snippet: string;
  score?: number;
  source?: string;
}

export interface CopilotNoteContext {
  path: string;
  title: string;
  content?: string;
  hash?: string;
  isCurrent?: boolean;
  isDraft?: boolean;
  dirty?: boolean;
}

export type FileEditProposalStatus = "pending" | "applied" | "rejected" | "conflict";
export type FileEditProposalKind = "writeFile" | "editFile";

export interface FileEditProposal {
  id: string;
  username: string;
  kind: FileEditProposalKind;
  path: string;
  title: string;
  originalContent: string;
  proposedContent: string;
  expectedHash: string | null;
  diff: string;
  createdAt: string;
  status: FileEditProposalStatus;
  message?: string;
}

export interface CopilotToolResult {
  status?: string;
  message?: string;
  citations?: CopilotCitation[];
  proposal?: FileEditProposal;
  [key: string]: unknown;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  additionalProperties?: boolean;
  enum?: string[];
  description?: string;
  minimum?: number;
  maximum?: number;
}

export interface CopilotToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (args: unknown, context: CopilotToolContext) => Promise<CopilotToolResult>;
}

export interface CopilotToolContext {
  user: UserRecord;
  signal?: AbortSignal;
  activeNote?: CopilotNoteContext;
  referencedNotes?: CopilotNoteContext[];
}

export type CopilotStreamEvent =
  | { type: "status"; message: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; result: CopilotToolResult }
  | { type: "citation"; citation: CopilotCitation }
  | { type: "edit_proposal"; proposal: FileEditProposal }
  | { type: "message_delta"; text: string }
  | { type: "done"; conversationId?: string }
  | { type: "error"; message: string };

export type CopilotEventSink = (event: CopilotStreamEvent) => void | Promise<void>;
