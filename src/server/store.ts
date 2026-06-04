import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { DEFAULT_RAG_INDEXING, DEFAULT_RAG_RETRIEVAL, type RagSettings, type UserRole, type VaultValidation } from "../shared/types";

export interface SessionRecord {
  idHash: string;
  username: string;
  expiresAt: string;
  createdAt: string;
}

export interface DocumentMetadataRecord {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  headings: string[];
  tags: string[];
  aliases: string[];
  links: string[];
  hash: string;
  createdAt: string;
  updatedAt: string;
  cachedAt: string;
}

// Per-user settings live entirely on the UserRecord. Library path,
// RAG provider config, and document metadata caches are all
// scoped to a single user; nothing is shared across users.
export interface UserVaultSettings {
  path: string;
  allowPlainMarkdownFolder: boolean;
  validation?: VaultValidation;
}

export interface UserRecord {
  username: string;
  role: UserRole;
  passwordHash: string;
  passwordUpdatedAt: string;
  createdAt: string;
  vault: UserVaultSettings;
  rag: RagSettings;
  // Per-user document metadata caches, used by vaultService to
  // skip re-reading + re-parsing files whose mtime hasn't changed.
  createdAtByPath: Record<string, string>;
  metadataByPath: Record<string, DocumentMetadataRecord>;
}

// Server-wide config that admins (and only admins) can edit.
// Currently HTTPS is the only thing here; everything else moved
// to the per-user record.
export interface GlobalSettings {
  https: {
    enabled: boolean;
    certificate: string;
    privateKey: string;
    hasCertificate: boolean;
    hasPrivateKey: boolean;
  };
}

export interface AppData {
  users: UserRecord[];
  sessions: SessionRecord[];
  globalSettings: GlobalSettings;
  // Schema version for future migrations. v1 = pre-multi-user,
  // v2 = multi-user (this file).
  schemaVersion: number;
}

const defaultRag: RagSettings = {
  embedding: {
    provider: "disabled",
    apiMode: "embeddings",
    endpointPath: "/embeddings",
    baseUrl: "",
    model: "",
    timeoutMs: 30000
  },
  qa: {
    provider: "disabled",
    apiMode: "chat-completions",
    endpointPath: "/chat/completions",
    reasoningMode: "disabled",
    reasoningDetected: false,
    baseUrl: "",
    model: "",
    timeoutMs: 30000
  },
  retrieval: { ...DEFAULT_RAG_RETRIEVAL },
  indexing: { ...DEFAULT_RAG_INDEXING }
};

function normalizeRagRetrieval(retrieval: Partial<RagSettings["retrieval"]> | undefined): RagSettings["retrieval"] {
  return { ...defaultRag.retrieval, ...(retrieval ?? {}) };
}

function normalizeRagIndexing(indexing: Partial<RagSettings["indexing"]> | undefined): RagSettings["indexing"] {
  const normalized = { ...defaultRag.indexing, ...(indexing ?? {}) };
  const submittedPartitions = Number(normalized.numberOfPartitions);
  const numberOfPartitions = Number.isFinite(submittedPartitions)
    ? Math.max(1, Math.min(64, Math.trunc(submittedPartitions)))
    : defaultRag.indexing.numberOfPartitions;

  return {
    ...normalized,
    numberOfPartitions
  };
}

export function emptyRagSettings(): RagSettings {
  // Deep-ish clone so callers can mutate freely without affecting
  // the constant template above.
  return JSON.parse(JSON.stringify(defaultRag)) as RagSettings;
}

export function emptyVaultSettings(): UserVaultSettings {
  return { path: "", allowPlainMarkdownFolder: true };
}

function defaultGlobalSettings(): GlobalSettings {
  return {
    https: {
      enabled: false,
      certificate: "",
      privateKey: "",
      hasCertificate: false,
      hasPrivateKey: false
    }
  };
}

// One-shot migration from the legacy single-admin schema. The old
// shape kept `data.user`, `data.settings`, `data.createdAtByPath`
// and `data.metadataByPath` at the top level. We collapse those
// into a single admin UserRecord and move HTTPS into
// `globalSettings`.
function migrateLegacyShape(raw: any): AppData {
  const now = new Date().toISOString();
  const legacyUser = raw?.user ?? {};
  const legacySettings = raw?.settings ?? {};
  const legacyAuth = legacySettings?.auth ?? {};
  const legacyVault = legacySettings?.vault ?? {};
  const legacyRag = legacySettings?.rag ?? defaultRag;
  const legacyHttps = legacySettings?.https ?? {};

  const admin: UserRecord = {
    username: legacyUser.username ?? legacyAuth.username ?? "admin",
    role: "admin",
    passwordHash: legacyUser.passwordHash ?? "",
    passwordUpdatedAt: legacyUser.passwordUpdatedAt ?? now,
    createdAt: legacyUser.passwordUpdatedAt ?? now,
    vault: {
      path: legacyVault.path ?? config.defaultVaultPath,
      allowPlainMarkdownFolder: legacyVault.allowPlainMarkdownFolder ?? true,
      validation: legacyVault.validation
    },
    rag: {
      ...defaultRag,
      ...legacyRag,
      embedding: { ...defaultRag.embedding, ...(legacyRag.embedding ?? {}) },
      qa: { ...defaultRag.qa, ...(legacyRag.qa ?? {}) },
      retrieval: normalizeRagRetrieval(legacyRag.retrieval),
      indexing: normalizeRagIndexing(legacyRag.indexing)
    },
    createdAtByPath: raw?.createdAtByPath ?? {},
    metadataByPath: raw?.metadataByPath ?? {}
  };

  return {
    schemaVersion: 2,
    users: [admin],
    sessions: Array.isArray(raw?.sessions) ? raw.sessions : [],
    globalSettings: {
      https: {
        enabled: Boolean(legacyHttps.enabled),
        certificate: legacyHttps.certificate ?? "",
        privateKey: legacyHttps.privateKey ?? "",
        hasCertificate: Boolean(legacyHttps.certificate?.trim?.()),
        hasPrivateKey: Boolean(legacyHttps.privateKey?.trim?.())
      }
    }
  };
}

// Normalize a v2-shaped object: fill in any missing user fields so
// later code can rely on them existing without scattering `??`
// across the codebase.
function normalizeMultiUserShape(data: AppData): AppData {
  data.users = data.users.map((user) => ({
    ...user,
    role: user.role === "admin" ? "admin" : "user",
    vault: { ...emptyVaultSettings(), ...(user.vault ?? {}) },
    rag: {
      ...emptyRagSettings(),
      ...(user.rag ?? {}),
      embedding: { ...emptyRagSettings().embedding, ...(user.rag?.embedding ?? {}) },
      qa: { ...emptyRagSettings().qa, ...(user.rag?.qa ?? {}) },
      retrieval: normalizeRagRetrieval(user.rag?.retrieval),
      indexing: normalizeRagIndexing(user.rag?.indexing)
    },
    createdAtByPath: user.createdAtByPath ?? {},
    metadataByPath: user.metadataByPath ?? {}
  }));
  data.sessions ??= [];
  data.globalSettings ??= defaultGlobalSettings();
  data.globalSettings.https.hasCertificate = Boolean(data.globalSettings.https.certificate?.trim());
  data.globalSettings.https.hasPrivateKey = Boolean(data.globalSettings.https.privateKey?.trim());
  return data;
}

export class JsonStore {
  private filePath = path.join(config.dataDir, "app-data.json");
  private data: AppData | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private saveCounter = 0;

  async load(): Promise<AppData> {
    if (this.data) {
      return this.data;
    }

    await fs.mkdir(config.dataDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const looksLegacy = parsed && (parsed.user || parsed.settings) && !Array.isArray(parsed.users);
      const migrated = looksLegacy ? migrateLegacyShape(parsed) : (parsed as AppData);
      this.data = normalizeMultiUserShape(migrated);
      if (looksLegacy) {
        // Persist the migrated layout immediately so subsequent
        // boots take the fast path.
        await this.save();
      }
      return this.data;
    } catch {
      // Fresh install: start with no users. The first POST to
      // /api/auth/login (with the bootstrap path) creates the
      // initial admin from whatever username/password was typed.
      this.data = {
        schemaVersion: 2,
        users: [],
        sessions: [],
        globalSettings: defaultGlobalSettings()
      };
      await this.save();
      return this.data;
    }
  }

  async save(): Promise<void> {
    const nextSave = this.saveChain.then(() => this.writeFile());
    this.saveChain = nextSave.catch(() => undefined);
    return nextSave;
  }

  private async writeFile(): Promise<void> {
    if (!this.data) {
      return;
    }

    await fs.mkdir(config.dataDir, { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.${this.saveCounter++}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(this.data, null, 2));
      await fs.rename(tmpPath, this.filePath);
    } finally {
      await fs.unlink(tmpPath).catch(() => undefined);
    }
  }
}

export const store = new JsonStore();

// Helpers for finding the calling user inside store data. Kept
// here (not in authService) because vaultService and ragRoutes
// also need to look users up by name without circular imports.
export function findUserByUsername(data: AppData, username: string): UserRecord | null {
  return data.users.find((user) => user.username === username) ?? null;
}

export function adminUsers(data: AppData): UserRecord[] {
  return data.users.filter((user) => user.role === "admin");
}
