import { spawn } from "node:child_process";
import { config } from "../config";

export interface ObsidianCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  error?: string;
}

export interface ObsidianCliBacklink {
  source: string;
  title?: string;
}

function runObsidianCli(args: string[], timeoutMs = 8000): Promise<ObsidianCliResult> {
  return new Promise((resolve) => {
    const child = spawn(config.obsidianBinary, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({ ok: false, stdout, stderr, code: null, error: "obsidian-cli timed out" });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, code: null, error: error.message });
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

export async function checkObsidianCli(): Promise<{ available: boolean; message: string }> {
  const result = await runObsidianCli(["--help"]);
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return {
    available: result.ok,
    message: result.ok ? "obsidian-cli is available." : result.error ?? (output || "obsidian-cli check failed.")
  };
}

function parseJsonLines<T>(text: string): T[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

export async function searchWithObsidianCli(vaultPath: string, query: string): Promise<string[]> {
  const result = await runObsidianCli(["search", "--vault", vaultPath, query]);
  if (!result.ok) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function listTagsWithObsidianCli(vaultPath: string): Promise<string[]> {
  const result = await runObsidianCli(["tags", "--vault", vaultPath]);
  if (!result.ok) {
    return [];
  }
  return Array.from(
    new Set(
      result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^#/, ""))
        .filter(Boolean)
    )
  );
}

export async function backlinksWithObsidianCli(vaultPath: string, documentPath: string): Promise<ObsidianCliBacklink[]> {
  const result = await runObsidianCli(["backlinks", "--vault", vaultPath, documentPath, "--json"]);
  if (!result.ok) {
    return [];
  }
  const parsed = parseJsonLines<{ source?: string; path?: string; title?: string }>(result.stdout);
  return parsed
    .map((item) => ({ source: item.source ?? item.path ?? "", title: item.title }))
    .filter((item) => item.source.length > 0);
}
