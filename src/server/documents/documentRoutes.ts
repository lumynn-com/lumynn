import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { UserRecord } from "../store";
import { backlinksFor, countDocuments, createDocument, createFolder, deleteDocument, deleteFolder, inspectFolder, listDocuments, listDocumentTree, readDocument, readVaultMedia, renameDocument, renameFolder, renderPreview, resolveDocumentLink, searchDocuments, writeAttachment, writeDocument } from "../vault/vaultService";

const sortSchema = z.object({
  sort: z.enum(["name", "createdAt", "updatedAt", "path", "title"]).optional(),
  order: z.enum(["asc", "desc"]).optional()
});

// Helper: every document route requires an authenticated caller.
// The requireAuth preHandler in server.ts decorates request.user
// before any of these handlers run, so this is just a defensive
// type narrow + 401 if the decoration somehow didn't happen.
function authedUser(request: FastifyRequest, reply: FastifyReply): UserRecord | null {
  const user = request.user;
  if (!user) {
    reply.code(401).send({ error: "Authentication required" });
    return null;
  }
  return user;
}

export async function registerDocumentRoutes(app: FastifyInstance): Promise<void> {
  // Lightweight folder/file structure for the document tree.
  // Default is a lazy single-level listing: returns just the
  // requested folder's direct children. Sub-folders are returned
  // as expandable rows without probing inside them; the client
  // expands deeper levels by making additional calls with
  // ?path=<sub-folder>.
  // Pass depth > 1 to override and get a multi-level subtree in
  // one shot.
  app.get("/api/documents/tree", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const query = z
      .object({
        path: z.string().min(1).max(1024).optional(),
        depth: z.coerce.number().int().min(1).max(20).optional(),
        sort: z.enum(["name", "updatedAt"]).optional(),
        order: z.enum(["asc", "desc"]).optional()
      })
      .parse(request.query);
    try {
      return await listDocumentTree(user, {
        folder: query.path,
        depth: query.depth ?? 1,
        sort: query.sort,
        order: query.order
      });
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to list folder" };
    }
  });

  app.get("/api/documents", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const query = sortSchema.parse(request.query);
    let docs;
    try {
      docs = await listDocuments(user, query.sort ?? "name", query.order ?? "asc");
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to list documents" };
    }
    // The tree view only renders path / name / title / dates /
    // hash. Stripping the per-doc tags / aliases / headings arrays
    // before serialization keeps the wire payload small for vaults
    // with thousands of files (where those arrays balloon to many
    // KB per request) without breaking internal callers that go
    // through listDocuments() directly for search and RAG.
    return docs.map((doc) => ({
      path: doc.path,
      name: doc.name,
      title: doc.title,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      hash: doc.hash,
      tags: [],
      aliases: [],
      headings: []
    }));
  });

  app.get("/api/documents/count", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    try {
      return { count: await countDocuments(user) };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to count documents" };
    }
  });

  app.get("/api/documents/resolve-link", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const query = z.object({ target: z.string().min(1).max(1024), base: z.string().min(1).max(1024).optional() }).parse(request.query);
    try {
      return await resolveDocumentLink(user, query.target, query.base);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : "Unable to resolve document link" };
    }
  });

  app.post("/api/documents", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const body = z.object({ path: z.string().min(1), content: z.string().optional() }).parse(request.body);
    try {
      return await createDocument(user, body.path, body.content);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to create document" };
    }
  });

  // Paste-image-into-editor upload. The browser sends raw image bytes
  // as application/octet-stream and passes the MIME type + optional
  // original filename in query params, which is much smaller on the
  // wire than multipart or base64.
  app.post("/api/documents/attachments", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const query = z
      .object({
        type: z.string().min(1).max(80),
        name: z.string().min(1).max(200).optional()
      })
      .parse(request.query);
    if (!(request.body instanceof Buffer)) {
      reply.code(400);
      return { error: "Expected binary body (application/octet-stream)" };
    }
    try {
      return await writeAttachment(user, {
        bytes: request.body,
        mimeType: query.type,
        preferredName: query.name
      });
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to save attachment" };
    }
  });

  app.get("/api/documents/content", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const query = z.object({ path: z.string().min(1) }).parse(request.query);
    try {
      return await readDocument(user, query.path);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : "Document not found" };
    }
  });

  app.get("/api/documents/search", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const query = z.object({ q: z.string().min(1).max(500) }).parse(request.query);
    try {
      return await searchDocuments(user, query.q);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to search documents" };
    }
  });

  app.put("/api/documents/content", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const body = z.object({ path: z.string().min(1), content: z.string(), expectedHash: z.string().optional() }).parse(request.body);
    try {
      return await writeDocument(user, body.path, body.content, body.expectedHash);
    } catch (error) {
      reply.code(error instanceof Error && error.name === "ConflictError" ? 409 : 400);
      return { error: error instanceof Error ? error.message : "Unable to save document" };
    }
  });

  app.delete("/api/documents/content", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const body = z.object({ path: z.string().min(1) }).parse(request.body);
    try {
      await deleteDocument(user, body.path);
      return { ok: true };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to delete document" };
    }
  });

  // Rename or move a single Markdown file. The new path can be in
  // the same directory (rename) or a different directory (move +
  // optionally rename) — same handler.
  app.patch("/api/documents/rename", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const body = z.object({ path: z.string().min(1), nextPath: z.string().min(1) }).parse(request.body);
    try {
      return await renameDocument(user, body.path, body.nextPath);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to rename document" };
    }
  });

  // ---- Folder operations -------------------------------------------

  // Create a new (empty) folder. We drop a hidden .gitkeep
  // placeholder inside so the tree view (which enumerates by
  // .md content) can still see it before the user adds notes.
  app.post("/api/documents/folders", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const body = z.object({ path: z.string().min(1).max(1024) }).parse(request.body);
    try {
      return await createFolder(user, body.path);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to create folder" };
    }
  });

  // Inspect a folder before destructive actions: returns how many
  // .md files live inside (recursively) so the UI can show
  // "About to delete N files" in its confirm dialog.
  app.get("/api/documents/folders/inspect", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const query = z.object({ path: z.string().min(1).max(1024) }).parse(request.query);
    try {
      return await inspectFolder(user, query.path);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to inspect folder" };
    }
  });

  // Rename or move a folder. Atomic at the filesystem level; we
  // also rewrite per-user metadata cache keys for every file
  // that lived under the moved folder so RAG / mtime cache
  // stay consistent.
  app.patch("/api/documents/folders/rename", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const body = z.object({ path: z.string().min(1).max(1024), nextPath: z.string().min(1).max(1024) }).parse(request.body);
    try {
      return await renameFolder(user, body.path, body.nextPath);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to move folder" };
    }
  });

  // Delete a folder. Refuses non-empty folders unless ?recursive=1
  // is passed (the client sets this only after an extra confirm
  // that surfaces the inspect-folder file count).
  app.delete("/api/documents/folders", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const body = z.object({ path: z.string().min(1).max(1024) }).parse(request.body);
    const query = z.object({ recursive: z.coerce.boolean().optional() }).parse(request.query);
    try {
      return await deleteFolder(user, body.path, { recursive: query.recursive ?? false });
    } catch (error) {
      const isNonEmpty = error instanceof Error && error.name === "FolderNotEmpty";
      reply.code(isNonEmpty ? 409 : 400);
      const details = (error as { details?: unknown }).details;
      return {
        error: error instanceof Error ? error.message : "Unable to delete folder",
        ...(details ? { details } : {})
      };
    }
  });

  // Preview rendering is pure; no vault access needed.
  app.post("/api/documents/preview", async (request) => {
    const body = z.object({ content: z.string(), path: z.string().optional() }).parse(request.body);
    return { html: await renderPreview(body.content, body.path) };
  });

  app.get("/api/documents/media", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const query = z.object({ path: z.string().min(1), base: z.string().optional() }).parse(request.query);
    try {
      const media = await readVaultMedia(user, query.path, query.base);
      reply.type(media.contentType);
      return media.data;
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : "Media not found" };
    }
  });

  app.get("/api/documents/backlinks", async (request, reply) => {
    const user = authedUser(request, reply);
    if (!user) return;
    const query = z.object({ path: z.string().min(1) }).parse(request.query);
    return backlinksFor(user, query.path);
  });
}
