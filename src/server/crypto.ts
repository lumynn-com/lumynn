import crypto from "node:crypto";
import { config, isProduction } from "./config";

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function newToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function assertProductionSecrets(): void {
  if (!isProduction()) {
    return;
  }

  if (config.sessionSecret.length < 24 || config.sessionSecret.includes("change-me")) {
    throw new Error("SESSION_SECRET must be set to a strong value in production.");
  }

  if (config.appEncryptionKey.length < 32) {
    throw new Error("APP_ENCRYPTION_KEY must be at least 32 characters in production.");
  }

  if (!config.hasAllowedVaultRoots) {
    throw new Error("ALLOWED_VAULT_ROOTS must be configured in production.");
  }
}

export function redactSecret(value?: string): string {
  if (!value) {
    return "";
  }

  if (value.length <= 8) {
    return "********";
  }

  return `${value.slice(0, 3)}...${value.slice(-4)}`;
}
