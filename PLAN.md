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
- Rename, create, edit, preview, save, and delete document actions. The New Note dialog pre-fills the path from the active document's parent folder so a new note lands next to the file you were just looking at; falls back to vault root when nothing is selected or the active tab is an unsaved draft.
- Vault search modal that uses `obsidian-cli` first and falls back to filesystem search.
- Vault search results show clickable file names only, truncated to one line when too long, and the result list scrolls inside the modal.
- Obsidian-style Markdown preview support for wikilinks, highlights, comments, callouts, image embeds, relative image paths, and LaTeX math.
- Markdown preview renders image links as images, not plain text, including Obsidian `![[image.png]]` embeds.
- Markdown preview renders Obsidian math syntax with KaTeX:
  - Inline math: `$...$`.
  - Block math: `$$...$$`.
  - Common LaTeX symbols such as `\angle`, `\square`, and `\dots`.
  - Math inside code spans/fences remains unchanged.
- Preview layout is left-aligned and wraps long content so the panel does not require horizontal scrolling for normal text.
- Markdown preview preserves editor soft line breaks so single newlines render as visible line breaks.
- Wide preview elements such as code blocks, tables, and display math scroll locally when needed.
- Markdown preview tables use clear document-style formatting with readable headers, row separators, compact content-width borders, and local scrolling for wide tables.
- Markdown task lists render safe disabled checkboxes so open and completed TODO items are visually distinct.
- AI answers render bracket references such as `[1]` and `[1, 2]` as clickable source links that open files in the editor.
- AI source cards show only title and file path, without snippet content, to keep the panel compact.
- RAG provider settings support embedding and Q&A provider configuration, API modes, endpoint paths, reasoning mode, testing, and import/export.
- RAG indexing supports test, full, and incremental jobs with progress, stop, skip-current-file, checkpointing, and resume-friendly state.
- RAG index storage uses compact snapshots under `data/vector-index/`.
- Incremental indexing uses a per-file index manifest to fast-skip unchanged files by file timestamp/size before falling back to content hash checks.
- Incremental indexing exits early without loading or rewriting vector snapshots when the file manifest shows no new, changed, or deleted files.
- Hybrid retrieval combines vector search, indexed keyword search, metadata boosts, and limited live-vault fallback.
- Q&A supports `/chat/completions`, `/responses`, and custom provider paths, with sanitized Markdown answer rendering.
- HTTPS certificate/private-key settings and `server.sh` operational helper are implemented.
- Workspace view state (document tree, expanded folders, open tabs, active file, unsaved drafts, sort, search, AI Ask) is preserved when navigating to Indexing/Settings and back; the Workspace is kept mounted and only hidden via CSS, while Settings/Indexing views are lazy-mounted on first visit and then kept mounted to retain their state without firing duplicate API calls on initial load.
- Responsive layout works on iPhone and other mobile browsers: the workspace, editor, preview, and AI Ask panes stack with usable heights using dynamic viewport units (`100dvh`), the topbar collapses into a touch-friendly nav grid, form inputs render at 16px on mobile so iOS Safari does not auto-zoom on focus, safe-area insets are honored on notched devices, and the search modal goes near full-bleed on phones.
- Native-feeling mobile interactions on small screens: a sticky top segmented control (right under the global topbar) switches between Vault, Editor, and Ask while keeping each pane mounted so state is preserved; selecting a file in the tree or a citation in Ask automatically switches to the Editor; pulling the document tree down past a threshold opens the vault search modal with a "Pull to search / Release to search" indicator; and editor tabs can be swiped left to close. Desktop behavior is unchanged.
- Mobile safety net for destructive actions: closing an editor tab and deleting a document each surface an Undo toast above the bottom tab bar that auto-dismisses after a few seconds; tapping Undo restores the closed tab in place or recreates the deleted document with its previous content. When `DeviceMotionEvent` is available (Android browsers, or iOS Safari after the user grants motion permission), a strong shake also triggers the most recent undo action.
- Web Interface Guidelines pass: replaced native `window.prompt`/`window.confirm` for new note, rename, and delete with styled in-app modals (`role="dialog"` and `role="alertdialog"`) that trap focus, support Escape to cancel, autofocus only on desktop, and surface inline errors; standardized loading copy on Logging Out\u2026 / Logging In\u2026 / Saving\u2026 / Renaming\u2026 / Deleting\u2026 / Restoring\u2026 / Searching\u2026 / Querying\u2026 with `aria-busy` and disabled buttons during the request; replaced ASCII close glyphs with `\u00d7` on tab close and undo dismiss; corrected the document tree's `aria-current` from `"page"` to `"true"`; gated search input `autoFocus` to desktop only; added `overscroll-behavior: contain` to the modal backdrop; and wired the mobile segmented control to its sections via `role="tablist"` / `role="tabpanel"` with `aria-controls` / `aria-labelledby` and arrow-key navigation between tabs.
- Settings page interactions reflect request state: every Save / Test / Start / Stop / Copy / Paste / Import action shows a localized loading label (Saving\u2026, Testing\u2026, Starting\u2026, Stopping\u2026, Copying\u2026, Pasting\u2026, Importing\u2026) with `aria-busy` and the button disabled while the request is in flight, tracked through a single `runBusy` helper that supports concurrent independent actions. Account, vault, HTTPS, and provider inputs carry stable `name`/`autoComplete`/`spellCheck` attributes for password manager and field-recall behavior.
- Login experience surfaces failed attempts visibly: failed login moves focus to the password input, selects its contents, marks it `aria-invalid`, and announces the inline error with `role="alert"` for screen readers.
- Topbar primary navigation uses inline SVG icons (workspace, layers, gear) rendered with `currentColor` so they pick up theme + active styles, alongside the always-visible text labels. The document tree caret uses real chevron icons (right collapsed, down expanded) instead of ASCII glyphs for a sharper, more native feel.
- Loading buttons display a small spinning ring icon next to the localized loading copy (Saving\u2026 / Logging In\u2026 / Querying\u2026 / Importing\u2026 / etc.) via a shared `BusyLabel` helper, so progress is visible at a glance and not just text. The spinner stops animating under `prefers-reduced-motion: reduce`.
- Mobile editor exposes a persistent floating Save action: when the editor pane is active and the open document has unsaved changes, a Save FAB sits above the home indicator (safe-area aware) with the save icon and a state-aware label (Save / Saving\u2026 / Saved). It disables when there is nothing to save.
- Mobile vault list shows a circular "back to top" button after scrolling more than ~220px; tapping it smooth-scrolls the tree back and fires a subtle haptic.
- Best-effort haptic feedback through `navigator.vibrate` for pane switches (segmented control click, edge swipe, arrow keys), the moment a pull-to-search or swipe-to-close gesture crosses its threshold, the act itself when released, and undo confirmation. No-op on iOS Safari (Apple disables the Vibration API) and under `prefers-reduced-motion: reduce`; meaningfully improves Android.
- Bilingual UI: every visible string in the workspace, login, Q&A, indexing, settings, modals, status pill, undo toast, and pull/swipe affordances flows through a small dependency-free i18n module backed by typed dictionaries for English and Simplified Chinese. The active locale is stored in `localStorage` (key `owd_locale`), defaults from `navigator.languages` on first visit, and is mirrored to `<html lang>`. A topbar segmented switcher (EN / \u4e2d\u6587) toggles the language at runtime; brand names, file paths, document titles, undo labels, and citation paths are wrapped with `translate="no"` so machine translation cannot mangle them.
- Second Web Interface Guidelines pass: paired the dark theme-color meta with a light variant via `prefers-color-scheme` so the iOS toolbar matches the active theme; routed the remaining hardcoded aria-labels through the i18n layer; localized RAG indexing job status (queued / running / completed / cancelled / failed) and the elapsed-ms unit with a non-breaking space; added a dismiss button to the persistent settings message bar; surfaced a helper text "At least 8 characters." under the account password input via `aria-describedby`; added `setPointerCapture` in the swipeable tab so a drag continues even if the finger leaves the tab; gave the AI Ask question input `type="search"` + `inputMode="search"` + `enterKeyHint="search"` and an ellipsis-terminated placeholder; and removed a redundant `aria-label` from the prompt modal's cancel button.
- Tactile press feedback: tappable surfaces (Save FAB, undo action, mobile section pills, language switcher, top nav, search results, file rows, citation source, back-to-top, tab close, message dismiss) scale to 0.97 (FAB to 0.95) on `:active` using a fast natural cubic-bezier curve; effect is gated to `prefers-reduced-motion: no-preference` so motion-sensitive users see no scaling. Modal dialogs and the search modal animate in over 180ms with a 0.96\u21921 scale + fade backed by the same curve, with the backdrop fading in over 140ms; both also disabled under reduced-motion.
- Mobile chrome refactor: each pane now exposes a single thin sticky **section header** (title + 1\u20133 round icon buttons) instead of the desktop-style panel header + full-width text-button toolbar that used to dominate the screen. Vault header has Search / New / Sort icons; Editor header has an Edit\u2194Preview toggle + an overflow menu containing Rename and Delete; Ask drops the eyebrow/title/description entirely so the question input is the first thing the user sees. Sort and order options live in a bottom **action sheet** that slides in from the bottom safe area. The Save FAB still floats bottom-right when the editor has unsaved changes. Topbar, segmented control, and pane padding all tightened so the chrome is under \u2248 110px and the content fills the rest. Desktop layout, panel headers, and original toolbars are unchanged.
- Quick note capture (in-editor draft model): a one-tap shortcut available from a Chrome-style `+` button at the end of the editor tab strip (visible on every device) and from the `Cmd/Ctrl + Shift + N` keyboard shortcut; on first mount the workspace seeds an empty draft tab so users land directly in a writable surface instead of a blank "Select a document" placeholder. Instead of a separate capture window, the trigger spawns a fresh **draft tab** in the existing editor with all its features (live preview toggle, save FAB, swipe-to-close). The draft has a synthetic client-only path (`__draft__/...`) so it never hits the server until the user explicitly saves. On Save, the file name is derived from the first Markdown heading, then the first non-empty line, then a localized timestamp like `Quick note 2026-05-01 12-30.md`; the file lands in a `Quick notes/` folder, the synthetic tab swaps in for the freshly-created tab, and an Undo toast appears that deletes the new file when tapped. If the derived name fell back to the timestamp (no real title in the content), the Rename dialog opens automatically right after save so the user can name it without an extra step. Drafts are visually distinguished with an italic tab name + "*" suffix, an "Unsaved draft" eyebrow, and a "Draft" pill in the editor header; closing a draft tab fires the same Undo toast which restores the in-memory buffer with all its content.
- Editor-first mobile model (Obsidian Mobile inspired): the desktop topbar, segmented control, and per-pane section headers are all replaced on mobile by a **single sticky app bar** at the very top: hamburger on the left (opens the vault as a left **drawer**), file name + path centered, and a more (\u22ef) icon on the right that opens a **command sheet**. Editor is the always-visible main view. Vault slides in from the left edge over a tap-to-close backdrop; Ask slides up from the bottom. The command sheet groups every remaining action: Edit/Preview toggle, Save, Rename, Delete, Ask AI, Indexing, Settings, theme toggle, language toggle, and Log Out. Indexing and Settings on mobile expose a back arrow at the top to return to the workspace. Total chrome above content collapses to \u2248 50px (the app bar) on mobile.
- Pinch-to-zoom is suppressed only inside the Markdown editor textarea so accidental two-finger gestures while typing do not zoom the page; pinch-zoom remains available everywhere else for accessibility, including the Markdown preview, document tree, and AI Ask.
- Edge-swipe between workspace panes on mobile: a horizontal swipe that starts within ~26px of the left or right screen edge cycles between Vault, Editor, and Ask without needing to reach the bottom tab bar.

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
- The site must be usable on both desktop and mobile browsers (including iPhone Safari): viewport meta with `viewport-fit=cover`, dynamic viewport heights for stable layout when the URL bar collapses, safe-area insets on notched devices, 16px-minimum form fonts to avoid iOS focus auto-zoom, touch-friendly minimum tap targets, and a stacked single-column workspace below the mobile breakpoint.
- On mobile, provide native-feeling navigation between the workspace's three panes via a sticky top segmented control (Vault / Editor / Ask) right under the global topbar, preserve pane state across switches by hiding instead of unmounting, auto-switch to the Editor when a file or AI citation is opened, support pulling the document tree down to open vault search, and support swipe-left-to-close on editor tabs.
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
  - Single newlines from the editor should render as visible line breaks in preview.
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
- Search result rows should stay visually simple: file name only, one line, with ellipsis for long names.
- Search modal result lists must scroll so all matches are reachable.
- Switching between Workspace, Indexing, and Settings tabs must preserve workspace state: the document tree, expanded folders, open tabs, active file, unsaved editor drafts, sort/search state, and AI Ask state must not be reset when returning to the Workspace.
- AI source citations must be clickable and open the cited file in the editor.
- Bracket references inside AI answers, such as `[1]`, must be rendered as clickable links to the corresponding source file.
- AI source lists should show concise source metadata only: title and file path, not full snippets.

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
- AI answer bracket citations are converted into internal links and handled client-side to open the referenced source file.
- Q&A source cards are concise and omit retrieved snippet content.

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
- Clickable in-answer citation references open source files in the editor.
- AI source cards show title and file path only.
- Search button opens a modal search UI; clickable file-name-only results open files in the editor and long result lists scroll inside the modal.
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
