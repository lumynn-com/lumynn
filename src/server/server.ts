import fs from "node:fs/promises";
import path from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import staticFiles from "@fastify/static";
import Fastify from "fastify";
import { ZodError } from "zod";
import { registerAuthRoutes } from "./auth/authRoutes";
import { requireAuth } from "./auth/authService";
// Side-effect import: registers the FastifyRequest.user type
// augmentation so handlers can read `request.user`.
import "./auth/fastifyTypes";
import { config } from "./config";
import { assertProductionSecrets } from "./crypto";
import { registerDocumentRoutes } from "./documents/documentRoutes";
import { checkObsidianCli } from "./obsidian/obsidianCli";
import { registerRagRoutes } from "./rag/ragRoutes";
import { registerSettingsRoutes } from "./settings/settingsRoutes";
import { store } from "./store";
import { registerUserRoutes } from "./users/userRoutes";

async function ensureSampleVault(): Promise<void> {
  await fs.mkdir(config.defaultVaultPath, { recursive: true });
  const welcomePath = path.join(config.defaultVaultPath, "Welcome.md");
  const exists = await fs.stat(welcomePath).then(() => true).catch(() => false);
  if (!exists) {
    await fs.writeFile(
      welcomePath,
      [
        "---",
        "title: Welcome",
        "tags: [demo, docs]",
        "---",
        "",
        "# Welcome",
        "",
        "This is a plain-text Markdown vault. Create, edit, preview, delete, and ask questions about notes from the web UI.",
        "",
        "Try linking to [[Project Notes]]."
      ].join("\n"),
      "utf8"
    );
  }
}

export async function buildServer() {
  assertProductionSecrets();
  await ensureSampleVault();
  const data = await store.load();
  const https = data.globalSettings.https;
  const httpsOptions =
    https?.enabled && https.certificate?.trim() && https.privateKey?.trim()
      ? {
          cert: https.certificate,
          key: https.privateKey
        }
      : undefined;

  const app = Fastify({
    logger: true,
    bodyLimit: 1024 * 1024 * 30,
    ...(httpsOptions ? { https: httpsOptions } : {})
  });

  // Accept raw binary uploads (e.g. paste-image-into-editor) as a
  // Buffer rather than the default UTF-8 string parsing.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({ error: "Invalid request", details: error.flatten() });
      return;
    }
    app.log.error(error);
    reply.code(500).send({ error: error instanceof Error ? error.message : "Internal server error" });
  });

  await app.register(cors, {
    origin: true,
    credentials: true
  });
  await app.register(cookie, {
    secret: config.sessionSecret
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api") || request.url.startsWith("/api/auth")) {
      return;
    }
    await requireAuth(request, reply);
  });

  app.get("/api/health", async () => {
    const cli = await checkObsidianCli();
    return { ok: true, obsidianCli: cli };
  });

  await registerAuthRoutes(app);
  await registerUserRoutes(app);
  await registerSettingsRoutes(app);
  await registerDocumentRoutes(app);
  await registerRagRoutes(app);

  const clientDir = path.join(config.rootDir, "dist/client");
  const hasClient = await fs.stat(clientDir).then((stat) => stat.isDirectory()).catch(() => false);
  if (hasClient) {
    await app.register(staticFiles, {
      root: clientDir,
      prefix: "/"
    });
    app.setNotFoundHandler((_request, reply) => {
      reply.sendFile("index.html");
    });
  }

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
}
