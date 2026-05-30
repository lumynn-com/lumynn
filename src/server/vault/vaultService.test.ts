import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { emptyRagSettings, type UserRecord } from "../store";
import { normalizeDocumentPath, renderPreview, searchDocuments, writeDocument } from "./vaultService";

function testVaultPath(name: string): string {
  return path.resolve("sample-vault", "test-vaults", `${name}-${process.pid}-${Date.now()}`);
}

function makeUser(vaultPath: string): UserRecord {
  return {
    username: `test-${path.basename(vaultPath)}`,
    role: "admin",
    passwordHash: "",
    passwordUpdatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    vault: {
      path: vaultPath,
      allowPlainMarkdownFolder: true
    },
    rag: emptyRagSettings(),
    createdAtByPath: {},
    metadataByPath: {}
  };
}

async function withVault(name: string, fn: (user: UserRecord) => Promise<void>) {
  const vaultPath = testVaultPath(name);
  await fs.rm(vaultPath, { recursive: true, force: true });
  await fs.mkdir(vaultPath, { recursive: true });
  const user = makeUser(vaultPath);
  try {
    await fn(user);
  } finally {
    await fs.rm(vaultPath, { recursive: true, force: true });
  }
}

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

test("searchDocuments includes filename matches alongside body matches", async () => {
  await withVault("filename-search", async (user) => {
    await writeDocument(user, "Alpha Filename.md", "# Other\n\nThis file only matches by path.");
    await writeDocument(user, "Body.md", "# Body\n\nThe Alpha Filename phrase appears in this body.");

    const results = await searchDocuments(user, "Alpha Filename");

    assert.equal(results[0].path, "Alpha Filename.md");
    assert.ok(results.some((result) => result.path === "Body.md"));
  });
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
  assert.match(html, /title="Project Notes"/);
  assert.match(html, />project<\/a>/);
  assert.match(html, /<mark>important<\/mark>/);
  assert.doesNotMatch(html, /hidden comment/);
  assert.match(html, /<strong>Note:<\/strong> Remember/);
  assert.match(html, /\/api\/documents\/media\?path=Images%2Fphoto.png&amp;base=Folder%2FNote.md/);
  assert.match(html, /width="320"/);
});

test("renderPreview supports standard Markdown blockquotes", async () => {
  const html = await renderPreview("> quoted text");

  assert.match(html, /<blockquote>/);
  assert.match(html, /<p>quoted text<\/p>/);
  assert.match(html, /<\/blockquote>/);
});

test("renderPreview supports Obsidian heading-only links", async () => {
  const html = await renderPreview("# Jump Target\n\n[[#Jump Target|go there]]");

  assert.match(html, /class="internal-link internal-heading-link"/);
  assert.match(html, /title="#Jump Target"/);
  assert.match(html, />go there<\/a>/);
});

test("renderPreview supports common LaTeX math syntax", async () => {
  const html = await renderPreview(
    [
      "Inline $\\angle ABC = 90^\\circ$, $\\sqrt{x^2 + y^2}$, and \\(\\frac{1}{2}\\).",
      "",
      "$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} \\quad (\\Delta \\ge 0)$",
      "",
      "$$",
      "\\sum_{i=1}^n i = \\frac{n(n+1)}{2}",
      "$$",
      "",
      "\\[\\int_0^1 x^2\\,dx\\]",
      "",
      "$$",
      "\\begin{aligned}a&=b\\\\c&=d\\end{aligned}",
      "$$",
      "",
      "`$\\angle$ and \\(\\sqrt{x}\\) stay code`",
      "",
      "```",
      "$\\sqrt{x}$ stays fenced code",
      "```"
    ].join("\n")
  );

  assert.match(html, /class="katex"/);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /∠/);
  assert.match(html, /class="mord sqrt/);
  assert.match(html, /<svg[^>]+(?:viewBox|viewbox)="0 0 400000 1080"/);
  assert.match(html, /<path d="M95,702/);
  assert.match(html, /∫/);
  assert.match(html, /∑/);
  assert.doesNotMatch(html, /\\frac\{1\}\{2\}/);
  assert.doesNotMatch(html, /\\frac\{-b \\pm \\sqrt\{b\^2 - 4ac\}\}\{2a\}/);
  assert.ok(html.includes("<code>$\\angle$ and \\(\\sqrt{x}\\) stay code</code>"));
  assert.match(html, /<pre class="hljs"><code>[\s\S]*<span class="hljs-built_in">sqrt<\/span>\{x\}[\s\S]*<\/code><\/pre>/);
});

test("renderPreview keeps safe task list checkboxes", async () => {
  const html = await renderPreview("- [ ] Open task\n- [x] Done task");

  assert.match(html, /type="checkbox"/);
  assert.match(html, /disabled/);
  assert.match(html, /checked/);
  assert.match(html, /Open task/);
  assert.match(html, /Done task/);
});

test("renderPreview treats empty task list items as task checkboxes", async () => {
  const html = await renderPreview("- [ ]\n- [x]\n\n- [ ] Open task");

  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /\[ \]|\[x\]/);
  assert.match(html, /Open task/);
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
