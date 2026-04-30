import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppSettings, ProviderSettings, RagIndexJob, RagIndexStats } from "../shared/types";
import { api } from "./api";

type SettingsSection = "account" | "vault" | "https" | "providers" | "operations" | "import-export";
type SettingsMode = "settings" | "indexing";

const settingsSections: Array<{ id: SettingsSection; label: string }> = [
  { id: "vault", label: "Vault" },
  { id: "providers", label: "AI Providers" },
  { id: "import-export", label: "Import / Export" },
  { id: "https", label: "HTTPS" },
  { id: "account", label: "Account" }
];

export function SettingsView(props: { mode?: SettingsMode }) {
  const mode = props.mode ?? "settings";
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [message, setMessage] = useState("");
  const [section, setSection] = useState<SettingsSection>(mode === "indexing" ? "operations" : "vault");
  const [accountPassword, setAccountPassword] = useState("");
  const [httpsCertificate, setHttpsCertificate] = useState("");
  const [httpsPrivateKey, setHttpsPrivateKey] = useState("");
  const [importText, setImportText] = useState("");
  const [indexJob, setIndexJob] = useState<RagIndexJob | null>(null);
  const [indexStats, setIndexStats] = useState<RagIndexStats | null>(null);
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());

  const isBusy = useCallback((key: string) => busyKeys.has(key), [busyKeys]);
  const runBusy = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusyKeys((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
    try {
      return await fn();
    } finally {
      setBusyKeys((current) => {
        if (!current.has(key)) return current;
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, []);

  function refreshIndexStats() {
    api<RagIndexStats>("/api/rag/index-stats")
      .then(setIndexStats)
      .catch(() => undefined);
  }

  useEffect(() => {
    let mounted = true;

    api<AppSettings>("/api/settings")
      .then((loadedSettings) => {
        if (mounted) {
          setSettings(loadedSettings);
        }
      })
      .catch((error) => {
        if (mounted) {
          setMessage(error.message);
        }
      });

    api<RagIndexJob | null>("/api/rag/index-jobs/latest")
      .then((job) => {
        if (!mounted || !job) {
          return;
        }
        setIndexJob(job);
        if (mode === "indexing" && (job.status === "queued" || job.status === "running")) {
          setSection("operations");
        }
      })
      .catch(() => undefined);

    api<RagIndexStats>("/api/rag/index-stats")
      .then((stats) => {
        if (mounted) {
          setIndexStats(stats);
        }
      })
      .catch(() => undefined);

    return () => {
      mounted = false;
    };
  }, [mode]);

  useEffect(() => {
    if (!indexJob || (indexJob.status !== "queued" && indexJob.status !== "running")) {
      return;
    }

    const timer = window.setInterval(() => {
      api<RagIndexJob>(`/api/rag/index-jobs/${indexJob.id}`)
        .then((job) => {
          setIndexJob(job);
          if (job.status !== "queued" && job.status !== "running") {
            refreshIndexStats();
          }
        })
        .catch((error) => setMessage(error.message));
    }, 900);

    return () => window.clearInterval(timer);
  }, [indexJob]);

  const ragExport = useMemo(() => (settings ? JSON.stringify({ schemaVersion: 1, rag: settings.rag }, null, 2) : ""), [settings]);

  if (!settings) {
    return <main className="single-view panel">Loading settings\u2026</main>;
  }

  async function saveAccount() {
    await runBusy("save-account", async () => {
      try {
        await api("/api/settings/auth", {
          method: "PUT",
          body: JSON.stringify({ username: settings!.auth.username, password: accountPassword })
        });
        setAccountPassword("");
        setMessage("Account credentials saved. Existing sessions were cleared.");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to save account");
      }
    });
  }

  async function saveVault() {
    await runBusy("save-vault", async () => {
      try {
        const saved = await api<AppSettings>("/api/settings/vault", {
          method: "PUT",
          body: JSON.stringify(settings!.vault)
        });
        setSettings(saved);
        setMessage("Vault settings saved");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to save vault");
      }
    });
  }

  async function saveHttps() {
    await runBusy("save-https", async () => {
      try {
        const saved = await api<AppSettings>("/api/settings/https", {
          method: "PUT",
          body: JSON.stringify({
            enabled: settings!.https.enabled,
            certificate: httpsCertificate || undefined,
            privateKey: httpsPrivateKey || undefined
          })
        });
        setSettings(saved);
        setHttpsCertificate("");
        setHttpsPrivateKey("");
        setMessage("HTTPS settings saved. Restart the server for protocol changes to take effect.");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to save HTTPS settings");
      }
    });
  }

  async function saveRag(busyKey = "save-rag") {
    await runBusy(busyKey, async () => {
      try {
        const saved = await api<AppSettings>("/api/settings/rag", {
          method: "PUT",
          body: JSON.stringify(settings!.rag)
        });
        setSettings(saved);
        setMessage("RAG settings saved");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to save RAG settings");
      }
    });
  }

  async function test(url: string, busyKey: string) {
    await runBusy(busyKey, async () => {
      try {
        const result = await api<Record<string, unknown>>(url, { method: "POST", body: JSON.stringify({ sampleSize: 20 }) });
        if (url.endsWith("/test-qa") && typeof result.reasoningDetected === "boolean") {
          setSettings({
            ...settings!,
            rag: {
              ...settings!.rag,
              qa: {
                ...settings!.rag.qa,
                reasoningDetected: result.reasoningDetected
              }
            }
          });
        }
        setMessage(JSON.stringify(result, null, 2));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Test failed");
      }
    });
  }

  async function startIndex(url: string, busyKey: string, body?: Record<string, unknown>) {
    await runBusy(busyKey, async () => {
      try {
        const job = await api<RagIndexJob>(url, {
          method: "POST",
          body: body ? JSON.stringify(body) : undefined
        });
        setIndexJob(job);
        refreshIndexStats();
        setMessage(`Started ${job.mode} indexing job ${job.id}`);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to start indexing");
      }
    });
  }

  async function controlIndexJob(action: "cancel" | "skip-current-file") {
    if (!indexJob) {
      return;
    }
    await runBusy(`index-${action}`, async () => {
      try {
        const updated = await api<RagIndexJob>(`/api/rag/index-jobs/${indexJob.id}/${action}`, {
          method: "POST",
          body: JSON.stringify({})
        });
        setIndexJob(updated);
        setMessage(action === "cancel" ? "Stop requested for indexing job" : "Skip requested for current file");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to update indexing job");
      }
    });
  }

  async function importRagConfig() {
    await runBusy("import-rag", async () => {
      try {
        const parsed = JSON.parse(importText);
        const saved = await api<AppSettings>("/api/settings/rag/import", {
          method: "POST",
          body: JSON.stringify(parsed)
        });
        setSettings(saved);
        setMessage("RAG configuration imported");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Import failed");
      }
    });
  }

  async function copyRagConfig() {
    await runBusy("copy-rag", async () => {
      try {
        await navigator.clipboard.writeText(ragExport);
        setMessage("RAG configuration copied to clipboard");
      } catch {
        setMessage("Clipboard write failed. Select the export text and copy it manually.");
      }
    });
  }

  async function pasteRagConfig() {
    await runBusy("paste-rag", async () => {
      try {
        setImportText(await navigator.clipboard.readText());
        setMessage("RAG configuration pasted from clipboard");
      } catch {
        setMessage("Clipboard read failed. Paste the configuration manually.");
      }
    });
  }

  function exportRagConfigFile() {
    const blob = new Blob([ragExport], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "rag-config.json";
    link.click();
    URL.revokeObjectURL(url);
    setMessage("RAG configuration exported to file");
  }

  async function importRagConfigFile(file: File | undefined) {
    if (!file) {
      return;
    }
    setImportText(await file.text());
    setMessage(`Loaded ${file.name}. Review it, then click Import RAG config.`);
  }

  return (
    <main className={`settings-view ${mode === "indexing" ? "indexing-view" : ""}`}>
      <section className="panel settings-hero">
        <p className="eyebrow">{mode === "indexing" ? "Knowledge Base" : "Configuration"}</p>
        <h1>{mode === "indexing" ? "Indexing" : "Settings"}</h1>
        <p className="muted">
          {mode === "indexing"
            ? "Build, resume, and monitor the searchable RAG index for your Markdown vault."
            : "Configure the vault, AI providers, import/export, HTTPS, and the admin account."}
        </p>
      </section>
      <section className="settings-layout">
        {mode === "settings" ? (
          <aside className="settings-nav panel" aria-label="Settings sections">
            {settingsSections.map((item) => (
              <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => setSection(item.id)}>
                {item.label}
              </button>
            ))}
          </aside>
        ) : null}

        <div className="settings-content">
          {section === "account" ? (
            <section className="panel form-panel">
              <div>
                <p className="eyebrow">Authentication</p>
                <h2>Account</h2>
                <p className="muted">Update the single admin account used by this MVP.</p>
              </div>
              <label>
                Username
                <input
                  name="account-username"
                  autoComplete="username"
                  spellCheck={false}
                  value={settings.auth.username}
                  onChange={(event) => setSettings({ ...settings, auth: { ...settings.auth, username: event.target.value } })}
                />
              </label>
              <label>
                New password
                <input
                  name="account-password"
                  type="password"
                  autoComplete="new-password"
                  value={accountPassword}
                  onChange={(event) => setAccountPassword(event.target.value)}
                />
              </label>
              <button
                className="primary"
                onClick={saveAccount}
                disabled={accountPassword.length < 8 || isBusy("save-account")}
                aria-busy={isBusy("save-account")}
              >
                {isBusy("save-account") ? "Saving\u2026" : "Save account"}
              </button>
            </section>
          ) : null}

          {section === "vault" ? (
            <section className="panel form-panel">
              <div>
                <p className="eyebrow">Documents</p>
                <h2>Obsidian Vault</h2>
                <p className="muted">Choose the filesystem vault used by the document manager.</p>
              </div>
              <label>
                Vault path
                <input
                  name="vault-path"
                  autoComplete="off"
                  spellCheck={false}
                  value={settings.vault.path}
                  onChange={(event) => setSettings({ ...settings, vault: { ...settings.vault, path: event.target.value } })}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.vault.allowPlainMarkdownFolder}
                  onChange={(event) => setSettings({ ...settings, vault: { ...settings.vault, allowPlainMarkdownFolder: event.target.checked } })}
                />
                Allow plain Markdown folders
              </label>
              {settings.vault.validation ? <div className="info-box">{settings.vault.validation.message}</div> : null}
              <button
                className="primary"
                onClick={saveVault}
                disabled={isBusy("save-vault")}
                aria-busy={isBusy("save-vault")}
              >
                {isBusy("save-vault") ? "Saving\u2026" : "Save vault"}
              </button>
            </section>
          ) : null}

          {section === "https" ? (
            <section className="panel form-panel">
              <div>
                <p className="eyebrow">Transport</p>
                <h2>HTTPS Certificate</h2>
                <p className="muted">Paste or import PEM certificate and private key files. A server restart is required after saving.</p>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.https.enabled}
                  onChange={(event) => setSettings({ ...settings, https: { ...settings.https, enabled: event.target.checked } })}
                />
                Enable HTTPS on server restart
              </label>
              <div className="info-box">
                Certificate: {settings.https.hasCertificate ? "configured" : "not configured"} · Private key: {settings.https.hasPrivateKey ? "configured" : "not configured"}
              </div>
              <label>
                Certificate PEM
                <textarea
                  className="config-box"
                  name="https-certificate"
                  spellCheck={false}
                  value={httpsCertificate}
                  placeholder={"Paste -----BEGIN CERTIFICATE----- \u2026 Leave blank to keep the existing certificate."}
                  onChange={(event) => setHttpsCertificate(event.target.value)}
                />
              </label>
              <label className="file-button">
                Import certificate file
                <input type="file" accept=".pem,.crt,.cert,text/plain" onChange={(event) => event.target.files?.[0]?.text().then(setHttpsCertificate)} />
              </label>
              <label>
                Private key PEM
                <textarea
                  className="config-box"
                  name="https-private-key"
                  spellCheck={false}
                  value={httpsPrivateKey}
                  placeholder={"Paste -----BEGIN PRIVATE KEY----- \u2026 Leave blank to keep the existing private key."}
                  onChange={(event) => setHttpsPrivateKey(event.target.value)}
                />
              </label>
              <label className="file-button">
                Import private key file
                <input type="file" accept=".pem,.key,text/plain" onChange={(event) => event.target.files?.[0]?.text().then(setHttpsPrivateKey)} />
              </label>
              <div className="button-row">
                <button
                  className="primary"
                  onClick={saveHttps}
                  disabled={isBusy("save-https")}
                  aria-busy={isBusy("save-https")}
                >
                  {isBusy("save-https") ? "Saving\u2026" : "Save HTTPS settings"}
                </button>
              </div>
            </section>
          ) : null}

          {section === "providers" ? (
            <section className="provider-grid">
              <div className="panel form-panel">
                <div>
                  <p className="eyebrow">Embeddings</p>
                  <h2>Embedding Provider</h2>
                </div>
                <ProviderFields kind="embedding" value={settings.rag.embedding} onChange={(embedding) => setSettings({ ...settings, rag: { ...settings.rag, embedding } })} />
                <div className="button-row">
                  <button
                    className="primary"
                    onClick={() => saveRag("save-rag-embedding")}
                    disabled={isBusy("save-rag-embedding")}
                    aria-busy={isBusy("save-rag-embedding")}
                  >
                    {isBusy("save-rag-embedding") ? "Saving\u2026" : "Save AI Providers"}
                  </button>
                  <button
                    onClick={() => test("/api/settings/rag/test-embedding", "test-embedding")}
                    disabled={isBusy("test-embedding")}
                    aria-busy={isBusy("test-embedding")}
                  >
                    {isBusy("test-embedding") ? "Testing\u2026" : "Test Embedding"}
                  </button>
                </div>
              </div>
              <div className="panel form-panel">
                <div>
                  <p className="eyebrow">Chat</p>
                  <h2>Q&A Provider</h2>
                </div>
                <ProviderFields kind="qa" value={settings.rag.qa} onChange={(qa) => setSettings({ ...settings, rag: { ...settings.rag, qa } })} />
                <div className="button-row">
                  <button
                    className="primary"
                    onClick={() => saveRag("save-rag-qa")}
                    disabled={isBusy("save-rag-qa")}
                    aria-busy={isBusy("save-rag-qa")}
                  >
                    {isBusy("save-rag-qa") ? "Saving\u2026" : "Save AI Providers"}
                  </button>
                  <button
                    onClick={() => test("/api/settings/rag/test-qa", "test-qa")}
                    disabled={isBusy("test-qa")}
                    aria-busy={isBusy("test-qa")}
                  >
                    {isBusy("test-qa") ? "Testing\u2026" : "Test Q&A"}
                  </button>
                </div>
              </div>
            </section>
          ) : null}

          {section === "operations" ? (
            <section className="panel form-panel">
              <div>
                <p className="eyebrow">Search Index</p>
                <h2>Build Index</h2>
                <p className="muted">Create the knowledge base used by Ask AI. Start with a small sample, then run incremental indexing for day-to-day updates.</p>
              </div>
              <div className="field-grid">
                <label>
                  Top K
                  <input
                    type="number"
                    value={settings.rag.retrieval.topK}
                    onChange={(event) =>
                      setSettings({ ...settings, rag: { ...settings.rag, retrieval: { ...settings.rag.retrieval, topK: Number(event.target.value) } } })
                    }
                  />
                </label>
                <label>
                  Chunk size
                  <input
                    type="number"
                    value={settings.rag.retrieval.chunkSize}
                    onChange={(event) =>
                      setSettings({ ...settings, rag: { ...settings.rag, retrieval: { ...settings.rag.retrieval, chunkSize: Number(event.target.value) } } })
                    }
                  />
                </label>
                <label>
                  Chunk overlap
                  <input
                    type="number"
                    value={settings.rag.retrieval.chunkOverlap}
                    onChange={(event) =>
                      setSettings({ ...settings, rag: { ...settings.rag, retrieval: { ...settings.rag.retrieval, chunkOverlap: Number(event.target.value) } } })
                    }
                  />
                </label>
                <label>
                  Embedding batch size
                  <input
                    type="number"
                    value={settings.rag.indexing.embeddingBatchSize}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        rag: {
                          ...settings.rag,
                          indexing: { ...settings.rag.indexing, embeddingBatchSize: Number(event.target.value) }
                        }
                      })
                    }
                  />
                </label>
                <label>
                  Embedding requests/min
                  <input
                    type="number"
                    value={settings.rag.indexing.embeddingRequestsPerMinute}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        rag: {
                          ...settings.rag,
                          indexing: { ...settings.rag.indexing, embeddingRequestsPerMinute: Number(event.target.value) }
                        }
                      })
                    }
                  />
                </label>
              </div>
              {indexStats ? <IndexStatus stats={indexStats} /> : null}
              <div className="button-row">
                <button
                  className="primary"
                  onClick={() => saveRag("save-rag-index")}
                  disabled={isBusy("save-rag-index")}
                  aria-busy={isBusy("save-rag-index")}
                >
                  {isBusy("save-rag-index") ? "Saving\u2026" : "Save Index Settings"}
                </button>
                <button
                  onClick={() => startIndex("/api/settings/rag/test-index", "start-test-index", { sampleSize: 20 })}
                  disabled={isBusy("start-test-index")}
                  aria-busy={isBusy("start-test-index")}
                >
                  {isBusy("start-test-index") ? "Starting\u2026" : "Index 20-File Sample"}
                </button>
                <button
                  onClick={() => startIndex("/api/rag/reindex/incremental", "start-incremental-index")}
                  disabled={isBusy("start-incremental-index")}
                  aria-busy={isBusy("start-incremental-index")}
                >
                  {isBusy("start-incremental-index") ? "Starting\u2026" : "Start Incremental Index"}
                </button>
                <button
                  onClick={() => startIndex("/api/rag/reindex", "start-full-index")}
                  disabled={isBusy("start-full-index")}
                  aria-busy={isBusy("start-full-index")}
                >
                  {isBusy("start-full-index") ? "Starting\u2026" : "Rebuild Full Index"}
                </button>
              </div>
              {indexJob ? <IndexProgress job={indexJob} onStop={() => controlIndexJob("cancel")} onSkipCurrentFile={() => controlIndexJob("skip-current-file")} /> : null}
            </section>
          ) : null}

          {section === "import-export" ? (
            <section className="import-export-grid">
              <div className="panel form-panel">
                <div>
                  <p className="eyebrow">Export</p>
                  <h2>RAG Export</h2>
                  <p className="muted">Exported config omits real API keys from normal settings responses.</p>
                </div>
                <textarea className="config-box" name="rag-export" value={ragExport} readOnly aria-label="RAG configuration export" />
                <div className="button-row">
                  <button onClick={copyRagConfig} disabled={isBusy("copy-rag")} aria-busy={isBusy("copy-rag")}>
                    {isBusy("copy-rag") ? "Copying\u2026" : "Copy to clipboard"}
                  </button>
                  <button onClick={exportRagConfigFile}>Export to file</button>
                </div>
              </div>
              <div className="panel form-panel">
                <div>
                  <p className="eyebrow">Import</p>
                  <h2>RAG Import</h2>
                  <p className="muted">Paste from clipboard or load a schemaVersion 1 RAG config JSON file.</p>
                </div>
                <textarea
                  className="config-box"
                  name="rag-import"
                  spellCheck={false}
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                  aria-label="RAG configuration import"
                />
                <div className="button-row">
                  <button onClick={pasteRagConfig} disabled={isBusy("paste-rag")} aria-busy={isBusy("paste-rag")}>
                    {isBusy("paste-rag") ? "Pasting\u2026" : "Paste from clipboard"}
                  </button>
                  <label className="file-button">
                    Import from file
                    <input type="file" accept="application/json,.json" onChange={(event) => importRagConfigFile(event.target.files?.[0])} />
                  </label>
                  <button
                    className="primary"
                    onClick={importRagConfig}
                    disabled={!importText.trim() || isBusy("import-rag")}
                    aria-busy={isBusy("import-rag")}
                  >
                    {isBusy("import-rag") ? "Importing\u2026" : "Import RAG config"}
                  </button>
                </div>
              </div>
            </section>
          ) : null}
        </div>
      </section>
      {message ? <pre className="message" aria-live="polite">{message}</pre> : null}
    </main>
  );
}

function formatDate(value: string | undefined): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

function IndexStatus(props: { stats: RagIndexStats }) {
  const items = [
    { label: "Production Index", stats: props.stats.production },
    { label: "Test Index", stats: props.stats.test }
  ];

  return (
    <div className="index-status-grid" aria-label="RAG index status">
      {items.map((item) => (
        <article key={item.label} className={`index-status-card ${item.stats.hasIndex ? "ready" : "empty"}`}>
          <div>
            <p className="eyebrow">{item.label}</p>
            <h3>{item.stats.hasIndex ? "Indexed" : "Not Indexed"}</h3>
          </div>
          <div className="index-status-metrics">
            <span>{item.stats.fileCount} files</span>
            <span>{item.stats.chunkCount} chunks</span>
          </div>
          <small>Last updated: {formatDate(item.stats.updatedAt)}</small>
        </article>
      ))}
    </div>
  );
}

function IndexProgress(props: { job: RagIndexJob; onStop: () => void; onSkipCurrentFile: () => void }) {
  const filePercent = props.job.totalFiles > 0 ? Math.round((props.job.processedFiles / props.job.totalFiles) * 100) : 0;
  const chunkPercent = props.job.totalChunks > 0 ? Math.round((props.job.embeddedChunks / props.job.totalChunks) * 100) : 0;
  const canControl = props.job.status === "queued" || props.job.status === "running";

  return (
    <div className={`index-progress ${props.job.status}`}>
      <div className="progress-header">
        <div>
          <strong>{props.job.mode === "test" ? "Test index" : props.job.mode === "incremental" ? "Incremental index" : "Full index"}</strong>
          <span>{props.job.status}</span>
        </div>
        <small>{props.job.elapsedMs ? `${props.job.elapsedMs} ms` : props.job.namespace}</small>
      </div>
      <div className="progress-row">
        <span>Files</span>
        <progress value={props.job.processedFiles} max={Math.max(1, props.job.totalFiles)} />
        <span>{props.job.processedFiles}/{props.job.totalFiles} ({filePercent}%)</span>
      </div>
      <div className="progress-row">
        <span>Chunks</span>
        <progress value={props.job.embeddedChunks} max={Math.max(1, props.job.totalChunks)} />
        <span>{props.job.embeddedChunks}/{props.job.totalChunks} ({chunkPercent}%)</span>
      </div>
      <div className="progress-details">
        <span>Skipped files: {props.job.skippedFiles}</span>
        <span>Reused chunks: {props.job.reusedChunks}</span>
        <span>Failed chunks: {props.job.failedChunks}</span>
        {props.job.currentFile ? <span>Current: {props.job.currentFile}</span> : null}
      </div>
      {canControl ? (
        <div className="button-row">
          <button onClick={props.onSkipCurrentFile} disabled={!props.job.currentFile || props.job.skipRequested || props.job.cancelRequested}>
            {props.job.skipRequested ? "Skip requested" : "Skip current file"}
          </button>
          <button onClick={props.onStop} disabled={props.job.cancelRequested}>
            {props.job.cancelRequested ? "Stopping\u2026" : "Stop indexing"}
          </button>
        </div>
      ) : null}
      <p className="muted">{props.job.error ?? props.job.message}</p>
    </div>
  );
}

function defaultEndpointPath(kind: "embedding" | "qa", mode: ProviderSettings["apiMode"]): string {
  if (kind === "embedding") {
    return "/embeddings";
  }
  return mode === "responses" ? "/responses" : "/chat/completions";
}

function ProviderFields(props: { kind: "embedding" | "qa"; value: ProviderSettings; onChange: (value: ProviderSettings) => void }) {
  const mode = props.value.apiMode ?? (props.kind === "embedding" ? "embeddings" : "chat-completions");
  const endpointPath = props.value.endpointPath ?? defaultEndpointPath(props.kind, mode);

  return (
    <>
      <label>
        Provider
        <select name={`${props.kind}-provider`} value={props.value.provider} onChange={(event) => props.onChange({ ...props.value, provider: event.target.value as ProviderSettings["provider"] })}>
          <option value="disabled">Disabled</option>
          <option value="openai-compatible">OpenAI compatible</option>
        </select>
      </label>
      <label>
        API mode
        <select
          value={mode}
          name={`${props.kind}-api-mode`}
          onChange={(event) => {
            const apiMode = event.target.value as ProviderSettings["apiMode"];
            props.onChange({
              ...props.value,
              apiMode,
              endpointPath: defaultEndpointPath(props.kind, apiMode)
            });
          }}
        >
          {props.kind === "embedding" ? (
            <>
              <option value="embeddings">Embeddings API (/embeddings)</option>
              <option value="custom">Custom embeddings-compatible path</option>
            </>
          ) : (
            <>
              <option value="chat-completions">Chat Completions API (/chat/completions)</option>
              <option value="responses">Responses API (/responses)</option>
              <option value="custom">Custom chat-completions-compatible path</option>
            </>
          )}
        </select>
      </label>
      <label>
        Base URL
        <input name={`${props.kind}-base-url`} type="url" inputMode="url" autoComplete="off" value={props.value.baseUrl} placeholder="https://api.openai.com/v1" onChange={(event) => props.onChange({ ...props.value, baseUrl: event.target.value })} />
      </label>
      <label>
        Endpoint path
        <input
          value={endpointPath}
          name={`${props.kind}-endpoint-path`}
          autoComplete="off"
          placeholder={defaultEndpointPath(props.kind, mode)}
          onChange={(event) => props.onChange({ ...props.value, apiMode: mode, endpointPath: event.target.value })}
        />
      </label>
      {props.kind === "qa" ? (
        <label>
          Reasoning mode
          <select
            value={props.value.reasoningMode === "provider-default" ? "provider-default" : "disabled"}
            name="qa-reasoning-mode"
            onChange={(event) => props.onChange({ ...props.value, reasoningMode: event.target.value as ProviderSettings["reasoningMode"] })}
          >
            <option value="disabled">Disable reasoning/thinking</option>
            <option value="provider-default">Provider default</option>
          </select>
          <small className="muted">Use disabled for reasoning models that may spend output tokens before the final answer.</small>
        </label>
      ) : null}
      <label>
        Model
        <input name={`${props.kind}-model`} autoComplete="off" spellCheck={false} value={props.value.model} onChange={(event) => props.onChange({ ...props.value, model: event.target.value })} />
      </label>
      <label>
        API key
        <input name={`${props.kind}-api-key`} type="password" autoComplete="off" spellCheck={false} placeholder="Leave blank to keep existing key" onChange={(event) => props.onChange({ ...props.value, apiKey: event.target.value })} />
      </label>
    </>
  );
}
