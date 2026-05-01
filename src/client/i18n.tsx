import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export type Locale = "en" | "zh";

const STORAGE_KEY = "owd_locale";

const dictionaries = {
  en: {
    // Top-level / nav
    "app.brand.name": "Obsidian Web",
    "app.brand.tagline": "Markdown vault",
    "app.openWorkspace": "Open workspace",
    "nav.aria": "Primary",
    "nav.workspace": "Workspace",
    "nav.indexing": "Indexing",
    "nav.settings": "Settings",
    "topbar.toggleTheme": "Toggle theme",
    "topbar.themeLight": "Light Theme",
    "topbar.themeDark": "Dark Theme",
    "topbar.language": "Language",
    "topbar.logout": "Log Out",
    "topbar.logoutBusy": "Logging Out\u2026",
    "skipToMain": "Skip to Main Content",

    // Login
    "login.eyebrow": "Obsidian Web Docs",
    "login.titleSetup": "Create your admin password",
    "login.titleWelcome": "Welcome back",
    "login.description": "Manage a plain-text Markdown vault with preview, settings, and RAG Q&A from a modern web interface.",
    "login.username": "Username",
    "login.password": "Password",
    "login.submitSetup": "Create Account",
    "login.submitLogin": "Log In",
    "login.submitSetupBusy": "Creating Account\u2026",
    "login.submitLoginBusy": "Logging In\u2026",

    // Mobile section switcher
    "section.vault": "Vault",
    "section.editor": "Editor",
    "section.ask": "Ask",
    "section.aria": "Workspace sections",

    // Vault pane
    "vault.eyebrow": "Vault",
    "vault.title": "Documents",
    "vault.fileCount": "{count} Markdown file",
    "vault.fileCountPlural": "{count} Markdown files",
    "vault.searchVault": "Search Vault",
    "vault.newNote": "New Note",
    "vault.sortBy": "Sort By",
    "vault.sortName": "Name",
    "vault.sortCreated": "Created",
    "vault.sortUpdated": "Updated",
    "vault.sortPath": "Path",
    "vault.sortTitle": "Title",
    "vault.order": "Order",
    "vault.orderAsc": "Ascending",
    "vault.orderDesc": "Descending",
    "vault.empty": "No Markdown documents yet. Create your first note.",
    "vault.sortOptions": "Sort options",
    "vault.search": "Search",
    "vault.new": "New note",
    "vault.sort": "Sort",
    "vault.done": "Done",
    "vault.pullToSearch": "Pull to search",
    "vault.releaseToSearch": "Release to search",
    "vault.backToTop": "Scroll vault list back to top",

    // Editor pane
    "editor.noDocSelected": "No document selected",
    "editor.title": "Editor",
    "editor.modeLabel": "Editor display mode",
    "editor.modeEdit": "Edit",
    "editor.modePreview": "Preview",
    "editor.actionsLabel": "Editor actions",
    "editor.rename": "Rename",
    "editor.delete": "Delete",
    "editor.save": "Save Note",
    "editor.saveBusy": "Saving\u2026",
    "editor.tabsLabel": "Open documents",
    "editor.closeTab": "Close {name}",
    "editor.contentLabel": "Markdown Content",
    "editor.previewEmpty": "No preview yet.",
    "editor.blankEyebrow": "No file open",
    "editor.blankTitle": "Select a document from the tree",
    "editor.blankBody": "The editor starts blank by default. Open one or more files to work with tabs.",
    "editor.fab.save": "Save",
    "editor.fab.saved": "Saved",
    "editor.fab.saving": "Saving\u2026",
    "editor.fab.ariaSave": "Save note",
    "editor.fab.ariaSaved": "Note is up to date",
    "editor.swipeClose": "Close",
    "editor.toggleMode": "Toggle edit / preview",
    "editor.moreActions": "More actions",

    // Status messages
    "status.ready": "Ready",
    "status.saving": "Saving\u2026",
    "status.saved": "Saved",
    "status.saveFailed": "Save failed",
    "status.created": "Created",
    "status.createFailed": "Create failed",
    "status.renaming": "Renaming\u2026",
    "status.renamed": "Renamed",
    "status.renameFailed": "Rename failed",
    "status.deleting": "Deleting\u2026",
    "status.deleted": "Deleted",
    "status.deleteFailed": "Delete failed",
    "status.restoring": "Restoring\u2026",
    "status.restoreFailedPrefix": "Restore failed",
    "status.restoredPrefix": "Restored",
    "status.reopenedPrefix": "Reopened",

    // Undo toast
    "undo.closedPrefix": "Closed",
    "undo.deletedPrefix": "Deleted",
    "undo.button": "Undo",
    "undo.dismiss": "Dismiss",

    // Search modal
    "search.eyebrow": "Vault Search",
    "search.title": "Search Documents",
    "search.description": "Uses obsidian-cli first, with filesystem search as fallback.",
    "search.close": "Close",
    "search.queryLabel": "Search query",
    "search.placeholder": "Search file names, tags, headings, or content\u2026",
    "search.submit": "Search",
    "search.submitBusy": "Searching\u2026",
    "search.empty": "Enter a query to search the vault.",
    "search.noResults": "No matching files found.",

    // Prompt / confirm modals
    "prompt.cancel": "Cancel",
    "prompt.create.title": "New note",
    "prompt.create.eyebrow": "Vault",
    "prompt.create.description": "File path is relative to the vault root. Include subfolders with /.",
    "prompt.create.label": "File path",
    "prompt.create.placeholder": "Untitled.md",
    "prompt.create.submit": "Create",
    "prompt.create.submitBusy": "Creating\u2026",
    "prompt.rename.title": "Rename note",
    "prompt.rename.description": "Enter a new path. Subfolders will be created if needed.",
    "prompt.rename.label": "New path",
    "prompt.rename.submit": "Rename",
    "prompt.rename.submitBusy": "Renaming\u2026",
    "confirm.delete.title": "Delete {name}?",
    "confirm.delete.description": "The file is removed from the vault. You can restore it from the Undo toast within a few seconds.",
    "confirm.delete.submit": "Delete",
    "confirm.delete.submitBusy": "Deleting\u2026",

    // Q&A
    "qa.eyebrow": "Ask AI",
    "qa.title": "Ask your vault",
    "qa.description": "Get answers grounded in indexed Markdown notes, with citations you can inspect.",
    "qa.question": "Question",
    "qa.placeholder": "Example: What did I write about this project\u2026",
    "qa.submit": "Ask Vault",
    "qa.submitBusy": "Querying\u2026",
    "qa.runningHint": "Query is running. You can switch pages and come back.",
    "qa.answerEyebrow": "Answer",
    "qa.answerTitle": "Response",
    "qa.sourceLabel": "Source: {name}",
    "qa.retrievalWarning": "Retrieval warning: {message}",
    "qa.providerWarning": "Provider warning: {message}",
    "qa.noCitations": "No citations returned. Rebuild or resume the index, then ask again.",

    // Settings (shared)
    "settings.loading": "Loading settings\u2026",
    "settings.eyebrowConfig": "Configuration",
    "settings.eyebrowKb": "Knowledge Base",
    "settings.titleSettings": "Settings",
    "settings.titleIndexing": "Indexing",
    "settings.descriptionSettings": "Configure the vault, AI providers, import/export, HTTPS, and the admin account.",
    "settings.descriptionIndexing": "Build, resume, and monitor the searchable RAG index for your Markdown vault.",
    "settings.navAria": "Settings sections",

    "settings.section.vault": "Vault",
    "settings.section.providers": "AI Providers",
    "settings.section.importExport": "Import / Export",
    "settings.section.https": "HTTPS",
    "settings.section.account": "Account",

    // Settings -> Account
    "settings.account.eyebrow": "Authentication",
    "settings.account.title": "Account",
    "settings.account.description": "Update the single admin account used by this MVP.",
    "settings.account.username": "Username",
    "settings.account.newPassword": "New password",
    "settings.account.save": "Save account",
    "settings.account.saveBusy": "Saving\u2026",
    "settings.account.savedMessage": "Account credentials saved. Existing sessions were cleared.",
    "settings.account.saveError": "Unable to save account",
    "settings.account.passwordHelp": "At least 8 characters.",

    // Settings -> Vault
    "settings.vault.eyebrow": "Documents",
    "settings.vault.title": "Obsidian Vault",
    "settings.vault.description": "Choose the filesystem vault used by the document manager.",
    "settings.vault.path": "Vault path",
    "settings.vault.allowPlain": "Allow plain Markdown folders",
    "settings.vault.save": "Save vault",
    "settings.vault.saveBusy": "Saving\u2026",
    "settings.vault.savedMessage": "Vault settings saved",
    "settings.vault.saveError": "Unable to save vault",

    // Settings -> HTTPS
    "settings.https.eyebrow": "Transport",
    "settings.https.title": "HTTPS Certificate",
    "settings.https.description": "Paste or import PEM certificate and private key files. A server restart is required after saving.",
    "settings.https.enable": "Enable HTTPS on server restart",
    "settings.https.statusConfigured": "configured",
    "settings.https.statusNot": "not configured",
    "settings.https.statusLine": "Certificate: {cert} \u00b7 Private key: {key}",
    "settings.https.cert": "Certificate PEM",
    "settings.https.certPlaceholder": "Paste -----BEGIN CERTIFICATE----- \u2026 Leave blank to keep the existing certificate.",
    "settings.https.importCert": "Import certificate file",
    "settings.https.privateKey": "Private key PEM",
    "settings.https.privateKeyPlaceholder": "Paste -----BEGIN PRIVATE KEY----- \u2026 Leave blank to keep the existing private key.",
    "settings.https.importKey": "Import private key file",
    "settings.https.save": "Save HTTPS settings",
    "settings.https.saveBusy": "Saving\u2026",
    "settings.https.savedMessage": "HTTPS settings saved. Restart the server for protocol changes to take effect.",
    "settings.https.saveError": "Unable to save HTTPS settings",

    // Settings -> Providers
    "settings.providers.embeddingEyebrow": "Embeddings",
    "settings.providers.embeddingTitle": "Embedding Provider",
    "settings.providers.qaEyebrow": "Chat",
    "settings.providers.qaTitle": "Q&A Provider",
    "settings.providers.save": "Save AI Providers",
    "settings.providers.saveBusy": "Saving\u2026",
    "settings.providers.savedMessage": "RAG settings saved",
    "settings.providers.saveError": "Unable to save RAG settings",
    "settings.providers.testEmbedding": "Test Embedding",
    "settings.providers.testEmbeddingBusy": "Testing\u2026",
    "settings.providers.testQa": "Test Q&A",
    "settings.providers.testQaBusy": "Testing\u2026",
    "settings.providers.testFailed": "Test failed",
    "settings.providers.provider": "Provider",
    "settings.providers.providerDisabled": "Disabled",
    "settings.providers.providerOpenAi": "OpenAI compatible",
    "settings.providers.apiMode": "API mode",
    "settings.providers.apiModeEmbeddings": "Embeddings API (/embeddings)",
    "settings.providers.apiModeChat": "Chat Completions API (/chat/completions)",
    "settings.providers.apiModeResponses": "Responses API (/responses)",
    "settings.providers.apiModeCustomEmbedding": "Custom embeddings-compatible path",
    "settings.providers.apiModeCustomChat": "Custom chat-completions-compatible path",
    "settings.providers.baseUrl": "Base URL",
    "settings.providers.endpointPath": "Endpoint path",
    "settings.providers.reasoning": "Reasoning mode",
    "settings.providers.reasoningDisabled": "Disable reasoning/thinking",
    "settings.providers.reasoningDefault": "Provider default",
    "settings.providers.reasoningHelp": "Use disabled for reasoning models that may spend output tokens before the final answer.",
    "settings.providers.model": "Model",
    "settings.providers.apiKey": "API key",
    "settings.providers.apiKeyPlaceholder": "Leave blank to keep existing key",

    // Settings -> Operations / Indexing
    "settings.ops.eyebrow": "Search Index",
    "settings.ops.title": "Build Index",
    "settings.ops.description": "Create the knowledge base used by Ask AI. Start with a small sample, then run incremental indexing for day-to-day updates.",
    "settings.ops.topK": "Top K",
    "settings.ops.chunkSize": "Chunk size",
    "settings.ops.chunkOverlap": "Chunk overlap",
    "settings.ops.batchSize": "Embedding batch size",
    "settings.ops.rpm": "Embedding requests/min",
    "settings.ops.saveIndex": "Save Index Settings",
    "settings.ops.saveIndexBusy": "Saving\u2026",
    "settings.ops.testIndex": "Index 20-File Sample",
    "settings.ops.testIndexBusy": "Starting\u2026",
    "settings.ops.incremental": "Start Incremental Index",
    "settings.ops.incrementalBusy": "Starting\u2026",
    "settings.ops.full": "Rebuild Full Index",
    "settings.ops.fullBusy": "Starting\u2026",
    "settings.ops.startedMessage": "Started {mode} indexing job {id}",
    "settings.ops.startError": "Unable to start indexing",
    "settings.ops.stopRequested": "Stop requested for indexing job",
    "settings.ops.skipRequested": "Skip requested for current file",
    "settings.ops.controlError": "Unable to update indexing job",

    // Settings -> Index status / progress
    "settings.indexStatus.aria": "RAG index status",
    "settings.indexStatus.production": "Production Index",
    "settings.indexStatus.test": "Test Index",
    "settings.indexStatus.indexed": "Indexed",
    "settings.indexStatus.notIndexed": "Not Indexed",
    "settings.indexStatus.files": "{count} files",
    "settings.indexStatus.chunks": "{count} chunks",
    "settings.indexStatus.lastUpdated": "Last updated: {value}",
    "settings.indexStatus.never": "Never",

    "settings.progress.test": "Test index",
    "settings.progress.incremental": "Incremental index",
    "settings.progress.full": "Full index",
    "settings.progress.files": "Files",
    "settings.progress.chunks": "Chunks",
    "settings.progress.skippedFiles": "Skipped files: {count}",
    "settings.progress.reusedChunks": "Reused chunks: {count}",
    "settings.progress.failedChunks": "Failed chunks: {count}",
    "settings.progress.currentFile": "Current: {name}",
    "settings.progress.skipCurrent": "Skip current file",
    "settings.progress.skipRequestedShort": "Skip requested",
    "settings.progress.stop": "Stop indexing",
    "settings.progress.stopping": "Stopping\u2026",
    "settings.progress.elapsed": "{ms}\u00a0ms",
    "settings.jobStatus.queued": "Queued",
    "settings.jobStatus.running": "Running",
    "settings.jobStatus.completed": "Completed",
    "settings.jobStatus.cancelled": "Cancelled",
    "settings.jobStatus.failed": "Failed",
    "settings.message.dismiss": "Dismiss message",

    // Settings -> Import / Export
    "settings.export.eyebrow": "Export",
    "settings.export.title": "RAG Export",
    "settings.export.description": "Exported config omits real API keys from normal settings responses.",
    "settings.export.aria": "RAG configuration export",
    "settings.export.copy": "Copy to clipboard",
    "settings.export.copyBusy": "Copying\u2026",
    "settings.export.copySuccess": "RAG configuration copied to clipboard",
    "settings.export.copyError": "Clipboard write failed. Select the export text and copy it manually.",
    "settings.export.toFile": "Export to file",
    "settings.export.fileSavedMessage": "RAG configuration exported to file",

    "settings.import.eyebrow": "Import",
    "settings.import.title": "RAG Import",
    "settings.import.description": "Paste from clipboard or load a schemaVersion 1 RAG config JSON file.",
    "settings.import.aria": "RAG configuration import",
    "settings.import.paste": "Paste from clipboard",
    "settings.import.pasteBusy": "Pasting\u2026",
    "settings.import.pasteSuccess": "RAG configuration pasted from clipboard",
    "settings.import.pasteError": "Clipboard read failed. Paste the configuration manually.",
    "settings.import.fromFile": "Import from file",
    "settings.import.loadedFile": "Loaded {name}. Review it, then click Import RAG config.",
    "settings.import.submit": "Import RAG config",
    "settings.import.submitBusy": "Importing\u2026",
    "settings.import.success": "RAG configuration imported",
    "settings.import.failed": "Import failed",

    // Generic action failures (used in error fallbacks)
    "error.actionFailed": "Action failed"
  },
  zh: {
    "app.brand.name": "Obsidian Web",
    "app.brand.tagline": "Markdown \u77e5\u8bc6\u5e93",
    "app.openWorkspace": "\u6253\u5f00\u5de5\u4f5c\u533a",
    "nav.aria": "\u4e3b\u5bfc\u822a",
    "nav.workspace": "\u5de5\u4f5c\u533a",
    "nav.indexing": "\u7d22\u5f15",
    "nav.settings": "\u8bbe\u7f6e",
    "topbar.toggleTheme": "\u5207\u6362\u4e3b\u9898",
    "topbar.themeLight": "\u6d45\u8272\u4e3b\u9898",
    "topbar.themeDark": "\u6df1\u8272\u4e3b\u9898",
    "topbar.language": "\u8bed\u8a00",
    "topbar.logout": "\u9000\u51fa\u767b\u5f55",
    "topbar.logoutBusy": "\u9000\u51fa\u4e2d\u2026",
    "skipToMain": "\u8df3\u81f3\u4e3b\u8981\u5185\u5bb9",

    "login.eyebrow": "Obsidian Web Docs",
    "login.titleSetup": "\u521b\u5efa\u7ba1\u7406\u5458\u5bc6\u7801",
    "login.titleWelcome": "\u6b22\u8fce\u56de\u6765",
    "login.description": "\u4ee5\u73b0\u4ee3\u5316\u7684 Web \u754c\u9762\u7ba1\u7406\u7eaf\u6587\u672c Markdown \u77e5\u8bc6\u5e93\uff0c\u63d0\u4f9b\u9884\u89c8\u3001\u8bbe\u7f6e\u4ee5\u53ca\u68c0\u7d22\u589e\u5f3a\u95ee\u7b54\u3002",
    "login.username": "\u7528\u6237\u540d",
    "login.password": "\u5bc6\u7801",
    "login.submitSetup": "\u521b\u5efa\u8d26\u6237",
    "login.submitLogin": "\u767b\u5f55",
    "login.submitSetupBusy": "\u521b\u5efa\u4e2d\u2026",
    "login.submitLoginBusy": "\u767b\u5f55\u4e2d\u2026",

    "section.vault": "\u77e5\u8bc6\u5e93",
    "section.editor": "\u7f16\u8f91\u5668",
    "section.ask": "\u63d0\u95ee",
    "section.aria": "\u5de5\u4f5c\u533a\u533a\u57df",

    "vault.eyebrow": "\u77e5\u8bc6\u5e93",
    "vault.title": "\u6587\u6863",
    "vault.fileCount": "\u5171 {count} \u4e2a Markdown \u6587\u4ef6",
    "vault.fileCountPlural": "\u5171 {count} \u4e2a Markdown \u6587\u4ef6",
    "vault.searchVault": "\u641c\u7d22\u77e5\u8bc6\u5e93",
    "vault.newNote": "\u65b0\u5efa\u7b14\u8bb0",
    "vault.sortBy": "\u6392\u5e8f",
    "vault.sortName": "\u540d\u79f0",
    "vault.sortCreated": "\u521b\u5efa\u65f6\u95f4",
    "vault.sortUpdated": "\u4fee\u6539\u65f6\u95f4",
    "vault.sortPath": "\u8def\u5f84",
    "vault.sortTitle": "\u6807\u9898",
    "vault.order": "\u987a\u5e8f",
    "vault.orderAsc": "\u5347\u5e8f",
    "vault.orderDesc": "\u964d\u5e8f",
    "vault.empty": "\u8fd8\u6ca1\u6709 Markdown \u6587\u6863\uff0c\u5148\u521b\u5efa\u4e00\u7bc7\u5427\u3002",
    "vault.sortOptions": "\u6392\u5e8f\u9009\u9879",
    "vault.search": "\u641c\u7d22",
    "vault.new": "\u65b0\u5efa",
    "vault.sort": "\u6392\u5e8f",
    "vault.done": "\u5b8c\u6210",
    "vault.pullToSearch": "\u4e0b\u62c9\u641c\u7d22",
    "vault.releaseToSearch": "\u677e\u5f00\u5373\u53ef\u641c\u7d22",
    "vault.backToTop": "\u56de\u5230\u9876\u90e8",

    "editor.noDocSelected": "\u672a\u9009\u4e2d\u6587\u6863",
    "editor.title": "\u7f16\u8f91\u5668",
    "editor.modeLabel": "\u7f16\u8f91\u5668\u663e\u793a\u6a21\u5f0f",
    "editor.modeEdit": "\u7f16\u8f91",
    "editor.modePreview": "\u9884\u89c8",
    "editor.actionsLabel": "\u7f16\u8f91\u5668\u64cd\u4f5c",
    "editor.rename": "\u91cd\u547d\u540d",
    "editor.delete": "\u5220\u9664",
    "editor.save": "\u4fdd\u5b58",
    "editor.saveBusy": "\u4fdd\u5b58\u4e2d\u2026",
    "editor.tabsLabel": "\u5df2\u6253\u5f00\u7684\u6587\u6863",
    "editor.closeTab": "\u5173\u95ed {name}",
    "editor.contentLabel": "Markdown \u5185\u5bb9",
    "editor.previewEmpty": "\u6682\u65e0\u9884\u89c8\u3002",
    "editor.blankEyebrow": "\u672a\u6253\u5f00\u6587\u4ef6",
    "editor.blankTitle": "\u4ece\u5de6\u4fa7\u9009\u62e9\u4e00\u4efd\u6587\u6863",
    "editor.blankBody": "\u7f16\u8f91\u5668\u9ed8\u8ba4\u4e3a\u7a7a\u3002\u6253\u5f00\u4e00\u4e2a\u6216\u591a\u4e2a\u6587\u4ef6\u540e\u4f1a\u4ee5\u6807\u7b7e\u9875\u5bfc\u822a\u3002",
    "editor.fab.save": "\u4fdd\u5b58",
    "editor.fab.saved": "\u5df2\u4fdd\u5b58",
    "editor.fab.saving": "\u4fdd\u5b58\u4e2d\u2026",
    "editor.fab.ariaSave": "\u4fdd\u5b58\u5f53\u524d\u6587\u6863",
    "editor.fab.ariaSaved": "\u5f53\u524d\u6587\u6863\u5df2\u662f\u6700\u65b0",
    "editor.swipeClose": "\u5173\u95ed",
    "editor.toggleMode": "\u5207\u6362\u7f16\u8f91 / \u9884\u89c8",
    "editor.moreActions": "\u66f4\u591a\u64cd\u4f5c",

    "status.ready": "\u5c31\u7eea",
    "status.saving": "\u4fdd\u5b58\u4e2d\u2026",
    "status.saved": "\u5df2\u4fdd\u5b58",
    "status.saveFailed": "\u4fdd\u5b58\u5931\u8d25",
    "status.created": "\u5df2\u521b\u5efa",
    "status.createFailed": "\u521b\u5efa\u5931\u8d25",
    "status.renaming": "\u91cd\u547d\u540d\u4e2d\u2026",
    "status.renamed": "\u5df2\u91cd\u547d\u540d",
    "status.renameFailed": "\u91cd\u547d\u540d\u5931\u8d25",
    "status.deleting": "\u5220\u9664\u4e2d\u2026",
    "status.deleted": "\u5df2\u5220\u9664",
    "status.deleteFailed": "\u5220\u9664\u5931\u8d25",
    "status.restoring": "\u6062\u590d\u4e2d\u2026",
    "status.restoreFailedPrefix": "\u6062\u590d\u5931\u8d25",
    "status.restoredPrefix": "\u5df2\u6062\u590d",
    "status.reopenedPrefix": "\u5df2\u91cd\u65b0\u6253\u5f00",

    "undo.closedPrefix": "\u5df2\u5173\u95ed",
    "undo.deletedPrefix": "\u5df2\u5220\u9664",
    "undo.button": "\u64a4\u9500",
    "undo.dismiss": "\u5173\u95ed\u63d0\u793a",

    "search.eyebrow": "\u77e5\u8bc6\u5e93\u641c\u7d22",
    "search.title": "\u641c\u7d22\u6587\u6863",
    "search.description": "\u4f18\u5148\u4f7f\u7528 obsidian-cli\uff0c\u672a\u542f\u7528\u65f6\u56de\u9000\u5230\u6587\u4ef6\u7cfb\u7edf\u641c\u7d22\u3002",
    "search.close": "\u5173\u95ed",
    "search.queryLabel": "\u641c\u7d22\u5173\u952e\u5b57",
    "search.placeholder": "\u641c\u7d22\u6587\u4ef6\u540d\u3001\u6807\u7b7e\u3001\u6807\u9898\u6216\u6b63\u6587\u2026",
    "search.submit": "\u641c\u7d22",
    "search.submitBusy": "\u641c\u7d22\u4e2d\u2026",
    "search.empty": "\u8f93\u5165\u5173\u952e\u5b57\u4ee5\u641c\u7d22\u77e5\u8bc6\u5e93\u3002",
    "search.noResults": "\u672a\u627e\u5230\u5339\u914d\u7684\u6587\u4ef6\u3002",

    "prompt.cancel": "\u53d6\u6d88",
    "prompt.create.title": "\u65b0\u5efa\u7b14\u8bb0",
    "prompt.create.eyebrow": "\u77e5\u8bc6\u5e93",
    "prompt.create.description": "\u8def\u5f84\u76f8\u5bf9\u4e8e\u77e5\u8bc6\u5e93\u6839\u76ee\u5f55\uff0c\u53ef\u7528 / \u5305\u542b\u5b50\u6587\u4ef6\u5939\u3002",
    "prompt.create.label": "\u6587\u4ef6\u8def\u5f84",
    "prompt.create.placeholder": "Untitled.md",
    "prompt.create.submit": "\u521b\u5efa",
    "prompt.create.submitBusy": "\u521b\u5efa\u4e2d\u2026",
    "prompt.rename.title": "\u91cd\u547d\u540d\u7b14\u8bb0",
    "prompt.rename.description": "\u8f93\u5165\u65b0\u8def\u5f84\uff0c\u9700\u8981\u7684\u5b50\u6587\u4ef6\u5939\u4f1a\u81ea\u52a8\u521b\u5efa\u3002",
    "prompt.rename.label": "\u65b0\u8def\u5f84",
    "prompt.rename.submit": "\u91cd\u547d\u540d",
    "prompt.rename.submitBusy": "\u91cd\u547d\u540d\u4e2d\u2026",
    "confirm.delete.title": "\u5220\u9664 {name}\uff1f",
    "confirm.delete.description": "\u6587\u4ef6\u5c06\u4ece\u77e5\u8bc6\u5e93\u4e2d\u79fb\u9664\u3002\u51e0\u79d2\u5185\u53ef\u4ece\u201c\u64a4\u9500\u201d\u63d0\u793a\u4e2d\u6062\u590d\u3002",
    "confirm.delete.submit": "\u5220\u9664",
    "confirm.delete.submitBusy": "\u5220\u9664\u4e2d\u2026",

    "qa.eyebrow": "AI \u63d0\u95ee",
    "qa.title": "\u5411\u77e5\u8bc6\u5e93\u63d0\u95ee",
    "qa.description": "\u57fa\u4e8e\u5df2\u7d22\u5f15\u7684 Markdown \u7b14\u8bb0\u751f\u6210\u7b54\u6848\uff0c\u5e76\u9644\u4e0a\u53ef\u67e5\u770b\u7684\u5f15\u7528\u3002",
    "qa.question": "\u95ee\u9898",
    "qa.placeholder": "\u4f8b\u5982\uff1a\u6211\u5728\u8fd9\u4e2a\u9879\u76ee\u91cc\u5199\u8fc7\u4ec0\u4e48\u2026",
    "qa.submit": "\u63d0\u95ee",
    "qa.submitBusy": "\u67e5\u8be2\u4e2d\u2026",
    "qa.runningHint": "\u67e5\u8be2\u8fdb\u884c\u4e2d\uff0c\u53ef\u968f\u65f6\u5207\u6362\u9875\u9762\u3002",
    "qa.answerEyebrow": "\u56de\u7b54",
    "qa.answerTitle": "\u54cd\u5e94",
    "qa.sourceLabel": "\u6765\u6e90\uff1a{name}",
    "qa.retrievalWarning": "\u68c0\u7d22\u8b66\u544a\uff1a{message}",
    "qa.providerWarning": "\u63d0\u4f9b\u65b9\u8b66\u544a\uff1a{message}",
    "qa.noCitations": "\u672a\u8fd4\u56de\u4efb\u4f55\u5f15\u7528\uff0c\u8bf7\u91cd\u5efa\u6216\u7ee7\u7eed\u7d22\u5f15\u540e\u91cd\u8bd5\u3002",

    "settings.loading": "\u52a0\u8f7d\u8bbe\u7f6e\u4e2d\u2026",
    "settings.eyebrowConfig": "\u914d\u7f6e",
    "settings.eyebrowKb": "\u77e5\u8bc6\u5e93",
    "settings.titleSettings": "\u8bbe\u7f6e",
    "settings.titleIndexing": "\u7d22\u5f15",
    "settings.descriptionSettings": "\u914d\u7f6e\u77e5\u8bc6\u5e93\u3001AI \u63d0\u4f9b\u65b9\u3001\u5bfc\u5165 / \u5bfc\u51fa\u3001HTTPS \u4ee5\u53ca\u7ba1\u7406\u5458\u8d26\u6237\u3002",
    "settings.descriptionIndexing": "\u6784\u5efa\u3001\u6062\u590d\u4ee5\u53ca\u76d1\u63a7\u4f9b Markdown \u77e5\u8bc6\u5e93\u4f7f\u7528\u7684 RAG \u68c0\u7d22\u7d22\u5f15\u3002",
    "settings.navAria": "\u8bbe\u7f6e\u533a\u57df",

    "settings.section.vault": "\u77e5\u8bc6\u5e93",
    "settings.section.providers": "AI \u63d0\u4f9b\u65b9",
    "settings.section.importExport": "\u5bfc\u5165 / \u5bfc\u51fa",
    "settings.section.https": "HTTPS",
    "settings.section.account": "\u8d26\u6237",

    "settings.account.eyebrow": "\u8eab\u4efd\u9a8c\u8bc1",
    "settings.account.title": "\u8d26\u6237",
    "settings.account.description": "\u66f4\u65b0\u672c\u9879\u76ee\u4f7f\u7528\u7684\u552f\u4e00\u7ba1\u7406\u5458\u8d26\u6237\u3002",
    "settings.account.username": "\u7528\u6237\u540d",
    "settings.account.newPassword": "\u65b0\u5bc6\u7801",
    "settings.account.save": "\u4fdd\u5b58\u8d26\u6237",
    "settings.account.saveBusy": "\u4fdd\u5b58\u4e2d\u2026",
    "settings.account.savedMessage": "\u8d26\u6237\u5df2\u4fdd\u5b58\uff0c\u73b0\u6709\u4f1a\u8bdd\u5df2\u6e05\u9664\u3002",
    "settings.account.saveError": "\u4fdd\u5b58\u8d26\u6237\u5931\u8d25",
    "settings.account.passwordHelp": "\u81f3\u5c11 8 \u4e2a\u5b57\u7b26\u3002",

    "settings.vault.eyebrow": "\u6587\u6863",
    "settings.vault.title": "Obsidian \u77e5\u8bc6\u5e93",
    "settings.vault.description": "\u9009\u62e9\u6587\u6863\u7ba1\u7406\u5668\u4f7f\u7528\u7684\u672c\u5730\u77e5\u8bc6\u5e93\u8def\u5f84\u3002",
    "settings.vault.path": "\u77e5\u8bc6\u5e93\u8def\u5f84",
    "settings.vault.allowPlain": "\u5141\u8bb8\u4f7f\u7528\u666e\u901a Markdown \u6587\u4ef6\u5939",
    "settings.vault.save": "\u4fdd\u5b58\u77e5\u8bc6\u5e93",
    "settings.vault.saveBusy": "\u4fdd\u5b58\u4e2d\u2026",
    "settings.vault.savedMessage": "\u77e5\u8bc6\u5e93\u8bbe\u7f6e\u5df2\u4fdd\u5b58",
    "settings.vault.saveError": "\u4fdd\u5b58\u77e5\u8bc6\u5e93\u5931\u8d25",

    "settings.https.eyebrow": "\u4f20\u8f93",
    "settings.https.title": "HTTPS \u8bc1\u4e66",
    "settings.https.description": "\u7c98\u8d34\u6216\u5bfc\u5165 PEM \u8bc1\u4e66\u4e0e\u79c1\u94a5\u6587\u4ef6\u3002\u4fdd\u5b58\u540e\u9700\u91cd\u542f\u670d\u52a1\u5668\u751f\u6548\u3002",
    "settings.https.enable": "\u91cd\u542f\u540e\u542f\u7528 HTTPS",
    "settings.https.statusConfigured": "\u5df2\u914d\u7f6e",
    "settings.https.statusNot": "\u672a\u914d\u7f6e",
    "settings.https.statusLine": "\u8bc1\u4e66\uff1a{cert} \u00b7 \u79c1\u94a5\uff1a{key}",
    "settings.https.cert": "\u8bc1\u4e66 PEM",
    "settings.https.certPlaceholder": "\u7c98\u8d34 -----BEGIN CERTIFICATE----- \u2026 \u7559\u7a7a\u5219\u4fdd\u7559\u73b0\u6709\u8bc1\u4e66\u3002",
    "settings.https.importCert": "\u5bfc\u5165\u8bc1\u4e66\u6587\u4ef6",
    "settings.https.privateKey": "\u79c1\u94a5 PEM",
    "settings.https.privateKeyPlaceholder": "\u7c98\u8d34 -----BEGIN PRIVATE KEY----- \u2026 \u7559\u7a7a\u5219\u4fdd\u7559\u73b0\u6709\u79c1\u94a5\u3002",
    "settings.https.importKey": "\u5bfc\u5165\u79c1\u94a5\u6587\u4ef6",
    "settings.https.save": "\u4fdd\u5b58 HTTPS \u8bbe\u7f6e",
    "settings.https.saveBusy": "\u4fdd\u5b58\u4e2d\u2026",
    "settings.https.savedMessage": "HTTPS \u8bbe\u7f6e\u5df2\u4fdd\u5b58\uff0c\u91cd\u542f\u670d\u52a1\u5668\u540e\u751f\u6548\u3002",
    "settings.https.saveError": "\u4fdd\u5b58 HTTPS \u8bbe\u7f6e\u5931\u8d25",

    "settings.providers.embeddingEyebrow": "\u5d4c\u5165",
    "settings.providers.embeddingTitle": "\u5d4c\u5165\u63d0\u4f9b\u65b9",
    "settings.providers.qaEyebrow": "\u5bf9\u8bdd",
    "settings.providers.qaTitle": "\u95ee\u7b54\u63d0\u4f9b\u65b9",
    "settings.providers.save": "\u4fdd\u5b58 AI \u63d0\u4f9b\u65b9",
    "settings.providers.saveBusy": "\u4fdd\u5b58\u4e2d\u2026",
    "settings.providers.savedMessage": "RAG \u8bbe\u7f6e\u5df2\u4fdd\u5b58",
    "settings.providers.saveError": "\u4fdd\u5b58 RAG \u8bbe\u7f6e\u5931\u8d25",
    "settings.providers.testEmbedding": "\u6d4b\u8bd5\u5d4c\u5165",
    "settings.providers.testEmbeddingBusy": "\u6d4b\u8bd5\u4e2d\u2026",
    "settings.providers.testQa": "\u6d4b\u8bd5\u95ee\u7b54",
    "settings.providers.testQaBusy": "\u6d4b\u8bd5\u4e2d\u2026",
    "settings.providers.testFailed": "\u6d4b\u8bd5\u5931\u8d25",
    "settings.providers.provider": "\u63d0\u4f9b\u65b9",
    "settings.providers.providerDisabled": "\u5df2\u7981\u7528",
    "settings.providers.providerOpenAi": "OpenAI \u517c\u5bb9",
    "settings.providers.apiMode": "API \u6a21\u5f0f",
    "settings.providers.apiModeEmbeddings": "Embeddings API\uff08/embeddings\uff09",
    "settings.providers.apiModeChat": "Chat Completions API\uff08/chat/completions\uff09",
    "settings.providers.apiModeResponses": "Responses API\uff08/responses\uff09",
    "settings.providers.apiModeCustomEmbedding": "\u81ea\u5b9a\u4e49\u5d4c\u5165\u517c\u5bb9\u8def\u5f84",
    "settings.providers.apiModeCustomChat": "\u81ea\u5b9a\u4e49\u5bf9\u8bdd\u517c\u5bb9\u8def\u5f84",
    "settings.providers.baseUrl": "\u57fa\u7840 URL",
    "settings.providers.endpointPath": "\u63a5\u53e3\u8def\u5f84",
    "settings.providers.reasoning": "\u63a8\u7406\u6a21\u5f0f",
    "settings.providers.reasoningDisabled": "\u7981\u7528\u63a8\u7406 / \u601d\u8003",
    "settings.providers.reasoningDefault": "\u63d0\u4f9b\u65b9\u9ed8\u8ba4",
    "settings.providers.reasoningHelp": "\u5bf9\u4e8e\u53ef\u80fd\u5728\u8f93\u51fa\u4ee4\u724c\u4e0a\u8017\u8d39\u8fc7\u591a\u7684\u63a8\u7406\u6a21\u578b\uff0c\u8bf7\u9009\u201c\u7981\u7528\u201d\u3002",
    "settings.providers.model": "\u6a21\u578b",
    "settings.providers.apiKey": "API Key",
    "settings.providers.apiKeyPlaceholder": "\u7559\u7a7a\u5219\u4fdd\u7559\u73b0\u6709\u5bc6\u94a5",

    "settings.ops.eyebrow": "\u68c0\u7d22\u7d22\u5f15",
    "settings.ops.title": "\u6784\u5efa\u7d22\u5f15",
    "settings.ops.description": "\u521b\u5efa Ask AI \u4f7f\u7528\u7684\u77e5\u8bc6\u5e93\u3002\u5efa\u8bae\u5148\u4ee5\u5c11\u91cf\u6837\u672c\u8bd5\u8dd1\uff0c\u7136\u540e\u4f7f\u7528\u589e\u91cf\u7d22\u5f15\u8fdb\u884c\u65e5\u5e38\u66f4\u65b0\u3002",
    "settings.ops.topK": "Top K",
    "settings.ops.chunkSize": "\u5206\u6bb5\u5927\u5c0f",
    "settings.ops.chunkOverlap": "\u5206\u6bb5\u91cd\u53e0",
    "settings.ops.batchSize": "\u5d4c\u5165\u6279\u6b21\u5927\u5c0f",
    "settings.ops.rpm": "\u5d4c\u5165\u8bf7\u6c42 / \u5206\u949f",
    "settings.ops.saveIndex": "\u4fdd\u5b58\u7d22\u5f15\u8bbe\u7f6e",
    "settings.ops.saveIndexBusy": "\u4fdd\u5b58\u4e2d\u2026",
    "settings.ops.testIndex": "\u8bd5\u8dd1 20 \u4e2a\u6587\u4ef6\u6837\u672c",
    "settings.ops.testIndexBusy": "\u542f\u52a8\u4e2d\u2026",
    "settings.ops.incremental": "\u5f00\u59cb\u589e\u91cf\u7d22\u5f15",
    "settings.ops.incrementalBusy": "\u542f\u52a8\u4e2d\u2026",
    "settings.ops.full": "\u91cd\u5efa\u5168\u91cf\u7d22\u5f15",
    "settings.ops.fullBusy": "\u542f\u52a8\u4e2d\u2026",
    "settings.ops.startedMessage": "\u5df2\u542f\u52a8 {mode} \u7d22\u5f15\u4efb\u52a1 {id}",
    "settings.ops.startError": "\u542f\u52a8\u7d22\u5f15\u5931\u8d25",
    "settings.ops.stopRequested": "\u5df2\u8bf7\u6c42\u505c\u6b62\u7d22\u5f15\u4efb\u52a1",
    "settings.ops.skipRequested": "\u5df2\u8bf7\u6c42\u8df3\u8fc7\u5f53\u524d\u6587\u4ef6",
    "settings.ops.controlError": "\u66f4\u65b0\u7d22\u5f15\u4efb\u52a1\u5931\u8d25",

    "settings.indexStatus.aria": "RAG \u7d22\u5f15\u72b6\u6001",
    "settings.indexStatus.production": "\u751f\u4ea7\u7d22\u5f15",
    "settings.indexStatus.test": "\u6d4b\u8bd5\u7d22\u5f15",
    "settings.indexStatus.indexed": "\u5df2\u7d22\u5f15",
    "settings.indexStatus.notIndexed": "\u672a\u7d22\u5f15",
    "settings.indexStatus.files": "{count} \u4e2a\u6587\u4ef6",
    "settings.indexStatus.chunks": "{count} \u4e2a\u5206\u6bb5",
    "settings.indexStatus.lastUpdated": "\u6700\u540e\u66f4\u65b0\uff1a{value}",
    "settings.indexStatus.never": "\u4ece\u672a",

    "settings.progress.test": "\u6d4b\u8bd5\u7d22\u5f15",
    "settings.progress.incremental": "\u589e\u91cf\u7d22\u5f15",
    "settings.progress.full": "\u5168\u91cf\u7d22\u5f15",
    "settings.progress.files": "\u6587\u4ef6",
    "settings.progress.chunks": "\u5206\u6bb5",
    "settings.progress.skippedFiles": "\u5df2\u8df3\u8fc7\u6587\u4ef6\uff1a{count}",
    "settings.progress.reusedChunks": "\u590d\u7528\u5206\u6bb5\uff1a{count}",
    "settings.progress.failedChunks": "\u5931\u8d25\u5206\u6bb5\uff1a{count}",
    "settings.progress.currentFile": "\u5f53\u524d\uff1a{name}",
    "settings.progress.skipCurrent": "\u8df3\u8fc7\u5f53\u524d\u6587\u4ef6",
    "settings.progress.skipRequestedShort": "\u5df2\u8bf7\u6c42\u8df3\u8fc7",
    "settings.progress.stop": "\u505c\u6b62\u7d22\u5f15",
    "settings.progress.stopping": "\u505c\u6b62\u4e2d\u2026",
    "settings.progress.elapsed": "{ms}\u00a0\u6beb\u79d2",
    "settings.jobStatus.queued": "\u6392\u961f\u4e2d",
    "settings.jobStatus.running": "\u8fd0\u884c\u4e2d",
    "settings.jobStatus.completed": "\u5df2\u5b8c\u6210",
    "settings.jobStatus.cancelled": "\u5df2\u53d6\u6d88",
    "settings.jobStatus.failed": "\u5df2\u5931\u8d25",
    "settings.message.dismiss": "\u5173\u95ed\u6d88\u606f",

    "settings.export.eyebrow": "\u5bfc\u51fa",
    "settings.export.title": "RAG \u5bfc\u51fa",
    "settings.export.description": "\u5bfc\u51fa\u7684\u914d\u7f6e\u4e0d\u5305\u542b\u771f\u5b9e API \u5bc6\u94a5\u3002",
    "settings.export.aria": "RAG \u914d\u7f6e\u5bfc\u51fa",
    "settings.export.copy": "\u590d\u5236\u5230\u526a\u8d34\u677f",
    "settings.export.copyBusy": "\u590d\u5236\u4e2d\u2026",
    "settings.export.copySuccess": "RAG \u914d\u7f6e\u5df2\u590d\u5236\u5230\u526a\u8d34\u677f",
    "settings.export.copyError": "\u526a\u8d34\u677f\u5199\u5165\u5931\u8d25\uff0c\u8bf7\u624b\u52a8\u590d\u5236\u5bfc\u51fa\u6587\u672c\u3002",
    "settings.export.toFile": "\u5bfc\u51fa\u5230\u6587\u4ef6",
    "settings.export.fileSavedMessage": "RAG \u914d\u7f6e\u5df2\u5bfc\u51fa\u5230\u6587\u4ef6",

    "settings.import.eyebrow": "\u5bfc\u5165",
    "settings.import.title": "RAG \u5bfc\u5165",
    "settings.import.description": "\u4ece\u526a\u8d34\u677f\u7c98\u8d34\u6216\u5bfc\u5165 schemaVersion 1 \u7684 RAG \u914d\u7f6e JSON \u6587\u4ef6\u3002",
    "settings.import.aria": "RAG \u914d\u7f6e\u5bfc\u5165",
    "settings.import.paste": "\u4ece\u526a\u8d34\u677f\u7c98\u8d34",
    "settings.import.pasteBusy": "\u7c98\u8d34\u4e2d\u2026",
    "settings.import.pasteSuccess": "RAG \u914d\u7f6e\u5df2\u4ece\u526a\u8d34\u677f\u7c98\u8d34",
    "settings.import.pasteError": "\u526a\u8d34\u677f\u8bfb\u53d6\u5931\u8d25\uff0c\u8bf7\u624b\u52a8\u7c98\u8d34\u914d\u7f6e\u3002",
    "settings.import.fromFile": "\u4ece\u6587\u4ef6\u5bfc\u5165",
    "settings.import.loadedFile": "\u5df2\u52a0\u8f7d {name}\uff0c\u68c0\u67e5\u540e\u70b9\u51fb\u201c\u5bfc\u5165 RAG \u914d\u7f6e\u201d\u3002",
    "settings.import.submit": "\u5bfc\u5165 RAG \u914d\u7f6e",
    "settings.import.submitBusy": "\u5bfc\u5165\u4e2d\u2026",
    "settings.import.success": "RAG \u914d\u7f6e\u5df2\u5bfc\u5165",
    "settings.import.failed": "\u5bfc\u5165\u5931\u8d25",

    "error.actionFailed": "\u64cd\u4f5c\u5931\u8d25"
  }
} as const satisfies Record<Locale, Record<string, string>>;

export type TKey = keyof typeof dictionaries.en;

function detectInitialLocale(): Locale {
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "zh") return stored;
  } catch {
    // ignore storage errors
  }
  const langs = typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : [];
  for (const lang of langs) {
    if (!lang) continue;
    const lower = lang.toLowerCase();
    if (lower.startsWith("zh")) return "zh";
    if (lower.startsWith("en")) return "en";
  }
  return "en";
}

interface LocaleContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: TKey, params?: Record<string, string | number>) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider(props: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectInitialLocale);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale === "zh" ? "zh-Hans" : "en";
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // ignore storage errors
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
  }, []);

  const t = useCallback(
    (key: TKey, params?: Record<string, string | number>) => {
      const dict = dictionaries[locale];
      const fallback = dictionaries.en;
      const template = (dict[key] ?? fallback[key] ?? key) as string;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (_, name: string) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : `{${name}}`
      );
    },
    [locale]
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <LocaleContext.Provider value={value}>{props.children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error("useLocale must be used within <LocaleProvider>");
  }
  return ctx;
}

export function useT() {
  return useLocale().t;
}
