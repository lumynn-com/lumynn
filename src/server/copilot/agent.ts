import { endpointUrl } from "../rag/embeddingProvider";
import type { UserRecord } from "../store";
import type { ProviderSettings } from "../../shared/types";
import { createCopilotToolRegistry } from "./tools";
import type { CopilotChatMessage, CopilotEventSink, CopilotNoteContext, CopilotToolDefinition, CopilotToolResult } from "./types";

type FetchLike = typeof fetch;

interface ProviderToolCall {
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ProviderToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface RunAgentOptions {
  user: UserRecord;
  messages: CopilotChatMessage[];
  emit: CopilotEventSink;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  activeNote?: CopilotNoteContext;
  referencedNotes?: CopilotNoteContext[];
}

const MAX_CONTEXT_NOTES = 6;
const MAX_ACTIVE_NOTE_CONTEXT_CHARS = 16_000;
const MAX_REFERENCED_NOTE_CONTEXT_CHARS = 10_000;

export function getCopilotProviderStatus(user: UserRecord): { ok: boolean; toolsAvailable: boolean; reason?: string } {
  const settings = user.rag.qa;
  if (settings.provider === "disabled") {
    return {
      ok: false,
      toolsAvailable: false,
      reason: "Q&A provider is disabled. Configure an OpenAI-compatible chat-completions provider to use agent chat."
    };
  }
  if (settings.provider !== "openai-compatible") {
    return {
      ok: false,
      toolsAvailable: false,
      reason: "Agent chat requires an OpenAI-compatible provider."
    };
  }
  const endpointPath = settings.endpointPath ?? "/chat/completions";
  const isChatCompletionsEndpoint = endpointPath === "/chat/completions" || endpointPath.endsWith("/chat/completions");
  if ((settings.apiMode ?? "chat-completions") !== "chat-completions" || !isChatCompletionsEndpoint) {
    return {
      ok: false,
      toolsAvailable: false,
      reason: "Agent tools require the provider API mode to be Chat Completions."
    };
  }
  if (!settings.baseUrl || !settings.model) {
    return {
      ok: false,
      toolsAvailable: false,
      reason: "Q&A provider base URL and model are required."
    };
  }
  return { ok: true, toolsAvailable: true };
}

function systemPrompt(): string {
  return [
    "You are a Copilot-style agent for a Markdown library.",
    "Use tools when the answer requires library search, note reads, file tree context, current time, or file edits.",
    "When an active_note context is present, treat phrases like 'current note', 'active note', 'this note', and '当前笔记' as that note.",
    "When note_context blocks are present, use those referenced notes before searching again. You may still call readNote for later chunks or localSearch for missing context.",
    "Never claim a file was changed after writeFile or editFile. Those tools only create proposals; the user must click Apply.",
    "Cite note paths naturally when using localSearch or readNote results.",
    "If tool results are insufficient, say what is missing instead of inventing details.",
    "",
    "Tool guidance:",
    "- localSearch: provide query and salientTerms extracted from the user's words. Use getTimeRangeMs first for time-based library searches.",
    "- readNote: use only when you know or can infer the note path. Start with chunk 0 and request later chunks only if needed.",
    "- getFileTree: use to discover exact paths for notes or folders, not to read contents.",
    "- writeFile: provide complete target content. This creates a pending proposal only.",
    "- editFile: use for targeted single-match edits with enough oldText context to be unique."
  ].join("\n");
}

function truncateContext(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n\n[Context truncated: ${value.length - limit} additional characters omitted.]`;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatNoteContext(note: CopilotNoteContext, tagName: "active_note" | "note_context", limit: number): string {
  const attrs = [
    `path="${escapeXmlAttribute(note.path)}"`,
    `title="${escapeXmlAttribute(note.title || note.path)}"`,
    ...(note.hash ? [`hash="${escapeXmlAttribute(note.hash)}"`] : []),
    ...(note.isDraft ? ['draft="true"'] : []),
    ...(note.dirty ? ['dirty="true"'] : [])
  ];
  const header = `<${tagName} ${attrs.join(" ")}>`;
  const content = note.content !== undefined ? truncateContext(note.content, limit) : "[Content not preloaded. Use readNote with this path if content is needed.]";
  return `${header}\n${content}\n</${tagName}>`;
}

function dedupeReferencedNotes(activeNote: CopilotNoteContext | undefined, referencedNotes: CopilotNoteContext[] = []): CopilotNoteContext[] {
  const seen = new Set<string>();
  if (activeNote?.path) {
    seen.add(activeNote.path.toLowerCase());
  }
  const deduped: CopilotNoteContext[] = [];
  for (const note of referencedNotes) {
    const key = note.path.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(note);
    if (deduped.length >= MAX_CONTEXT_NOTES) break;
  }
  return deduped;
}

function contextPrompt(activeNote?: CopilotNoteContext, referencedNotes: CopilotNoteContext[] = []): ProviderMessage | null {
  const notes = dedupeReferencedNotes(activeNote, referencedNotes);
  if (!activeNote && notes.length === 0) return null;

  const sections = [
    "The user attached library note context for the latest chat request.",
    "Prefer this context when it answers the request, and cite the attached note paths when you rely on them.",
    activeNote ? formatNoteContext(activeNote, "active_note", MAX_ACTIVE_NOTE_CONTEXT_CHARS) : "",
    ...notes.map((note) => formatNoteContext(note, "note_context", MAX_REFERENCED_NOTE_CONTEXT_CHARS))
  ].filter(Boolean);
  return { role: "system", content: sections.join("\n\n") };
}

function toProviderMessages(messages: CopilotChatMessage[], activeNote?: CopilotNoteContext, referencedNotes?: CopilotNoteContext[]): ProviderMessage[] {
  const contextMessage = contextPrompt(activeNote, referencedNotes);
  return [
    { role: "system", content: systemPrompt() },
    ...(contextMessage ? [contextMessage] : []),
    ...messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({
        role: message.role,
        content: message.content
      }) satisfies ProviderMessage)
  ];
}

function toOpenAiTool(tool: CopilotToolDefinition) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  };
}

function parseToolArguments(raw: string | undefined): unknown {
  if (!raw?.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function compactToolResult(result: CopilotToolResult): string {
  const json = JSON.stringify(result);
  if (json.length <= 12_000) return json;
  return `${json.slice(0, 12_000)}\n...truncated...`;
}

async function callChatCompletions(settings: ProviderSettings, messages: ProviderMessage[], tools: CopilotToolDefinition[], signal?: AbortSignal, fetchImpl: FetchLike = fetch) {
  const toolPayload =
    tools.length > 0
      ? {
          tools: tools.map(toOpenAiTool),
          tool_choice: "auto"
        }
      : {};
  const response = await fetchImpl(endpointUrl(settings, "/chat/completions"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey ?? ""}`
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.2,
      messages,
      ...toolPayload,
      max_tokens: 1200
    }),
    signal: signal ?? AbortSignal.timeout(settings.timeoutMs || 30_000)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Copilot provider failed with HTTP ${response.status}`);
  }
  const message = payload?.choices?.[0]?.message;
  if (!message) {
    throw new Error("Copilot provider returned no message");
  }
  return message as { content?: string | null; tool_calls?: ProviderToolCall[] };
}

async function finalizeWithoutTools(options: RunAgentOptions, providerMessages: ProviderMessage[]): Promise<string> {
  await options.emit({ type: "status", message: "Finalizing with available tool results" });
  const finalMessages: ProviderMessage[] = [
    ...providerMessages,
    {
      role: "user",
      content: [
        "Stop using tools now.",
        "Use only the tool results already provided to answer the user's latest request.",
        "If the available results are insufficient, say exactly what is missing."
      ].join(" ")
    }
  ];
  const finalMessage = await callChatCompletions(
    options.user.rag.qa,
    finalMessages,
    [],
    options.signal,
    options.fetchImpl
  );
  const finalText = finalMessage.content?.trim();
  if (!finalText) {
    throw new Error("The agent reached the tool-iteration limit and the provider did not return a final answer.");
  }
  await emitText(finalText, options.emit);
  await options.emit({ type: "done" });
  return finalText;
}

async function emitText(text: string, emit: CopilotEventSink): Promise<void> {
  const chunks = text.match(/.{1,96}(\s|$)/gs) ?? [text];
  for (const chunk of chunks) {
    if (chunk) {
      await emit({ type: "message_delta", text: chunk });
    }
  }
}

async function runDisabledFallback(messages: CopilotChatMessage[], emit: CopilotEventSink, reason: string): Promise<string> {
  const lastUser = [...messages].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
  const text = lastUser
    ? `${reason}\n\nI cannot run the agent tool loop right now. Configure the provider, then ask again.`
    : reason;
  await emitText(text, emit);
  return text;
}

export async function runCopilotAgent(options: RunAgentOptions): Promise<string> {
  const status = getCopilotProviderStatus(options.user);
  if (!status.ok) {
    await options.emit({ type: "status", message: status.reason ?? "Copilot provider is unavailable." });
    const answer = await runDisabledFallback(options.messages, options.emit, status.reason ?? "Copilot provider is unavailable.");
    await options.emit({ type: "done" });
    return answer;
  }

  const tools = createCopilotToolRegistry();
  const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
  const providerMessages = toProviderMessages(options.messages, options.activeNote, options.referencedNotes);
  const maxIterations = 8;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (options.signal?.aborted) {
      throw new Error("Copilot request aborted");
    }
    await options.emit({ type: "status", message: iteration === 0 ? "Thinking" : "Continuing with tool results" });
    const assistantMessage = await callChatCompletions(
      options.user.rag.qa,
      providerMessages,
      tools,
      options.signal,
      options.fetchImpl
    );
    const toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
    if (toolCalls.length === 0) {
      const finalText = assistantMessage.content?.trim() || "I could not produce a final answer.";
      await emitText(finalText, options.emit);
      await options.emit({ type: "done" });
      return finalText;
    }

    providerMessages.push({
      role: "assistant",
      content: assistantMessage.content ?? null,
      tool_calls: toolCalls
    });

    for (const toolCall of toolCalls) {
      const name = toolCall.function?.name ?? "";
      const id = toolCall.id || `tool-${iteration}-${providerMessages.length}`;
      const args = parseToolArguments(toolCall.function?.arguments);
      await options.emit({ type: "tool_call", id, name, args });
      const tool = toolByName.get(name);
      const result = tool
        ? await tool.execute(args, {
            user: options.user,
            signal: options.signal,
            activeNote: options.activeNote,
            referencedNotes: options.referencedNotes
          })
        : ({ status: "unknown_tool", message: `Unknown tool: ${name}` } satisfies CopilotToolResult);

      await options.emit({ type: "tool_result", id, name, result });
      for (const citation of result.citations ?? []) {
        await options.emit({ type: "citation", citation });
      }
      if (result.proposal) {
        await options.emit({ type: "edit_proposal", proposal: result.proposal });
      }
      providerMessages.push({
        role: "tool",
        tool_call_id: id,
        name,
        content: compactToolResult(result)
      });
    }
  }

  return finalizeWithoutTools(options, providerMessages);
}
