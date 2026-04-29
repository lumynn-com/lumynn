# Obsidian Web Docs Implementation Plan

## Goal

Build an Obsidian-like web document management site for a plain-text Markdown vault, with basic authentication, vault configuration, Markdown editing/preview, and retrieval-augmented Q&A.

The application should keep Markdown files as the source of truth on disk, use Obsidian-compatible conventions where practical, and keep external AI providers configurable from the web UI.

## Current Implemented Scope

- Node.js/Fastify backend and React/Vite frontend for an Obsidian-like Markdown vault web app.
- Basic authentication, first-run admin setup, logout, and organized Settings pages.
- Configurable vault path with filesystem-first Markdown operations and safe path validation.
- Classic three-column workspace layout:
  - Left column: collapsed-by-default document tree, sorting, search, and new-note actions.
  - Center column: multi-tab Markdown editor/preview workspace.
  - Right column: AI Ask panel with persistent question/answer/query state and clickable source citations.
- Global edit/preview mode switch that applies to every opened file and persists across page refreshes.
- Document sorting preference persists across page refreshes.
- Rename, create, edit, preview, save, and delete document actions.
- Vault search modal that uses `obsidian-cli` first and falls back to filesystem search.
- Obsidian-style Markdown preview support for wikilinks, highlights, comments, callouts, image embeds, relative image paths, and LaTeX math.
- Markdown preview renders image links as images, not plain text, including Obsidian `![[image.png]]` embeds.
- Markdown preview renders Obsidian math syntax with KaTeX:
  - Inline math: `$...$`.
  - Block math: `$$...$$`.
  - Common LaTeX symbols such as `\angle`, `\square`, and `\dots`.
  - Math inside code spans/fences remains unchanged.
- Preview layout is left-aligned and wraps long content so the panel does not require horizontal scrolling for normal text.
- Wide preview elements such as code blocks, tables, and display math scroll locally when needed.
- Markdown preview tables use clear document-style formatting with readable headers, row separators, compact content-width borders, and local scrolling for wide tables.
- Markdown task lists render safe disabled checkboxes so open and completed TODO items are visually distinct.
- RAG provider settings support embedding and Q&A provider configuration, API modes, endpoint paths, reasoning mode, testing, and import/export.
- RAG indexing supports test, full, and incremental jobs with progress, stop, skip-current-file, checkpointing, and resume-friendly state.
- RAG index storage uses compact snapshots under `data/vector-index/`.
- Incremental indexing uses a per-file index manifest to fast-skip unchanged files by file timestamp/size before falling back to content hash checks.
- Incremental indexing exits early without loading or rewriting vector snapshots when the file manifest shows no new, changed, or deleted files.
- Hybrid retrieval combines vector search, indexed keyword search, metadata boosts, and limited live-vault fallback.
- Q&A supports `/chat/completions`, `/responses`, and custom provider paths, with sanitized Markdown answer rendering.
- HTTPS certificate/private-key settings and `server.sh` operational helper are implemented.

## Future Implementation Checklist

Use this checklist if rebuilding the project from the plan.

### Must-Have Product Requirements

- Build a document management website, not only an API or local script.
- Use a Node.js backend and React web frontend.
- Treat Markdown files as plain-text source files, compatible with an Obsidian-style vault.
- Support a configurable vault path from the web UI.
- Keep core Markdown management working without Obsidian desktop or `obsidian-cli`.
- Leave room to leverage `obsidian-cli` for Obsidian-native features when available.
- Provide a modern, polished UI rather than a bare admin console.
- Include README dependency/setup guidance for macOS and Debian.

### Must-Have Document UX

- List Markdown documents from the vault.
- Create, edit, preview, and delete Markdown files.
- Sort documents by name, path/title, created time, and updated time.
- Present the document list as a directory tree.
- Start with all directories collapsed.
- Support opening multiple files in tabs.
- Start with no file open by default and show a blank editor state.
- Render Markdown previews safely.
- Render Obsidian-flavored preview syntax:
  - Wikilinks and aliases: `[[Note]]`, `[[Note|alias]]`.
  - Highlights: `==text==`.
  - Comments: `%%comment%%`.
  - Callouts: `> [!note] Title`.
  - Obsidian image embeds: `![[image.png]]`, including size hints.
  - Relative Markdown images: `![alt](image.png)`.
  - LaTeX math: `$...$` and `$$...$$`.
  - GitHub/Obsidian-style task lists: `- [ ]` and `- [x]`.
- Keep preview content readable in the center column:
  - Normal text must wrap inside the panel.
  - The article should be left-aligned, not centered in a narrow column.
  - Wide code blocks, tables, and display math should scroll locally instead of shifting the whole preview.
- Style preview tables clearly:
  - Header rows should stand out.
  - Cell padding and row separators should improve scanning.
  - Narrow tables should not stretch a large empty right side to the panel edge.
  - Wide tables should scroll inside the table area.
- Style task-list TODO items clearly:
  - Unchecked tasks should be visibly open.
  - Checked tasks should be visibly completed with checked state and muted/struck text.
- Keep Markdown/math transformations out of fenced code blocks and inline code spans.
- Provide a vault search modal; prefer `obsidian-cli search` when available and fall back to filesystem search.
- Search results must be clickable and open the selected file in the editor.
- AI source citations must be clickable and open the cited file in the editor.

### Must-Have Auth And Settings UX

- Provide basic login/logout authentication.
- First login should set the admin password.
- Settings must include an account section to update username/password.
- Settings must include HTTPS transport configuration to import/paste a PEM certificate and private key.
- HTTPS settings must make clear that server restart is required before protocol changes take effect.
- Logout must clear the session reliably.
- Settings page must be organized by functionality, not as one long messy form.
- Vault settings must validate path safety and enforce allowed roots.

### Must-Have RAG Provider UX

- Configure embedding provider separately from Q&A provider.
- Both providers need base URL, model, API key, timeout, API mode, and endpoint path controls.
- Embedding must support `/embeddings` plus custom embeddings-compatible paths.
- Q&A must support `/chat/completions`, `/responses`, and custom compatible paths.
- `/responses` path support is required and must not be accidentally dropped.
- Q&A reasoning/thinking control is required and must not be accidentally dropped.
- Reasoning mode must be explicit, with at least:
  - Disable reasoning/thinking.
  - Provider default.
- Test buttons are required:
  - Test embedding provider.
  - Test Q&A provider.
- RAG config import/export is required:
  - Copy export to clipboard.
  - Paste import from clipboard.
  - Export to JSON file.
  - Import from JSON file.
- Saving provider settings must not overwrite existing API keys with masked/redacted values.

### Must-Have RAG Indexing And Retrieval

- Implement real embedding-backed indexing, not only placeholder parsing.
- Provide a test-index mode for a small sample, defaulting to 20 files.
- Keep test index separate from production index.
- Q&A should fall back to the test index if no production index exists.
- Provide full reindex and incremental reindex.
- Incremental indexing should reuse unchanged chunks and refresh changed files.
- Incremental indexing should keep a persisted file manifest so unchanged files can be skipped using cheap filesystem metadata checks before reading file content.
- If the file manifest shows no new, changed, or deleted files, incremental indexing should complete immediately without loading embeddings or rewriting the vector snapshot.
- Long-running indexing jobs must support stop and skip-current-file actions.
- Index progress must remain visible when leaving and returning to the Indexing page, or after reopening the browser.
- Full and incremental jobs should checkpoint progress so interrupted work can be resumed or reused.
- Show indexing progress in the UI, including files, chunks, reused chunks, failed chunks, and current file.
- Chunk Markdown with heading-aware logic.
- Include metadata such as title, path, tags, aliases, frontmatter, and heading in embedding text.
- Retrieval should be hybrid:
  - Vector search when embeddings are available.
  - CJK-aware keyword fallback.
  - Metadata boosts.
  - Vault-wide keyword fallback if indexed retrieval fails.
- If embedding fails for a chunk, keep it available for lexical search instead of dropping it.

### Must-Have Provider Compatibility

- `/responses` requests must use a compatible request body with `input`, optional `instructions`, and `max_output_tokens`.
- `/responses` parsing must read final text from `output_text` or `output[].content[].text`.
- Reasoning models may return reasoning output before final answer; if reasoning is disabled, send the provider-compatible field, such as `thinking: { type: "disabled" }` for providers that support it.
- If a provider rejects a provider-specific reasoning field, retry without that field when using provider-default behavior.
- Provider failures must be visible as warnings, not silent blank answers.
- If answer generation fails but retrieval succeeds, show citations/snippets anyway.
- AI answers must render as sanitized Markdown, not plain text.

### Must-Have Operations

- Provide a shell script for start, stop, restart, status, and logs.
- Support serving the site over HTTPS using a configured certificate and private key.
- Certificate/private-key import must support pasted PEM text and local file import from the browser.
- Avoid duplicate running servers.
- Stop orphaned Node/Vite/tsx processes started by the app.
- On macOS, prefer Homebrew Node.js when available so the server uses the expected Node version.
- The script should show the Node/npm path and version during startup.

### Document Management

- Plain-text Markdown vault browsing, creation, editing, preview, and deletion.
- Filesystem-first vault operations with path validation.
- Sorting by name, path, title, created time, and updated time.
- Sorting preference persists in the browser.
- Atomic writes and save-conflict detection using document hashes.
- JSON app metadata saves are serialized with unique temporary files to avoid concurrent rename/write races.
- Collapsed-by-default directory tree view for the document list.
- Multi-file editor tabs, with no file opened by default.
- Global edit/preview mode switch that persists across refreshes and applies to newly opened files.
- Rename action for existing Markdown files.
- Markdown preview using server-side rendering and sanitization.
- Obsidian-style Markdown preview transforms:
  - Wikilinks and aliases.
  - Highlights.
  - Comments.
  - Callouts.
  - Obsidian image embeds.
  - Relative image paths.
  - LaTeX math rendered with KaTeX.
- Task list checkboxes are preserved as safe disabled inputs and styled to show open vs completed TODO state.
- Tables are styled for readability with clear headers, dividers, compact content width, and local overflow for wide content.
- Preview layout avoids normal horizontal scrolling by wrapping long text and isolating overflow to wide code blocks, tables, and display math.
- Optional Obsidian CLI integration boundary, while core features continue to work without Obsidian desktop.
- `obsidian-cli search` integration for vault search when available, with filesystem fallback.

### Authentication And Settings

- First-run admin password setup through login.
- Cookie-based authenticated sessions.
- Login/logout flow.
- HTTPS certificate/private-key configuration from Settings, applied after server restart.
- Settings page organized by functional area:
  - Account credentials.
  - Vault configuration and validation.
  - HTTPS transport configuration.
  - RAG providers.
  - RAG operations.
  - RAG import/export.
- Vault root enforcement through `ALLOWED_VAULT_ROOTS`.
- Production secret checks for session/encryption/vault-root settings.

### RAG Provider Configuration

- Embedding provider configuration:
  - Provider enable/disable.
  - Base URL, model, API key, timeout.
  - API mode and endpoint path, including `/embeddings` and custom embeddings-compatible paths.
  - Test embedding button.
- Q&A provider configuration:
  - Provider enable/disable.
  - Base URL, model, API key, timeout.
  - API mode and endpoint path, including `/chat/completions`, `/responses`, and custom chat-compatible paths.
  - `/responses` endpoint support is a required compatibility feature because some providers, including Volcengine/Doubao-style deployments, use `/api/v3/responses` instead of `/chat/completions`.
  - Explicit reasoning mode:
    - Disable reasoning/thinking.
    - Provider default.
  - Reasoning control is a required compatibility feature because reasoning models can spend output tokens on reasoning content and return no final answer unless thinking is disabled or enough output budget is provided.
  - Test Q&A button.
- RAG configuration import/export:
  - Copy to clipboard.
  - Paste from clipboard.
  - Export JSON file.
  - Import JSON file.
  - Secrets remain redacted in normal settings responses.

### RAG Indexing

- Real embedding-backed indexing.
- Test indexing for a limited sample, defaulting to 20 files.
- Full production indexing.
- Incremental indexing that reuses unchanged chunks.
- Stop indexing and skip-current-file controls.
- Checkpointed full/incremental progress so interrupted runs do not need to restart every file from the beginning.
- Latest job state is available from the backend so the UI can reattach when navigating away/back or reopening the site.
- Per-file index manifest stored beside the vector snapshot to track path, hash, updated time, `mtimeMs`, size, chunk count, and last indexed time.
- Incremental runs should use that manifest to read/chunk/embed only new or changed files, while removing deleted files from the production index.
- No-change incremental runs should only scan lightweight file stats, then return without loading `*.f32`/`*.jsonl` vector data.
- Background indexing jobs with progress in the UI:
  - Files processed.
  - Chunks embedded.
  - Chunks reused.
  - Failed chunks.
  - Current file and status message.
- Heading-aware Markdown chunking.
- Metadata-aware embedding text generation using title, path, tags, aliases, frontmatter, heading, and content.
- Failed embedding chunks are kept for lexical search instead of being discarded.

### Index Storage

- Replaced the original large pretty-printed `vector-index.json`.
- Compact snapshot storage under `data/vector-index/`:
  - `*.jsonl` for chunk metadata and text.
  - `*.f32` for Float32 binary embeddings.
  - `*.manifest.json` for snapshot metadata.
  - `*.files.json` for per-file incremental index metadata.
- Existing legacy JSON index migration path.
- Stored Q&A context text is now compact Copilot-style chunk context rather than the full embedding prompt.

### Retrieval And Q&A

- Hybrid retrieval:
  - Vector similarity when embeddings are available.
  - CJK-aware keyword scoring.
  - Metadata boosts for title, path, tags, and aliases.
  - Indexed keyword fallback.
  - Vault-wide keyword fallback.
- Namespace fallback:
  - Production index first.
  - Test index if production is empty.
  - Keyword fallback if no usable index exists.
- Q&A prompt uses retrieved source catalog and XML-like retrieved document blocks.
- Q&A provider failures return citations and a provider warning instead of hiding retrieval results.
- `/responses` mode must build provider-compatible request bodies using `input`, `instructions`, and `max_output_tokens`, then parse final answer text from `output_text` or `output[].content[].text`.
- Reasoning/thinking can be explicitly disabled for reasoning models that otherwise consume output tokens before producing a final answer.
- If a provider rejects a provider-specific thinking field, retry without that field so non-reasoning or non-compatible providers can still work with provider-default behavior.
- AI answers are returned with sanitized Markdown-rendered HTML and displayed as Markdown in the Q&A UI.

### UI And Operations

- Material-inspired React UI with a calm, lightweight visual style and clear system-font rendering.
- Classic Obsidian-like three-column workspace:
  - Left document tree.
  - Center editor/preview with tabs and global mode switch.
  - Right AI Ask panel.
- Top navigation for Workspace, Indexing, Settings, theme, and logout.
- Tree view styling, tab strip, blank editor state, index progress, and provider feedback.
- File names are shown in the tree, not Markdown titles, and tree file names are not bold.
- AI Ask state persists across view changes, including in-flight query state and disabled/loading button state.
- AI answers are rendered as sanitized Markdown HTML.
- Clickable AI citations open source files in the editor.
- Search button opens a modal search UI and clickable results open files in the editor.
- Preview supports Obsidian image rendering and KaTeX math rendering.
- HTTPS settings UI for importing PEM certificate and private-key files.
- `server.sh` helper for start, stop, restart, status, and logs.
- `server.sh` prioritizes Homebrew Node.js on macOS so server startup uses Node 24 when available.
- Server process cleanup handles orphaned dev/prod child processes.

## Current Architecture

- Backend: Node.js, Fastify, TypeScript.
- Frontend: React, Vite, TypeScript.
- Storage:
  - Markdown documents in the configured vault.
  - App metadata/settings/sessions in `data/app-data.json`.
  - RAG vector snapshots in `data/vector-index/`.
- Rendering:
  - Markdown preview and AI answers are rendered server-side with `marked` and sanitized with `sanitize-html`.
  - Obsidian math preview is rendered server-side with `katex` and styled with bundled KaTeX CSS.
  - Vault media assets are served through the backend for safe relative image and Obsidian embed rendering.

## Remaining Hardening

- Encrypt provider API keys at rest using `APP_ENCRYPTION_KEY`.
- Add automated backend/frontend tests for auth, vault path validation, RAG indexing, and provider modes.
- Add richer Obsidian-native features through `obsidian-cli` when available, such as backlinks, tags, and workspace-aware metadata.
- Consider a production-grade vector database if the compact snapshot store becomes too slow for large vaults.
- Add admin controls for deleting test/production indexes.
- Add observability for provider request size, latency, retry attempts, and token usage.
