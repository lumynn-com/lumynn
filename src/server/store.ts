import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import type { AppSettings } from "../shared/types";

export interface UserRecord {
  username: string;
  passwordHash: string;
  passwordUpdatedAt: string;
}

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

export interface AppData {
  user: UserRecord;
  sessions: SessionRecord[];
  settings: AppSettings;
  createdAtByPath: Record<string, string>;
  metadataByPath: Record<string, DocumentMetadataRecord>;
}

const defaultRag = {
  embedding: {
    provider: "disabled" as const,
    apiMode: "embeddings" as const,
    endpointPath: "/embeddings",
    baseUrl: "",
    model: "",
    timeoutMs: 30000
  },
  qa: {
    provider: "disabled" as const,
    apiMode: "chat-completions" as const,
    endpointPath: "/chat/completions",
    reasoningMode: "disabled" as const,
    reasoningDetected: false,
    baseUrl: "",
    model: "",
    timeoutMs: 30000
  },
  retrieval: {
    topK: 6,
    chunkSize: 1200,
    chunkOverlap: 160
  },
  indexing: {
    embeddingBatchSize: 16,
    embeddingRequestsPerMinute: 0
  }
};

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
      this.data = JSON.parse(raw) as AppData;
      this.data.settings.https ??= {
        enabled: false,
        certificate: "",
        privateKey: "",
        hasCertificate: false,
        hasPrivateKey: false
      };
      this.data.settings.https.hasCertificate = Boolean(this.data.settings.https.certificate?.trim());
      this.data.settings.https.hasPrivateKey = Boolean(this.data.settings.https.privateKey?.trim());
      this.data.metadataByPath ??= {};
      this.data.settings.rag.indexing ??= defaultRag.indexing;
      if ((this.data.settings.rag.qa.reasoningMode as string | undefined) === "auto") {
        this.data.settings.rag.qa.reasoningMode = "disabled";
      }
      return this.data;
    } catch {
      const now = new Date().toISOString();
      this.data = {
        user: {
          username: "admin",
          passwordHash: "",
          passwordUpdatedAt: now
        },
        sessions: [],
        settings: {
          auth: {
            username: "admin",
            hasPassword: false
          },
          https: {
            enabled: false,
            certificate: "",
            privateKey: "",
            hasCertificate: false,
            hasPrivateKey: false
          },
          vault: {
            path: config.defaultVaultPath,
            allowPlainMarkdownFolder: true
          },
          rag: defaultRag
        },
        createdAtByPath: {},
        metadataByPath: {}
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
