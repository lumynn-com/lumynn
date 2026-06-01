import assert from "node:assert/strict";
import test from "node:test";
import { RAG_CHUNKING_VERSION, chunkMarkdownByHeading, formatChunkForEmbedding } from "./chunker";

test("chunkMarkdownByHeading keeps a small note as one chunk", () => {
  const chunks = chunkMarkdownByHeading("# Intro\nAlpha\n\n## Details\nBeta content", 1200, 160, {
    path: "Folder/Note.md",
    title: "Note",
    mtimeMs: 123
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].id, "Folder/Note.md#0");
  assert.equal(chunks[0].heading, "Intro");
  assert.equal(chunks[0].mtimeMs, 123);
  assert.match(chunks[0].text, /## Details/);
  assert.ok(chunks[0].contentHash);
  assert.equal(RAG_CHUNKING_VERSION, 3);
});

test("chunkMarkdownByHeading strips YAML frontmatter from chunk body", () => {
  const chunks = chunkMarkdownByHeading("---\ntitle: Hidden\nsecret: true\n---\n# Visible\nBody", 1200, 0, {
    path: "Visible.md",
    title: "Visible"
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].heading, "Visible");
  assert.doesNotMatch(chunks[0].text, /secret: true/);
  assert.match(chunks[0].text, /# Visible/);
});

test("chunkMarkdownByHeading splits oversized heading sections deterministically", () => {
  const content = `# Intro\n${"alpha ".repeat(80)}\n\n## Details\n${"beta ".repeat(80)}`;
  const first = chunkMarkdownByHeading(content, 180, 0, { path: "Large.md", title: "Large" });
  const second = chunkMarkdownByHeading(content, 180, 0, { path: "Large.md", title: "Large" });

  assert.ok(first.length > 2);
  assert.deepEqual(
    first.map((chunk) => ({ id: chunk.id, heading: chunk.heading, text: chunk.text })),
    second.map((chunk) => ({ id: chunk.id, heading: chunk.heading, text: chunk.text }))
  );
  assert.equal(first[0].id, "Large.md#0");
  assert.equal(first.at(-1)?.id, `Large.md#${first.length - 1}`);
});

test("formatChunkForEmbedding includes compact metadata", () => {
  const text = formatChunkForEmbedding({
    title: "Note",
    path: "Folder/Note.md",
    tags: ["project"],
    aliases: ["N"],
    heading: "Intro",
    frontmatter: { description: "x".repeat(800) },
    text: "Body"
  });

  assert.match(text, /NOTE TITLE: \[\[Note\]\]/);
  assert.match(text, /NOTE PATH: Folder\/Note.md/);
  assert.match(text, /"heading":"Intro"/);
  assert.match(text, /Body/);
  assert.ok(text.length < 2200);
});
