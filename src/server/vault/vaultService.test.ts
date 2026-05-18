import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDocumentPath, renderPreview } from "./vaultService";

test("normalizeDocumentPath rejects traversal and normalizes markdown extension", () => {
  assert.equal(normalizeDocumentPath("Folder/Note"), "Folder/Note.md");
  assert.equal(normalizeDocumentPath("/Folder\\Note.md"), "Folder/Note.md");
  assert.throws(() => normalizeDocumentPath("../secret.md"), /Invalid document path/);
  assert.throws(() => normalizeDocumentPath("folder/../secret.md"), /Invalid document path/);
});

test("renderPreview sanitizes unsafe HTML", async () => {
  const html = await renderPreview("# Hello\n\n<script>alert('x')</script>\n\n<img src=\"x\" onerror=\"alert(1)\" />");

  assert.match(html, /<h1>Hello<\/h1>/);
  assert.doesNotMatch(html, /script/);
  assert.doesNotMatch(html, /onerror/);
  assert.match(html, /<img src="x"/);
});

test("renderPreview supports common Obsidian markdown", async () => {
  const html = await renderPreview(
    [
      "[[Project Notes|project]] and ==important==",
      "",
      "%%hidden comment%%",
      "",
      "> [!note] Remember",
      "> Callout body",
      "",
      "![[Images/photo.png|320]]"
    ].join("\n"),
    "Folder/Note.md"
  );

  assert.match(html, /class="internal-link"/);
  assert.match(html, />project<\/a>/);
  assert.match(html, /<mark>important<\/mark>/);
  assert.doesNotMatch(html, /hidden comment/);
  assert.match(html, /<strong>Note:<\/strong> Remember/);
  assert.match(html, /\/api\/documents\/media\?path=Images%2Fphoto.png&amp;base=Folder%2FNote.md/);
  assert.match(html, /width="320"/);
});

test("renderPreview supports Obsidian math syntax", async () => {
  const html = await renderPreview("Inline $\\angle ABC = 90^\\circ$ and $\\square + \\dots$.\n\n$$\na^2 + b^2 = c^2\n$$\n\n`$\\angle$ stays code`");

  assert.match(html, /class="katex"/);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /∠/);
  assert.match(html, /□/);
  assert.match(html, /…/);
  assert.match(html, /<code>\$\\angle\$ stays code<\/code>/);
});

test("renderPreview keeps safe task list checkboxes", async () => {
  const html = await renderPreview("- [ ] Open task\n- [x] Done task");

  assert.match(html, /type="checkbox"/);
  assert.match(html, /disabled/);
  assert.match(html, /checked/);
  assert.match(html, /Open task/);
  assert.match(html, /Done task/);
});

test("renderPreview preserves explicit ordered list numbering", async () => {
  const html = await renderPreview("7. Seventh\n9. Ninth\n\nBreak\n\n10. Tenth");

  assert.match(html, /<ol start="7">/);
  assert.match(html, /<li value="7">[\s\S]*Seventh/);
  assert.match(html, /<li value="9">[\s\S]*Ninth/);
  assert.match(html, /<ol start="10">/);
  assert.match(html, /<li value="10">[\s\S]*Tenth/);
});

test("renderPreview preserves soft line breaks", async () => {
  const html = await renderPreview("first line\nsecond line\nthird line");

  assert.match(html, /first line<br \/>second line<br \/>third line/);
});

test("renderPreview hides the YAML frontmatter block at the top of a document", async () => {
  const html = await renderPreview(
    [
      "---",
      "title: Welcome",
      "tags: [demo, docs]",
      "aliases:",
      "  - intro",
      "---",
      "",
      "# Welcome",
      "",
      "This is the body."
    ].join("\n")
  );

  assert.match(html, /<h1>Welcome<\/h1>/);
  assert.match(html, /This is the body\./);
  assert.doesNotMatch(html, /title: Welcome/);
  assert.doesNotMatch(html, /tags:/);
  assert.doesNotMatch(html, /aliases:/);
});

test("renderPreview keeps mid-document --- separators intact", async () => {
  const html = await renderPreview("# Hello\n\nFirst paragraph.\n\n---\n\nSecond paragraph.");

  // Mid-document --- becomes a horizontal rule, not a stripped block.
  assert.match(html, /<hr\s*\/?>/);
  assert.match(html, /First paragraph\./);
  assert.match(html, /Second paragraph\./);
});
