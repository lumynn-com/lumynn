import assert from "node:assert/strict";
import test from "node:test";
import { chunkMarkdownByHeading, formatChunkForEmbedding } from "./chunker";

test("chunkMarkdownByHeading preserves heading context", () => {
  const chunks = chunkMarkdownByHeading("# Intro\nAlpha\n\n## Details\nBeta content", 25, 0);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].heading, "Intro");
  assert.equal(chunks[1].heading, "Details");
  assert.match(chunks[1].text, /Beta content/);
});

test("chunkMarkdownByHeading merges small adjacent heading sections", () => {
  const chunks = chunkMarkdownByHeading("# Intro\nAlpha\n\n## Details\nBeta\n\n## More\nGamma", 1200, 160);

  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /# Intro/);
  assert.match(chunks[0].text, /## Details/);
  assert.match(chunks[0].text, /## More/);
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
