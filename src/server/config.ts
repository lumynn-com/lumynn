import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rawAllowedVaultRoots = splitList(process.env.ALLOWED_VAULT_ROOTS);

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  rootDir,
  port: Number(process.env.PORT ?? 4177),
  host: process.env.HOST ?? "0.0.0.0",
  nodeEnv: process.env.NODE_ENV ?? "development",
  dataDir: path.resolve(rootDir, process.env.DATA_DIR ?? "data"),
  defaultVaultPath: path.resolve(rootDir, process.env.DEFAULT_VAULT_PATH ?? "sample-vault"),
  hasAllowedVaultRoots: rawAllowedVaultRoots.length > 0,
  allowedVaultRoots: (rawAllowedVaultRoots.length > 0 ? rawAllowedVaultRoots : [rootDir, os.homedir()]).map((entry) => path.resolve(entry)),
  sessionSecret: process.env.SESSION_SECRET ?? "dev-session-secret-change-me",
  appEncryptionKey: process.env.APP_ENCRYPTION_KEY ?? "",
  obsidianBinary: process.env.OBSIDIAN_CLI_BIN ?? "obsidian"
};

export function isProduction(): boolean {
  return config.nodeEnv === "production";
}
