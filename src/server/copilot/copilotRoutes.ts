import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { UserRecord } from "../store";
import { readDocument } from "../vault/vaultService";
import { getCopilotProviderStatus, runCopilotAgent } from "./agent";
import { applyFileEditProposal, rejectFileEditProposal } from "./proposals";
import { deleteConversation, listConversations, loadConversation, saveConversation } from "./conversations";
import type { CopilotNoteContext, CopilotStreamEvent } from "./types";

function authedUser(request: FastifyRequest, reply: FastifyReply): UserRecord | null {
  const user = request.user;
  if (!user) {
    reply.code(401).send({ error: "Authentication required" });
    return null;
  }
  return user;
}

const citationSchema = z.object({
  path: z.string(),
  title: z.string(),
  snippet: z.string(),
  score: z.number().optional(),
  source: z.string().optional()
});

const messageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string().optional(),
  citations: z.array(citationSchema).optional()
});

const conversationSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  path: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  messages: z.array(messageSchema)
});

const noteContextSchema = z.object({
  path: z.string().min(1).max(1024),
  title: z.string().max(512).optional(),
  content: z.string().max(500_000).optional(),
  hash: z.string().max(256).optional(),
  isCurrent: z.boolean().optional(),
  isDraft: z.boolean().optional(),
  dirty: z.boolean().optional()
});

function writeSse(reply: FastifyReply, event: CopilotStreamEvent): void {
  reply.raw.write(`event: ${event.type}\n`);
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function hydrateNoteContext(user: UserRecord, note: z.infer<typeof noteContextSchema>): Promise<CopilotNoteContext> {
  if (note.content !== undefined) {
    return {
      path: note.path,
      title: note.title || note.path,
      content: note.content,
      hash: note.hash,
      isCurrent: note.isCurrent,
      isDraft: note.isDraft,
      dirty: note.dirty
    };
  }

  const doc = await readDocument(user, note.path).catch(() => null);
  if (!doc) {
    return {
      path: note.path,
      title: note.title || note.path,
      hash: note.hash,
      isCurrent: note.isCurrent,
      isDraft: note.isDraft,
      dirty: note.dirty
    };
  }

  return {
    path: doc.path,
    title: doc.title || note.title || doc.path,
    content: doc.content,
    hash: doc.hash,
    isCurrent: note.isCurrent,
    isDraft: note.isDraft,
    dirty: note.dirty
  };
}

export async function registerCopilotRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/copilot/status", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    return getCopilotProviderStatus(user);
  });

  app.post("/api/copilot/chat/stream", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const body = z
      .object({
        conversationId: z.string().optional(),
        messages: z.array(messageSchema).min(1),
        activeNote: noteContextSchema.optional(),
        referencedNotes: z.array(noteContextSchema).max(12).optional().default([])
      })
      .parse(request.body);

    const activeNote = body.activeNote
      ? await hydrateNoteContext(user, { ...body.activeNote, isCurrent: true })
      : undefined;
    const referencedNotes = await Promise.all(
      body.referencedNotes.slice(0, 6).map((note) => hydrateNoteContext(user, note))
    );

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });

    const controller = new AbortController();
    const closeHandler = () => controller.abort();
    request.raw.on("close", closeHandler);
    try {
      await runCopilotAgent({
        user,
        messages: body.messages.map((message) => ({
          ...message,
          id: message.id || randomUUID(),
          createdAt: message.createdAt || new Date().toISOString()
        })),
        activeNote,
        referencedNotes,
        signal: controller.signal,
        emit: (event) => {
          if (!reply.raw.destroyed) {
            writeSse(reply, event);
          }
        }
      });
    } catch (error) {
      if (!reply.raw.destroyed && !controller.signal.aborted) {
        writeSse(reply, { type: "error", message: error instanceof Error ? error.message : "Copilot request failed" });
      }
    } finally {
      request.raw.off("close", closeHandler);
      if (!reply.raw.destroyed) {
        reply.raw.end();
      }
    }
  });

  app.get("/api/copilot/conversations", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    return { conversations: await listConversations(user) };
  });

  app.get("/api/copilot/conversations/:id", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      return await loadConversation(user, params.id);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : "Conversation not found" };
    }
  });

  app.post("/api/copilot/conversations", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const body = conversationSchema.parse(request.body);
    return saveConversation(user, body);
  });

  app.delete("/api/copilot/conversations/:id", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      return await deleteConversation(user, params.id);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : "Conversation not found" };
    }
  });

  app.post("/api/copilot/file-edits/:id/apply", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      return await applyFileEditProposal(user, params.id);
    } catch (error) {
      reply.code(error instanceof Error && error.name === "ConflictError" ? 409 : error instanceof Error && error.name === "NotFound" ? 404 : 400);
      return { error: error instanceof Error ? error.message : "Unable to apply file edit proposal" };
    }
  });

  app.delete("/api/copilot/file-edits/:id", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const proposal = rejectFileEditProposal(user.username, params.id);
    if (!proposal) {
      reply.code(404);
      return { error: "File edit proposal not found" };
    }
    return proposal;
  });
}
