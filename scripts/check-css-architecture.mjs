import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function countMatches(text, pattern) {
  return Array.from(text.matchAll(pattern)).length;
}

const failures = [];

function fail(message) {
  failures.push(message);
}

const stylesEntry = "src/client/styles.css";
const expectedLayerLine =
  "@layer vendor, legacy-base, redesign-workspace, material, mobile-chrome, feature-rules, flat-ui, minimalist, type-mobile-polish, theme-tokens, current-theme-overrides;";
const expectedImports = [
  ["katex/dist/katex.min.css", "vendor"],
  ["./styles/00-legacy-base.css", "legacy-base"],
  ["./styles/01-redesign-workspace.css", "redesign-workspace"],
  ["./styles/02-visual-material.css", "material"],
  ["./styles/03-mobile-chrome.css", "mobile-chrome"],
  ["./styles/04-print-file-management.css", "feature-rules"],
  ["./styles/05-flat-ui.css", "flat-ui"],
  ["./styles/06-minimalist-theme.css", "minimalist"],
  ["./styles/06b-minimalist-surface-rules.css", "minimalist"],
  ["./styles/07-typography-mobile-polish.css", "type-mobile-polish"],
  ["./styles/07b-mobile-minimalist-controls.css", "type-mobile-polish"],
  ["./styles/08-current-theme-tokens.css", "theme-tokens"],
  ["./styles/09-current-theme-overrides.css", "current-theme-overrides"],
  ["./styles/10-copilot-panel.css", "current-theme-overrides"]
];

const stylesText = read(stylesEntry);
if (!stylesText.includes(expectedLayerLine)) {
  fail(`${stylesEntry}: missing or changed cascade layer order`);
}

for (const [importPath, layer] of expectedImports) {
  const expected = `@import "${importPath}" layer(${layer});`;
  if (!stylesText.includes(expected)) {
    fail(`${stylesEntry}: expected layered import ${expected}`);
  }
}

for (const [index, line] of stylesText.split(/\r?\n/).entries()) {
  const trimmed = line.trim();
  if (trimmed.startsWith("@import") && !/\slayer\([^)]+\);$/.test(trimmed)) {
    fail(`${stylesEntry}:${index + 1}: @import must include a cascade layer`);
  }
}

const importantBudgets = {
  "src/client/MuyaMarkdownEditor.css": 17,
  "src/client/MarkdownSourceEditor.css": 0,
  "src/client/styles/00-legacy-base.css": 0,
  "src/client/styles/01-redesign-workspace.css": 4,
  "src/client/styles/02-visual-material.css": 1,
  "src/client/styles/03-mobile-chrome.css": 4,
  "src/client/styles/04-print-file-management.css": 74,
  "src/client/styles/05-flat-ui.css": 28,
  "src/client/styles/06-minimalist-theme.css": 55,
  "src/client/styles/06b-minimalist-surface-rules.css": 88,
  "src/client/styles/07-typography-mobile-polish.css": 15,
  "src/client/styles/07b-mobile-minimalist-controls.css": 127,
  "src/client/styles/08-current-theme-tokens.css": 0,
  "src/client/styles/09-current-theme-overrides.css": 107,
  "src/client/styles/10-copilot-panel.css": 87
};

for (const [file, budget] of Object.entries(importantBudgets)) {
  const count = countMatches(read(file), /!important\b/g);
  if (count > budget) {
    fail(`${file}: !important count ${count} exceeds budget ${budget}`);
  }
}

const rootBlockBudgets = {
  "src/client/styles/00-legacy-base.css": 1,
  "src/client/styles/01-redesign-workspace.css": 1,
  "src/client/styles/02-visual-material.css": 3,
  "src/client/styles/03-mobile-chrome.css": 0,
  "src/client/styles/04-print-file-management.css": 0,
  "src/client/styles/05-flat-ui.css": 0,
  "src/client/styles/06-minimalist-theme.css": 0,
  "src/client/styles/06b-minimalist-surface-rules.css": 0,
  "src/client/styles/07-typography-mobile-polish.css": 0,
  "src/client/styles/07b-mobile-minimalist-controls.css": 0,
  "src/client/styles/08-current-theme-tokens.css": 10,
  "src/client/styles/09-current-theme-overrides.css": 0,
  "src/client/styles/10-copilot-panel.css": 0
};

for (const [file, budget] of Object.entries(rootBlockBudgets)) {
  const count = countMatches(read(file), /^:root(?:\[data-theme="light"\])?\s*\{/gm);
  if (count > budget) {
    fail(`${file}: root token block count ${count} exceeds budget ${budget}`);
  }
}

for (const file of Object.keys(rootBlockBudgets)) {
  const text = read(file);
  for (const match of text.matchAll(/z-index\s*:\s*\d+/g)) {
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    fail(`${file}:${line}: app z-index values must use --owd-z-* tokens`);
  }
}

if (failures.length > 0) {
  console.error("CSS architecture check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("CSS architecture check passed.");
