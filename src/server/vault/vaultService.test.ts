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
