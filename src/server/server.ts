import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import staticFiles from "@fastify/static";
import Fastify, { type FastifyReply } from "fastify";
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

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const STATIC_COMPRESS_MIN_BYTES = 1024;
const STATIC_IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const STATIC_NO_CACHE = "no-cache";
const STATIC_SHORT_CACHE = "public, max-age=86400";
const COMPRESSIBLE_STATIC_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".svg",
  ".txt",
  ".webmanifest",
  ".xml"
]);
type StaticHeaderResponse = {
  getHeader: (name: string) => number | string | string[] | undefined;
  setHeader: (name: string, value: number | string | string[]) => void;
};

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

function isCompressibleStaticFile(filePath: string, stat: Stats): boolean {
  if (!stat.isFile() || stat.size < STATIC_COMPRESS_MIN_BYTES) return false;
  if (filePath.endsWith(".br") || filePath.endsWith(".gz")) return false;
  return COMPRESSIBLE_STATIC_EXTENSIONS.has(path.extname(filePath));
}

async function writeIfStale(filePath: string, sourceStat: Stats, writer: () => Promise<Buffer>): Promise<boolean> {
  const targetStat = await fs.stat(filePath).catch(() => null);
  if (targetStat && targetStat.mtimeMs >= sourceStat.mtimeMs && targetStat.size > 0) {
    return false;
  }

  const output = await writer();
  await fs.writeFile(filePath, output);
  return true;
}

async function precompressStaticFile(filePath: string, stat: Stats): Promise<number> {
  if (!isCompressibleStaticFile(filePath, stat)) return 0;

  const source = await fs.readFile(filePath);
  const wrote = await Promise.all([
    writeIfStale(`${filePath}.br`, stat, () =>
      brotliCompressAsync(source, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 8
        }
      })
    ),
    writeIfStale(`${filePath}.gz`, stat, () => gzipAsync(source, { level: 9 }))
  ]);

  return wrote.filter(Boolean).length;
}

async function precompressStaticAssets(dir: string): Promise<{ files: number; outputs: number }> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  let files = 0;
  let outputs = 0;

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await precompressStaticAssets(entryPath);
      files += nested.files;
      outputs += nested.outputs;
      continue;
    }

    if (!entry.isFile()) continue;
    const stat = await fs.stat(entryPath);
    const written = await precompressStaticFile(entryPath, stat);
    if (written > 0) {
      files += 1;
      outputs += written;
    }
  }

  return { files, outputs };
}

function stripCompressionExtension(filePath: string): string {
  return filePath.replace(/\.(br|gz)$/i, "");
}

function appendVary(current: number | string | string[] | undefined, value: string): string {
  const values = Array.isArray(current) ? current.join(",") : String(current ?? "");
  const parts = values
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.some((part) => part.toLowerCase() === value.toLowerCase())) {
    parts.push(value);
  }
  return parts.join(", ");
}

function setStaticFileHeaders(res: StaticHeaderResponse, filePath: string, clientDir: string): void {
  const originalPath = stripCompressionExtension(filePath);
  const relativePath = path.relative(clientDir, originalPath).split(path.sep).join("/");
  const basename = path.basename(originalPath);

  res.setHeader("Vary", appendVary(res.getHeader("Vary"), "Accept-Encoding"));

  if (relativePath.startsWith("assets/")) {
    res.setHeader("Cache-Control", STATIC_IMMUTABLE_CACHE);
    return;
  }

  if (basename === "favicon.ico" || /^favicon-\d+\.png$/.test(basename)) {
    res.setHeader("Cache-Control", STATIC_SHORT_CACHE);
    return;
  }

  res.setHeader("Cache-Control", STATIC_NO_CACHE);
}

function appendAcceptEncodingVary(reply: FastifyReply): void {
  if (!reply.getHeader("content-encoding")) return;
  reply.header("Vary", appendVary(reply.getHeader("Vary"), "Accept-Encoding"));
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

  app.addHook("onSend", async (_request, reply, payload) => {
    appendAcceptEncodingVary(reply);
    return payload;
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
    const compressionStart = Date.now();
    const compressed = await precompressStaticAssets(clientDir);
    if (compressed.outputs > 0) {
      app.log.info(
        {
          files: compressed.files,
          outputs: compressed.outputs,
          durationMs: Date.now() - compressionStart
        },
        "Precompressed static assets"
      );
    }

    await app.register(staticFiles, {
      root: clientDir,
      prefix: "/",
      cacheControl: false,
      preCompressed: true,
      setHeaders: (res, filePath) => {
        setStaticFileHeaders(res, filePath, clientDir);
      }
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
