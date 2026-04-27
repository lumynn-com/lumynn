# Obsidian Web Docs

A Node.js + React document management website for an Obsidian-style Markdown vault. Markdown files stay as plain text on disk, while the web app adds login, tree-based editing, preview, vault configuration, configurable RAG indexing, provider tests, and Markdown-rendered Q&A.

## Current Build

This first implementation includes:

- Login with first-run admin password setup.
- Filesystem-first Markdown vault list, create, edit, preview, delete, and sorting.
- Collapsed directory tree document navigation and multi-file editor tabs.
- Atomic writes and save-conflict detection using content hashes.
- Vault configuration with path validation and `ALLOWED_VAULT_ROOTS`.
- HTTPS certificate/private-key configuration, applied after server restart.
- RAG configuration for OpenAI-compatible embedding and Q&A providers, including custom endpoint paths, `/responses` mode, and explicit reasoning control.
- Buttons to test embedding, test Q&A, test-index a 20-file sample, rebuild the full index, and run incremental indexing.
- Compact RAG index snapshots using JSONL metadata plus Float32 binary embeddings under `data/vector-index/`.
- Hybrid retrieval with vector search, CJK-aware keyword scoring, metadata boosts, and indexed/vault keyword fallback.
- RAG config export/import through clipboard or JSON files, with secrets redacted from normal settings responses.
- Markdown-rendered AI answers with sanitized HTML output.
- Modern React UI with document, settings, and Q&A views.

See `PLAN.md` for the updated implementation plan, completed scope, and remaining hardening work.

## Dependencies

Runtime and development dependencies:

- Node.js 20+ recommended. This project was scaffolded with Node.js 24.
- npm 10+ or 11+.
- Native build tools for packages that may compile optional native modules.
- Optional: Obsidian desktop and `obsidian-cli` for Obsidian-native features. Core Markdown management works without it.
- OpenAI-compatible embedding endpoint for embedding tests.
- OpenAI-compatible chat completions or responses endpoint for Q&A tests and generated answers.

macOS install examples:

```sh
brew install node
xcode-select --install
```

Debian install examples:

```sh
sudo apt update
sudo apt install -y curl build-essential
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

Optional Obsidian CLI notes:

- Obsidian CLI support depends on your Obsidian version and CLI enablement.
- Some CLI modes require the Obsidian desktop app to be running.
- Debian/headless deployments should treat `obsidian-cli` as optional; the filesystem-first document management features still work.

## Setup

Install dependencies:

```sh
npm install
```

Start the app in development:

```sh
npm run dev
```

Open the Vite URL, usually `http://localhost:5173`.

First login:

- Username: `admin`
- Password: any password you choose on first login. The first successful login sets the admin password.

## Configuration

Important environment variables:

- `PORT`: backend API port. Default: `4177`.
- `HOST`: backend bind address. Default: `0.0.0.0`.
- `DATA_DIR`: app data directory. Default: `data`.
- `DEFAULT_VAULT_PATH`: initial vault path. Default: `sample-vault`.
- `ALLOWED_VAULT_ROOTS`: comma-separated directories that vault paths must stay inside. Required in production.
- `SESSION_SECRET`: cookie/session secret. Use a strong value in production.
- `APP_ENCRYPTION_KEY`: required in production and must be at least 32 characters. This is reserved for provider secret encryption hardening.
- `OBSIDIAN_CLI_BIN`: optional Obsidian CLI binary name or path. Default: `obsidian`.

HTTPS can also be configured from Settings by importing or pasting a PEM certificate and private key. Restart the server after saving HTTPS settings.

Example:

```sh
ALLOWED_VAULT_ROOTS="$HOME/Documents,$HOME/Projects" \
SESSION_SECRET="replace-with-a-long-random-secret" \
APP_ENCRYPTION_KEY="replace-with-at-least-32-characters" \
npm run server
```

## RAG Provider Settings

Configure providers from the Settings page:

- Embedding provider: OpenAI-compatible `/embeddings` endpoint.
- Q&A provider: OpenAI-compatible `/chat/completions`, `/responses`, or custom compatible endpoint.
- Base URL, endpoint path, model, API key, timeout, reasoning mode, and retrieval parameters.

Use the test buttons before running a full index:

- Test embedding: sends one small text and checks the embedding shape.
- Test Q&A: sends a tiny prompt and checks the configured Q&A response format.
- Test index: parses, chunks, and embeds a limited sample, defaulting to 20 files, into the test namespace.
- Incremental index: reuses unchanged chunks and refreshes changed files in the production namespace.

## Scripts

```sh
npm run dev      # backend + frontend dev servers
npm run server   # backend only
npm run build    # typecheck + frontend production build
npm run lint     # TypeScript check
```

## Production Notes

- Put the Node.js server behind a TLS-terminating reverse proxy such as Caddy, nginx, or Traefik.
- Set `NODE_ENV=production`, `SESSION_SECRET`, `APP_ENCRYPTION_KEY`, and `ALLOWED_VAULT_ROOTS`.
- Restrict filesystem permissions so the process can only read/write intended vaults.
- Keep provider API keys server-side and rotate them if exposed.
