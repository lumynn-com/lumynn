import { useEffect, useMemo, useState } from "react";
import type { AppSettings, ProviderSettings, RagIndexJob } from "../shared/types";
import { api } from "./api";

type SettingsSection = "account" | "vault" | "https" | "providers" | "operations" | "import-export";

export function SettingsView() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [message, setMessage] = useState("");
  const [section, setSection] = useState<SettingsSection>("vault");
  const [accountPassword, setAccountPassword] = useState("");
  const [httpsCertificate, setHttpsCertificate] = useState("");
  const [httpsPrivateKey, setHttpsPrivateKey] = useState("");
  const [importText, setImportText] = useState("");
  const [indexJob, setIndexJob] = useState<RagIndexJob | null>(null);

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
        if (job.status === "queued" || job.status === "running") {
          setSection("operations");
        }
      })
      .catch(() => undefined);

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!indexJob || (indexJob.status !== "queued" && indexJob.status !== "running")) {
      return;
    }

    const timer = window.setInterval(() => {
      api<RagIndexJob>(`/api/rag/index-jobs/${indexJob.id}`)
        .then(setIndexJob)
        .catch((error) => setMessage(error.message));
    }, 900);

    return () => window.clearInterval(timer);
  }, [indexJob]);

  const ragExport = useMemo(() => (settings ? JSON.stringify({ schemaVersion: 1, rag: settings.rag }, null, 2) : ""), [settings]);

  if (!settings) {
    return <main className="single-view panel">Loading settings...</main>;
  }

  async function saveAccount() {
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
  }

  async function saveVault() {
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
  }

  async function saveHttps() {
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
  }

  async function saveRag() {
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
  }

  async function test(url: string) {
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
  }

  async function startIndex(url: string, body?: Record<string, unknown>) {
    try {
      const job = await api<RagIndexJob>(url, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined
      });
      setIndexJob(job);
      setMessage(`Started ${job.mode} indexing job ${job.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to start indexing");
    }
  }

  async function controlIndexJob(action: "cancel" | "skip-current-file") {
    if (!indexJob) {
      return;
    }
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
  }

  async function importRagConfig() {
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
  }

  async function copyRagConfig() {
    try {
      await navigator.clipboard.writeText(ragExport);
      setMessage("RAG configuration copied to clipboard");
    } catch {
      setMessage("Clipboard write failed. Select the export text and copy it manually.");
    }
  }

  async function pasteRagConfig() {
    try {
      setImportText(await navigator.clipboard.readText());
      setMessage("RAG configuration pasted from clipboard");
    } catch {
      setMessage("Clipboard read failed. Paste the configuration manually.");
    }
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
    <main className="settings-view">
      <section className="panel">
        <p className="eyebrow">Configuration</p>
        <h1>Settings</h1>
        <p className="muted">Configure the active vault and RAG providers. Secret values are redacted after saving.</p>
      </section>
      <section className="settings-layout">
        <aside className="settings-nav panel">
          <button className={section === "account" ? "active" : ""} onClick={() => setSection("account")}>Account</button>
          <button className={section === "vault" ? "active" : ""} onClick={() => setSection("vault")}>Vault</button>
          <button className={section === "https" ? "active" : ""} onClick={() => setSection("https")}>HTTPS</button>
          <button className={section === "providers" ? "active" : ""} onClick={() => setSection("providers")}>RAG Providers</button>
          <button className={section === "operations" ? "active" : ""} onClick={() => setSection("operations")}>RAG Operations</button>
          <button className={section === "import-export" ? "active" : ""} onClick={() => setSection("import-export")}>Import / Export</button>
        </aside>

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
                <input value={settings.auth.username} onChange={(event) => setSettings({ ...settings, auth: { ...settings.auth, username: event.target.value } })} />
              </label>
              <label>
                New password
                <input type="password" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} />
              </label>
              <button className="primary" onClick={saveAccount} disabled={accountPassword.length < 8}>
                Save account
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
                <input value={settings.vault.path} onChange={(event) => setSettings({ ...settings, vault: { ...settings.vault, path: event.target.value } })} />
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
              <button className="primary" onClick={saveVault}>Save vault</button>
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
                  value={httpsCertificate}
                  placeholder="Paste -----BEGIN CERTIFICATE----- ... Leave blank to keep the existing certificate."
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
                  value={httpsPrivateKey}
                  placeholder="Paste -----BEGIN PRIVATE KEY----- ... Leave blank to keep the existing private key."
                  onChange={(event) => setHttpsPrivateKey(event.target.value)}
                />
              </label>
              <label className="file-button">
                Import private key file
                <input type="file" accept=".pem,.key,text/plain" onChange={(event) => event.target.files?.[0]?.text().then(setHttpsPrivateKey)} />
              </label>
              <div className="button-row">
                <button className="primary" onClick={saveHttps}>Save HTTPS settings</button>
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
                  <button className="primary" onClick={saveRag}>Save providers</button>
                  <button onClick={() => test("/api/settings/rag/test-embedding")}>Test embedding</button>
                </div>
              </div>
              <div className="panel form-panel">
                <div>
                  <p className="eyebrow">Chat</p>
                  <h2>Q&A Provider</h2>
                </div>
                <ProviderFields kind="qa" value={settings.rag.qa} onChange={(qa) => setSettings({ ...settings, rag: { ...settings.rag, qa } })} />
                <div className="button-row">
                  <button className="primary" onClick={saveRag}>Save providers</button>
                  <button onClick={() => test("/api/settings/rag/test-qa")}>Test Q&A</button>
                </div>
              </div>
            </section>
          ) : null}

          {section === "operations" ? (
            <section className="panel form-panel">
              <div>
                <p className="eyebrow">Retrieval</p>
                <h2>RAG Operations</h2>
                <p className="muted">Tune retrieval and Copilot-style batch indexing before running a full rebuild.</p>
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
              <div className="button-row">
                <button className="primary" onClick={saveRag}>Save retrieval</button>
                <button onClick={() => startIndex("/api/settings/rag/test-index", { sampleSize: 20 })}>Test index 20 files</button>
                <button onClick={() => startIndex("/api/rag/reindex/incremental")}>Incremental index</button>
                <button onClick={() => startIndex("/api/rag/reindex")}>Rebuild full index</button>
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
                <textarea className="config-box" value={ragExport} readOnly />
                <div className="button-row">
                  <button onClick={copyRagConfig}>Copy to clipboard</button>
                  <button onClick={exportRagConfigFile}>Export to file</button>
                </div>
              </div>
              <div className="panel form-panel">
                <div>
                  <p className="eyebrow">Import</p>
                  <h2>RAG Import</h2>
                  <p className="muted">Paste from clipboard or load a schemaVersion 1 RAG config JSON file.</p>
                </div>
                <textarea className="config-box" value={importText} onChange={(event) => setImportText(event.target.value)} />
                <div className="button-row">
                  <button onClick={pasteRagConfig}>Paste from clipboard</button>
                  <label className="file-button">
                    Import from file
                    <input type="file" accept="application/json,.json" onChange={(event) => importRagConfigFile(event.target.files?.[0])} />
                  </label>
                  <button className="primary" onClick={importRagConfig} disabled={!importText.trim()}>Import RAG config</button>
                </div>
              </div>
            </section>
          ) : null}
        </div>
      </section>
      {message ? <pre className="message">{message}</pre> : null}
    </main>
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
            {props.job.cancelRequested ? "Stopping..." : "Stop indexing"}
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
        <select value={props.value.provider} onChange={(event) => props.onChange({ ...props.value, provider: event.target.value as ProviderSettings["provider"] })}>
          <option value="disabled">Disabled</option>
          <option value="openai-compatible">OpenAI compatible</option>
        </select>
      </label>
      <label>
        API mode
        <select
          value={mode}
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
        <input value={props.value.baseUrl} placeholder="https://api.openai.com/v1" onChange={(event) => props.onChange({ ...props.value, baseUrl: event.target.value })} />
      </label>
      <label>
        Endpoint path
        <input
          value={endpointPath}
          placeholder={defaultEndpointPath(props.kind, mode)}
          onChange={(event) => props.onChange({ ...props.value, apiMode: mode, endpointPath: event.target.value })}
        />
      </label>
      {props.kind === "qa" ? (
        <label>
          Reasoning mode
          <select
            value={props.value.reasoningMode === "provider-default" ? "provider-default" : "disabled"}
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
        <input value={props.value.model} onChange={(event) => props.onChange({ ...props.value, model: event.target.value })} />
      </label>
      <label>
        API key
        <input type="password" placeholder="Leave blank to keep existing key" onChange={(event) => props.onChange({ ...props.value, apiKey: event.target.value })} />
      </label>
    </>
  );
}
