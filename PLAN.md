# Obsidian Web Docs Implementation Plan

## Goal

Build an Obsidian-like web document management site for a plain-text Markdown vault, with basic authentication, vault configuration, Markdown editing/preview, and retrieval-augmented Q&A.

The application should keep Markdown files as the source of truth on disk, use Obsidian-compatible conventions where practical, and keep external AI providers configurable from the web UI.

## Current Implemented Scope

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
- Atomic writes and save-conflict detection using document hashes.
- Collapsed-by-default directory tree view for the document list.
- Multi-file editor tabs, with no file opened by default.
- Markdown preview using server-side rendering and sanitization.
- Optional Obsidian CLI integration boundary, while core features continue to work without Obsidian desktop.

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

- Modern dark React UI with document, settings, and Q&A views.
- Tree view styling, tab strip, blank editor state, index progress, and provider feedback.
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

## Remaining Hardening

- Encrypt provider API keys at rest using `APP_ENCRYPTION_KEY`.
- Add automated backend/frontend tests for auth, vault path validation, RAG indexing, and provider modes.
- Add cancellation controls for long-running indexing jobs.
- Add richer Obsidian-native features through `obsidian-cli` when available, such as backlinks, tags, and workspace-aware search.
- Consider a production-grade vector database if the compact snapshot store becomes too slow for large vaults.
- Add admin controls for deleting test/production indexes.
- Add observability for provider request size, latency, retry attempts, and token usage.
