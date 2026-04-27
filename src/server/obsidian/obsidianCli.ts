import { spawn } from "node:child_process";
import { config } from "../config";

export async function checkObsidianCli(): Promise<{ available: boolean; message: string }> {
  return new Promise((resolve) => {
    const child = spawn(config.obsidianBinary, ["--help"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", () => {
      resolve({ available: false, message: "`obsidian-cli` was not found on PATH." });
    });
    child.on("close", (code) => {
      resolve({
        available: code === 0,
        message: code === 0 ? "obsidian-cli is available." : output.trim() || "obsidian-cli check failed."
      });
    });
  });
}
