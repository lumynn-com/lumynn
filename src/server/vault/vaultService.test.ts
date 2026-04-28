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
