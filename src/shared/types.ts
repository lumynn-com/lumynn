export type SortField = "name" | "createdAt" | "updatedAt" | "path" | "title";
export type SortOrder = "asc" | "desc";

export interface DocumentTreeEntry {
  /** Vault-relative path. Files end with `.md`; folders carry the
   *  folder's vault-relative path without trailing slash. */
  path: string;
  /** Basename of the entry. */
  name: string;
  /** Whether this entry is a folder (has children) or a file (leaf). */
  type: "folder" | "file";
  /** Sorted children. May be omitted on folders when the server
   *  returned a depth-limited listing; `hasChildren` indicates
   *  whether the folder is known to be non-empty without forcing
   *  the children to be fetched. */
  children?: DocumentTreeEntry[];
  /** Set by the server on folders when `children` was elided for
   *  depth reasons but the folder is known to contain at least one
   *  Markdown file or non-empty subfolder. */
  hasChildren?: boolean;
  /** For file entries when the server was asked to sort by mtime:
   *  the file's last-modified time as an ISO string. */
  updatedAt?: string;
}

export interface DocumentSummary {
  path: string;
  name: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  hash: string;
  tags: string[];
  aliases: string[];
  headings: string[];
}

export interface DocumentContent extends DocumentSummary {
  content: string;
  frontmatter: Record<string, unknown>;
  links: string[];
}

export interface DocumentSearchResult {
  path: string;
  name: string;
  title: string;
  snippet: string;
  source: "obsidian-cli" | "filesystem";
}

export interface RagSettings {
  embedding: ProviderSettings;
  qa: ProviderSettings;
  retrieval: {
    topK: number;
    chunkSize: number;
    chunkOverlap: number;
  };
  indexing: {
    embeddingBatchSize: number;
    embeddingRequestsPerMinute: number;
  };
}

export interface ProviderSettings {
  provider: "openai-compatible" | "disabled";
  apiMode?: "embeddings" | "chat-completions" | "responses" | "custom";
  endpointPath?: string;
  reasoningMode?: "disabled" | "provider-default";
  reasoningDetected?: boolean;
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

export interface RagIndexJob {
  id: string;
  mode: "test" | "full" | "incremental";
  namespace: "test" | "production";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  totalFiles: number;
  processedFiles: number;
  skippedFiles: number;
  totalChunks: number;
  embeddedChunks: number;
  reusedChunks: number;
  failedChunks: number;
  currentFile?: string;
  cancelRequested?: boolean;
  skipRequested?: boolean;
  message: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
}

export interface RagNamespaceStats {
  updatedAt?: string;
  fileCount: number;
  chunkCount: number;
  hasIndex: boolean;
}

export interface RagIndexStats {
  production: RagNamespaceStats;
  test: RagNamespaceStats;
}

export interface AppSettings {
  auth: {
    username: string;
    hasPassword: boolean;
  };
  https: {
    enabled: boolean;
    certificate?: string;
    privateKey?: string;
    hasCertificate?: boolean;
    hasPrivateKey?: boolean;
  };
  vault: {
    path: string;
    allowPlainMarkdownFolder: boolean;
    validation?: VaultValidation;
  };
  rag: RagSettings;
}

export interface VaultValidation {
  ok: boolean;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  insideAllowedRoot: boolean;
  hasObsidianConfig: boolean;
  message: string;
}

export interface ApiError {
  error: string;
  details?: unknown;
}
