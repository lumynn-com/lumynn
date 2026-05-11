import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { backlinksFor, createDocument, deleteDocument, listDocuments, listDocumentTree, readDocument, readVaultMedia, renameDocument, renderPreview, searchDocuments, writeAttachment, writeDocument } from "../vault/vaultService";

const sortSchema = z.object({
  sort: z.enum(["name", "createdAt", "updatedAt", "path", "title"]).optional(),
  order: z.enum(["asc", "desc"]).optional()
});

export async function registerDocumentRoutes(app: FastifyInstance): Promise<void> {
  // Lightweight folder/file structure for the document tree.
  // Walks the disk once and returns just basenames + paths so the
  // sidebar can render instantly on large vaults. Metadata-aware
  // listing (mtime, title, hash) stays on /api/documents.
  app.get("/api/documents/tree", async () => {
    return listDocumentTree();
  });

  app.get("/api/documents", async (request) => {
    const query = sortSchema.parse(request.query);
    const docs = await listDocuments(query.sort ?? "name", query.order ?? "asc");
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

  app.post("/api/documents", async (request, reply) => {
    const body = z.object({ path: z.string().min(1), content: z.string().optional() }).parse(request.body);
    try {
      return await createDocument(body.path, body.content);
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
      return await writeAttachment({
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
    const query = z.object({ path: z.string().min(1) }).parse(request.query);
    try {
      return await readDocument(query.path);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : "Document not found" };
    }
  });

  app.get("/api/documents/search", async (request, reply) => {
    const query = z.object({ q: z.string().min(1).max(500) }).parse(request.query);
    try {
      return await searchDocuments(query.q);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to search documents" };
    }
  });

  app.put("/api/documents/content", async (request, reply) => {
    const body = z.object({ path: z.string().min(1), content: z.string(), expectedHash: z.string().optional() }).parse(request.body);
    try {
      return await writeDocument(body.path, body.content, body.expectedHash);
    } catch (error) {
      reply.code(error instanceof Error && error.name === "ConflictError" ? 409 : 400);
      return { error: error instanceof Error ? error.message : "Unable to save document" };
    }
  });

  app.delete("/api/documents/content", async (request, reply) => {
    const body = z.object({ path: z.string().min(1) }).parse(request.body);
    try {
      await deleteDocument(body.path);
      return { ok: true };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to delete document" };
    }
  });

  app.patch("/api/documents/rename", async (request, reply) => {
    const body = z.object({ path: z.string().min(1), nextPath: z.string().min(1) }).parse(request.body);
    try {
      return await renameDocument(body.path, body.nextPath);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Unable to rename document" };
    }
  });

  app.post("/api/documents/preview", async (request) => {
    const body = z.object({ content: z.string(), path: z.string().optional() }).parse(request.body);
    return { html: await renderPreview(body.content, body.path) };
  });

  app.get("/api/documents/media", async (request, reply) => {
    const query = z.object({ path: z.string().min(1), base: z.string().optional() }).parse(request.query);
    try {
      const media = await readVaultMedia(query.path, query.base);
      reply.type(media.contentType);
      return media.data;
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : "Media not found" };
    }
  });

  app.get("/api/documents/backlinks", async (request) => {
    const query = z.object({ path: z.string().min(1) }).parse(request.query);
    return backlinksFor(query.path);
  });
}
