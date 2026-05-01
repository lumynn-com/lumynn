import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppSettings, ProviderSettings, RagIndexJob, RagIndexStats } from "../shared/types";
import { api } from "./api";
import { BusyLabel } from "./icons";
import { useT } from "./i18n";
import type { TKey } from "./i18n";

type SettingsSection = "account" | "vault" | "https" | "providers" | "operations" | "import-export";
type SettingsMode = "settings" | "indexing";

const settingsSections: Array<{ id: SettingsSection; labelKey: TKey }> = [
  { id: "vault", labelKey: "settings.section.vault" },
  { id: "providers", labelKey: "settings.section.providers" },
  { id: "import-export", labelKey: "settings.section.importExport" },
  { id: "https", labelKey: "settings.section.https" },
  { id: "account", labelKey: "settings.section.account" }
];

export function SettingsView(props: { mode?: SettingsMode; onBackToWorkspace?: () => void }) {
  const t = useT();
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
    return <main className="single-view panel">{t("settings.loading")}</main>;
  }

  async function saveAccount() {
    await runBusy("save-account", async () => {
      try {
        await api("/api/settings/auth", {
          method: "PUT",
          body: JSON.stringify({ username: settings!.auth.username, password: accountPassword })
        });
        setAccountPassword("");
        setMessage(t("settings.account.savedMessage"));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : t("settings.account.saveError"));
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
        setMessage(t("settings.vault.savedMessage"));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : t("settings.vault.saveError"));
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
        setMessage(t("settings.https.savedMessage"));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : t("settings.https.saveError"));
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
        setMessage(t("settings.providers.savedMessage"));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : t("settings.providers.saveError"));
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
        setMessage(error instanceof Error ? error.message : t("settings.providers.testFailed"));
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
        setMessage(t("settings.ops.startedMessage", { mode: job.mode, id: job.id }));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : t("settings.ops.startError"));
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
        setMessage(action === "cancel" ? t("settings.ops.stopRequested") : t("settings.ops.skipRequested"));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : t("settings.ops.controlError"));
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
        setMessage(t("settings.import.success"));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : t("settings.import.failed"));
      }
    });
  }

  async function copyRagConfig() {
    await runBusy("copy-rag", async () => {
      try {
        await navigator.clipboard.writeText(ragExport);
        setMessage(t("settings.export.copySuccess"));
      } catch {
        setMessage(t("settings.export.copyError"));
      }
    });
  }

  async function pasteRagConfig() {
    await runBusy("paste-rag", async () => {
      try {
        setImportText(await navigator.clipboard.readText());
        setMessage(t("settings.import.pasteSuccess"));
      } catch {
        setMessage(t("settings.import.pasteError"));
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
    setMessage(t("settings.export.fileSavedMessage"));
  }

  async function importRagConfigFile(file: File | undefined) {
    if (!file) {
      return;
    }
    setImportText(await file.text());
    setMessage(t("settings.import.loadedFile", { name: file.name }));
  }

  return (
    <main className={`settings-view ${mode === "indexing" ? "indexing-view" : ""}`}>
      {props.onBackToWorkspace ? (
        <header className="mobile-app-bar settings-back-bar" aria-hidden={false}>
          <button
            type="button"
            className="icon-button"
            aria-label={t("nav.workspace")}
            onClick={props.onBackToWorkspace}
          >
            <span aria-hidden="true">{"\u2190"}</span>
          </button>
          <div className="mobile-app-bar-title">
            <strong>{mode === "indexing" ? t("settings.titleIndexing") : t("settings.titleSettings")}</strong>
          </div>
          <div style={{ width: 40 }} aria-hidden="true" />
        </header>
      ) : null}
      <section className="panel settings-hero">
        <p className="eyebrow">{mode === "indexing" ? t("settings.eyebrowKb") : t("settings.eyebrowConfig")}</p>
        <h1>{mode === "indexing" ? t("settings.titleIndexing") : t("settings.titleSettings")}</h1>
        <p className="muted">
          {mode === "indexing" ? t("settings.descriptionIndexing") : t("settings.descriptionSettings")}
        </p>
      </section>
      <section className="settings-layout">
        {mode === "settings" ? (
          <aside className="settings-nav panel" aria-label={t("settings.navAria")}>
            {settingsSections.map((item) => (
              <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => setSection(item.id)}>
                {t(item.labelKey)}
              </button>
            ))}
          </aside>
        ) : null}

        <div className="settings-content">
          {section === "account" ? (
            <section className="panel form-panel">
              <div>
                <p className="eyebrow">{t("settings.account.eyebrow")}</p>
                <h2>{t("settings.account.title")}</h2>
                <p className="muted">{t("settings.account.description")}</p>
              </div>
              <label>
                {t("settings.account.username")}
                <input
                  name="account-username"
                  autoComplete="username"
                  spellCheck={false}
                  value={settings.auth.username}
                  onChange={(event) => setSettings({ ...settings, auth: { ...settings.auth, username: event.target.value } })}
                />
              </label>
              <label>
                {t("settings.account.newPassword")}
                <input
                  name="account-password"
                  type="password"
                  autoComplete="new-password"
                  value={accountPassword}
                  onChange={(event) => setAccountPassword(event.target.value)}
                  aria-describedby="account-password-help"
                />
                <small id="account-password-help" className="muted">{t("settings.account.passwordHelp")}</small>
              </label>
              <button
                className="primary"
                onClick={saveAccount}
                disabled={accountPassword.length < 8 || isBusy("save-account")}
                aria-busy={isBusy("save-account")}
              >
                <BusyLabel busy={isBusy("save-account")} busyText={t("settings.account.saveBusy")}>{t("settings.account.save")}</BusyLabel>
              </button>
            </section>
          ) : null}

          {section === "vault" ? (
            <section className="panel form-panel">
              <div>
                <p className="eyebrow">{t("settings.vault.eyebrow")}</p>
                <h2>{t("settings.vault.title")}</h2>
                <p className="muted">{t("settings.vault.description")}</p>
              </div>
              <label>
                {t("settings.vault.path")}
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
                {t("settings.vault.allowPlain")}
              </label>
              {settings.vault.validation ? <div className="info-box">{settings.vault.validation.message}</div> : null}
              <button
                className="primary"
                onClick={saveVault}
                disabled={isBusy("save-vault")}
                aria-busy={isBusy("save-vault")}
              >
                <BusyLabel busy={isBusy("save-vault")} busyText={t("settings.vault.saveBusy")}>{t("settings.vault.save")}</BusyLabel>
              </button>
            </section>
          ) : null}

          {section === "https" ? (
            <section className="panel form-panel">
              <div>
                <p className="eyebrow">{t("settings.https.eyebrow")}</p>
                <h2>{t("settings.https.title")}</h2>
                <p className="muted">{t("settings.https.description")}</p>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.https.enabled}
                  onChange={(event) => setSettings({ ...settings, https: { ...settings.https, enabled: event.target.checked } })}
                />
                {t("settings.https.enable")}
              </label>
              <div className="info-box">
                {t("settings.https.statusLine", {
                  cert: settings.https.hasCertificate ? t("settings.https.statusConfigured") : t("settings.https.statusNot"),
                  key: settings.https.hasPrivateKey ? t("settings.https.statusConfigured") : t("settings.https.statusNot")
                })}
              </div>
              <label>
                {t("settings.https.cert")}
                <textarea
                  className="config-box"
                  name="https-certificate"
                  spellCheck={false}
                  value={httpsCertificate}
                  placeholder={t("settings.https.certPlaceholder")}
                  onChange={(event) => setHttpsCertificate(event.target.value)}
                />
              </label>
              <label className="file-button">
                {t("settings.https.importCert")}
                <input type="file" accept=".pem,.crt,.cert,text/plain" onChange={(event) => event.target.files?.[0]?.text().then(setHttpsCertificate)} />
              </label>
              <label>
                {t("settings.https.privateKey")}
                <textarea
                  className="config-box"
                  name="https-private-key"
                  spellCheck={false}
                  value={httpsPrivateKey}
                  placeholder={t("settings.https.privateKeyPlaceholder")}
                  onChange={(event) => setHttpsPrivateKey(event.target.value)}
                />
              </label>
              <label className="file-button">
                {t("settings.https.importKey")}
                <input type="file" accept=".pem,.key,text/plain" onChange={(event) => event.target.files?.[0]?.text().then(setHttpsPrivateKey)} />
              </label>
              <div className="button-row">
                <button
                  className="primary"
                  onClick={saveHttps}
                  disabled={isBusy("save-https")}
                  aria-busy={isBusy("save-https")}
                >
                  <BusyLabel busy={isBusy("save-https")} busyText={t("settings.https.saveBusy")}>{t("settings.https.save")}</BusyLabel>
                </button>
              </div>
            </section>
          ) : null}

          {section === "providers" ? (
            <section className="provider-grid">
              <div className="panel form-panel">
                <div>
                  <p className="eyebrow">{t("settings.providers.embeddingEyebrow")}</p>
                  <h2>{t("settings.providers.embeddingTitle")}</h2>
                </div>
                <ProviderFields kind="embedding" value={settings.rag.embedding} onChange={(embedding) => setSettings({ ...settings, rag: { ...settings.rag, embedding } })} />
                <div className="button-row">
                  <button
                    className="primary"
                    onClick={() => saveRag("save-rag-embedding")}
                    disabled={isBusy("save-rag-embedding")}
                    aria-busy={isBusy("save-rag-embedding")}
                  >
                    <BusyLabel busy={isBusy("save-rag-embedding")} busyText={t("settings.providers.saveBusy")}>{t("settings.providers.save")}</BusyLabel>
                  </button>
                  <button
                    onClick={() => test("/api/settings/rag/test-embedding", "test-embedding")}
                    disabled={isBusy("test-embedding")}
                    aria-busy={isBusy("test-embedding")}
                  >
                    <BusyLabel busy={isBusy("test-embedding")} busyText={t("settings.providers.testEmbeddingBusy")}>{t("settings.providers.testEmbedding")}</BusyLabel>
                  </button>
                </div>
              </div>
              <div className="panel form-panel">
                <div>
                  <p className="eyebrow">{t("settings.providers.qaEyebrow")}</p>
                  <h2>{t("settings.providers.qaTitle")}</h2>
                </div>
                <ProviderFields kind="qa" value={settings.rag.qa} onChange={(qa) => setSettings({ ...settings, rag: { ...settings.rag, qa } })} />
                <div className="button-row">
                  <button
                    className="primary"
                    onClick={() => saveRag("save-rag-qa")}
                    disabled={isBusy("save-rag-qa")}
                    aria-busy={isBusy("save-rag-qa")}
                  >
                    <BusyLabel busy={isBusy("save-rag-qa")} busyText={t("settings.providers.saveBusy")}>{t("settings.providers.save")}</BusyLabel>
                  </button>
                  <button
                    onClick={() => test("/api/settings/rag/test-qa", "test-qa")}
                    disabled={isBusy("test-qa")}
                    aria-busy={isBusy("test-qa")}
                  >
                    <BusyLabel busy={isBusy("test-qa")} busyText={t("settings.providers.testQaBusy")}>{t("settings.providers.testQa")}</BusyLabel>
                  </button>
                </div>
              </div>
            </section>
          ) : null}

          {section === "operations" ? (
            <section className="panel form-panel">
              <div>
                <p className="eyebrow">{t("settings.ops.eyebrow")}</p>
                <h2>{t("settings.ops.title")}</h2>
                <p className="muted">{t("settings.ops.description")}</p>
              </div>
              <div className="field-grid">
                <label>
                  {t("settings.ops.topK")}
                  <input
                    type="number"
                    value={settings.rag.retrieval.topK}
                    onChange={(event) =>
                      setSettings({ ...settings, rag: { ...settings.rag, retrieval: { ...settings.rag.retrieval, topK: Number(event.target.value) } } })
                    }
                  />
                </label>
                <label>
                  {t("settings.ops.chunkSize")}
                  <input
                    type="number"
                    value={settings.rag.retrieval.chunkSize}
                    onChange={(event) =>
                      setSettings({ ...settings, rag: { ...settings.rag, retrieval: { ...settings.rag.retrieval, chunkSize: Number(event.target.value) } } })
                    }
                  />
                </label>
                <label>
                  {t("settings.ops.chunkOverlap")}
                  <input
                    type="number"
                    value={settings.rag.retrieval.chunkOverlap}
                    onChange={(event) =>
                      setSettings({ ...settings, rag: { ...settings.rag, retrieval: { ...settings.rag.retrieval, chunkOverlap: Number(event.target.value) } } })
                    }
                  />
                </label>
                <label>
                  {t("settings.ops.batchSize")}
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
                  {t("settings.ops.rpm")}
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
              {indexStats ? <IndexStatus stats={indexStats} t={t} /> : null}
              <div className="button-row">
                <button
                  className="primary"
                  onClick={() => saveRag("save-rag-index")}
                  disabled={isBusy("save-rag-index")}
                  aria-busy={isBusy("save-rag-index")}
                >
                  <BusyLabel busy={isBusy("save-rag-index")} busyText={t("settings.ops.saveIndexBusy")}>{t("settings.ops.saveIndex")}</BusyLabel>
                </button>
                <button
                  onClick={() => startIndex("/api/settings/rag/test-index", "start-test-index", { sampleSize: 20 })}
                  disabled={isBusy("start-test-index")}
                  aria-busy={isBusy("start-test-index")}
                >
                  <BusyLabel busy={isBusy("start-test-index")} busyText={t("settings.ops.testIndexBusy")}>{t("settings.ops.testIndex")}</BusyLabel>
                </button>
                <button
                  onClick={() => startIndex("/api/rag/reindex/incremental", "start-incremental-index")}
                  disabled={isBusy("start-incremental-index")}
                  aria-busy={isBusy("start-incremental-index")}
                >
                  <BusyLabel busy={isBusy("start-incremental-index")} busyText={t("settings.ops.incrementalBusy")}>{t("settings.ops.incremental")}</BusyLabel>
                </button>
                <button
                  onClick={() => startIndex("/api/rag/reindex", "start-full-index")}
                  disabled={isBusy("start-full-index")}
                  aria-busy={isBusy("start-full-index")}
                >
                  <BusyLabel busy={isBusy("start-full-index")} busyText={t("settings.ops.fullBusy")}>{t("settings.ops.full")}</BusyLabel>
                </button>
              </div>
              {indexJob ? <IndexProgress job={indexJob} t={t} onStop={() => controlIndexJob("cancel")} onSkipCurrentFile={() => controlIndexJob("skip-current-file")} /> : null}
            </section>
          ) : null}

          {section === "import-export" ? (
            <section className="import-export-grid">
              <div className="panel form-panel">
                <div>
                  <p className="eyebrow">{t("settings.export.eyebrow")}</p>
                  <h2>{t("settings.export.title")}</h2>
                  <p className="muted">{t("settings.export.description")}</p>
                </div>
                <textarea className="config-box" name="rag-export" value={ragExport} readOnly aria-label={t("settings.export.aria")} />
                <div className="button-row">
                  <button onClick={copyRagConfig} disabled={isBusy("copy-rag")} aria-busy={isBusy("copy-rag")}>
                    <BusyLabel busy={isBusy("copy-rag")} busyText={t("settings.export.copyBusy")}>{t("settings.export.copy")}</BusyLabel>
                  </button>
                  <button onClick={exportRagConfigFile}>{t("settings.export.toFile")}</button>
                </div>
              </div>
              <div className="panel form-panel">
                <div>
                  <p className="eyebrow">{t("settings.import.eyebrow")}</p>
                  <h2>{t("settings.import.title")}</h2>
                  <p className="muted">{t("settings.import.description")}</p>
                </div>
                <textarea
                  className="config-box"
                  name="rag-import"
                  spellCheck={false}
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                  aria-label={t("settings.import.aria")}
                />
                <div className="button-row">
                  <button onClick={pasteRagConfig} disabled={isBusy("paste-rag")} aria-busy={isBusy("paste-rag")}>
                    <BusyLabel busy={isBusy("paste-rag")} busyText={t("settings.import.pasteBusy")}>{t("settings.import.paste")}</BusyLabel>
                  </button>
                  <label className="file-button">
                    {t("settings.import.fromFile")}
                    <input type="file" accept="application/json,.json" onChange={(event) => importRagConfigFile(event.target.files?.[0])} />
                  </label>
                  <button
                    className="primary"
                    onClick={importRagConfig}
                    disabled={!importText.trim() || isBusy("import-rag")}
                    aria-busy={isBusy("import-rag")}
                  >
                    <BusyLabel busy={isBusy("import-rag")} busyText={t("settings.import.submitBusy")}>{t("settings.import.submit")}</BusyLabel>
                  </button>
                </div>
              </div>
            </section>
          ) : null}
        </div>
      </section>
      {message ? (
        <div className="message-bar">
          <pre className="message" aria-live="polite">{message}</pre>
          <button
            type="button"
            className="message-dismiss"
            aria-label={t("settings.message.dismiss")}
            onClick={() => setMessage("")}
          >
            <span aria-hidden="true">{"\u00d7"}</span>
          </button>
        </div>
      ) : null}
    </main>
  );
}

type Translator = (key: TKey, params?: Record<string, string | number>) => string;

function formatDate(value: string | undefined, neverLabel: string): string {
  return value ? new Date(value).toLocaleString() : neverLabel;
}

function IndexStatus(props: { stats: RagIndexStats; t: Translator }) {
  const { t } = props;
  const items = [
    { labelKey: "settings.indexStatus.production" as TKey, stats: props.stats.production },
    { labelKey: "settings.indexStatus.test" as TKey, stats: props.stats.test }
  ];

  return (
    <div className="index-status-grid" aria-label={t("settings.indexStatus.aria")}>
      {items.map((item) => (
        <article key={item.labelKey} className={`index-status-card ${item.stats.hasIndex ? "ready" : "empty"}`}>
          <div>
            <p className="eyebrow">{t(item.labelKey)}</p>
            <h3>{item.stats.hasIndex ? t("settings.indexStatus.indexed") : t("settings.indexStatus.notIndexed")}</h3>
          </div>
          <div className="index-status-metrics">
            <span>{t("settings.indexStatus.files", { count: item.stats.fileCount })}</span>
            <span>{t("settings.indexStatus.chunks", { count: item.stats.chunkCount })}</span>
          </div>
          <small>{t("settings.indexStatus.lastUpdated", { value: formatDate(item.stats.updatedAt, t("settings.indexStatus.never")) })}</small>
        </article>
      ))}
    </div>
  );
}

function IndexProgress(props: { job: RagIndexJob; t: Translator; onStop: () => void; onSkipCurrentFile: () => void }) {
  const { t } = props;
  const filePercent = props.job.totalFiles > 0 ? Math.round((props.job.processedFiles / props.job.totalFiles) * 100) : 0;
  const chunkPercent = props.job.totalChunks > 0 ? Math.round((props.job.embeddedChunks / props.job.totalChunks) * 100) : 0;
  const canControl = props.job.status === "queued" || props.job.status === "running";
  const modeKey: TKey =
    props.job.mode === "test" ? "settings.progress.test"
    : props.job.mode === "incremental" ? "settings.progress.incremental"
    : "settings.progress.full";
  const statusKey: TKey | null =
    props.job.status === "queued" ? "settings.jobStatus.queued"
    : props.job.status === "running" ? "settings.jobStatus.running"
    : props.job.status === "completed" ? "settings.jobStatus.completed"
    : props.job.status === "cancelled" ? "settings.jobStatus.cancelled"
    : props.job.status === "failed" ? "settings.jobStatus.failed"
    : null;

  return (
    <div className={`index-progress ${props.job.status}`}>
      <div className="progress-header">
        <div>
          <strong>{t(modeKey)}</strong>
          <span>{statusKey ? t(statusKey) : props.job.status}</span>
        </div>
        <small>{props.job.elapsedMs ? t("settings.progress.elapsed", { ms: props.job.elapsedMs }) : props.job.namespace}</small>
      </div>
      <div className="progress-row">
        <span>{t("settings.progress.files")}</span>
        <progress value={props.job.processedFiles} max={Math.max(1, props.job.totalFiles)} />
        <span>{props.job.processedFiles}/{props.job.totalFiles} ({filePercent}%)</span>
      </div>
      <div className="progress-row">
        <span>{t("settings.progress.chunks")}</span>
        <progress value={props.job.embeddedChunks} max={Math.max(1, props.job.totalChunks)} />
        <span>{props.job.embeddedChunks}/{props.job.totalChunks} ({chunkPercent}%)</span>
      </div>
      <div className="progress-details">
        <span>{t("settings.progress.skippedFiles", { count: props.job.skippedFiles })}</span>
        <span>{t("settings.progress.reusedChunks", { count: props.job.reusedChunks })}</span>
        <span>{t("settings.progress.failedChunks", { count: props.job.failedChunks })}</span>
        {props.job.currentFile ? <span>{t("settings.progress.currentFile", { name: props.job.currentFile })}</span> : null}
      </div>
      {canControl ? (
        <div className="button-row">
          <button onClick={props.onSkipCurrentFile} disabled={!props.job.currentFile || props.job.skipRequested || props.job.cancelRequested}>
            {props.job.skipRequested ? t("settings.progress.skipRequestedShort") : t("settings.progress.skipCurrent")}
          </button>
          <button onClick={props.onStop} disabled={props.job.cancelRequested}>
            {props.job.cancelRequested ? t("settings.progress.stopping") : t("settings.progress.stop")}
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
  const t = useT();
  const mode = props.value.apiMode ?? (props.kind === "embedding" ? "embeddings" : "chat-completions");
  const endpointPath = props.value.endpointPath ?? defaultEndpointPath(props.kind, mode);

  return (
    <>
      <label>
        {t("settings.providers.provider")}
        <select name={`${props.kind}-provider`} value={props.value.provider} onChange={(event) => props.onChange({ ...props.value, provider: event.target.value as ProviderSettings["provider"] })}>
          <option value="disabled">{t("settings.providers.providerDisabled")}</option>
          <option value="openai-compatible">{t("settings.providers.providerOpenAi")}</option>
        </select>
      </label>
      <label>
        {t("settings.providers.apiMode")}
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
              <option value="embeddings">{t("settings.providers.apiModeEmbeddings")}</option>
              <option value="custom">{t("settings.providers.apiModeCustomEmbedding")}</option>
            </>
          ) : (
            <>
              <option value="chat-completions">{t("settings.providers.apiModeChat")}</option>
              <option value="responses">{t("settings.providers.apiModeResponses")}</option>
              <option value="custom">{t("settings.providers.apiModeCustomChat")}</option>
            </>
          )}
        </select>
      </label>
      <label>
        {t("settings.providers.baseUrl")}
        <input name={`${props.kind}-base-url`} type="url" inputMode="url" autoComplete="off" value={props.value.baseUrl} placeholder="https://api.openai.com/v1" onChange={(event) => props.onChange({ ...props.value, baseUrl: event.target.value })} />
      </label>
      <label>
        {t("settings.providers.endpointPath")}
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
          {t("settings.providers.reasoning")}
          <select
            value={props.value.reasoningMode === "provider-default" ? "provider-default" : "disabled"}
            name="qa-reasoning-mode"
            onChange={(event) => props.onChange({ ...props.value, reasoningMode: event.target.value as ProviderSettings["reasoningMode"] })}
          >
            <option value="disabled">{t("settings.providers.reasoningDisabled")}</option>
            <option value="provider-default">{t("settings.providers.reasoningDefault")}</option>
          </select>
          <small className="muted">{t("settings.providers.reasoningHelp")}</small>
        </label>
      ) : null}
      <label>
        {t("settings.providers.model")}
        <input name={`${props.kind}-model`} autoComplete="off" spellCheck={false} value={props.value.model} onChange={(event) => props.onChange({ ...props.value, model: event.target.value })} />
      </label>
      <label>
        {t("settings.providers.apiKey")}
        <input name={`${props.kind}-api-key`} type="password" autoComplete="off" spellCheck={false} placeholder={t("settings.providers.apiKeyPlaceholder")} onChange={(event) => props.onChange({ ...props.value, apiKey: event.target.value })} />
      </label>
    </>
  );
}
