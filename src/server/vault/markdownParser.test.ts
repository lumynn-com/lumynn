import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdown } from "./markdownParser";

test("parseMarkdown extracts Obsidian-style metadata", () => {
  const parsed = parseMarkdown(
    [
      "---",
      "title: Project Alpha",
      "tags: [work, '#planning']",
      "aliases:",
      "  - Alpha Plan",
      "---",
      "",
      "# Overview",
      "Link to [[Other Note|the other note]] and #inline/tag."
    ].join("\n"),
    "fallback.md"
  );

  assert.equal(parsed.title, "Project Alpha");
  assert.deepEqual(parsed.headings, ["Overview"]);
  assert.deepEqual(parsed.aliases, ["Alpha Plan"]);
  assert.deepEqual(parsed.links, ["Other Note"]);
  assert.deepEqual(new Set(parsed.tags), new Set(["work", "planning", "inline/tag"]));
});
