import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { DocumentsView } from "./DocumentsView";
import { SettingsView } from "./SettingsView";
import { BusyLabel, IndexingIcon, SettingsIcon, WorkspaceIcon } from "./icons";
import { useLocale } from "./i18n";

type View = "workspace" | "indexing" | "settings";

export function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  useEffect(() => {
    api<{ authenticated: boolean; needsSetup: boolean }>("/api/auth/me")
      .then((state) => {
        setAuthenticated(state.authenticated);
        setNeedsSetup(state.needsSetup);
      })
      .catch(() => undefined);
  }, []);

  async function handleLogin(username: string, password: string) {
    setLoginError("");
    setLoginLoading(true);
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      setAuthenticated(true);
      setNeedsSetup(false);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Login failed");
    } finally {
      setLoginLoading(false);
    }
  }

  if (!authenticated) {
    return (
      <LoginPage
        needsSetup={needsSetup}
        error={loginError}
        loading={loginLoading}
        onLogin={handleLogin}
      />
    );
  }

  return <Workspace onLogout={() => setAuthenticated(false)} />;
}

function LoginPage(props: {
  needsSetup: boolean;
  error: string;
  loading: boolean;
  onLogin: (username: string, password: string) => void;
}) {
  const { t } = useLocale();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const submitLabel = props.needsSetup ? t("login.submitSetup") : t("login.submitLogin");
  const submitLoadingLabel = props.needsSetup ? t("login.submitSetupBusy") : t("login.submitLoginBusy");

  useEffect(() => {
    if (!props.error) return;
    const node = passwordRef.current;
    if (!node) return;
    node.focus();
    if (typeof node.setSelectionRange === "function") {
      node.setSelectionRange(0, node.value.length);
    }
  }, [props.error]);

  return (
    <main className="login-shell">
      <section className="login-card">
        <p className="eyebrow" translate="no">{t("login.eyebrow")}</p>
        <h1>{props.needsSetup ? t("login.titleSetup") : t("login.titleWelcome")}</h1>
        <p className="muted">{t("login.description")}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.loading) {
              props.onLogin(username, password);
            }
          }}
        >
          <label>
            {t("login.username")}
            <input name="username" autoComplete="username" spellCheck={false} value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label>
            {t("login.password")}
            <input
              ref={passwordRef}
              name="password"
              type="password"
              autoComplete={props.needsSetup ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={props.error ? true : undefined}
            />
          </label>
          {props.error ? <div className="error" role="alert" aria-live="assertive">{props.error}</div> : null}
          <button className="primary" type="submit" disabled={props.loading} aria-busy={props.loading}>
            <BusyLabel busy={props.loading} busyText={submitLoadingLabel}>{submitLabel}</BusyLabel>
          </button>
        </form>
      </section>
    </main>
  );
}

function Workspace(props: { onLogout: () => void }) {
  const { t, locale, setLocale } = useLocale();
  const [view, setView] = useState<View>("workspace");
  const [theme, setTheme] = useState<"dark" | "light">(() => (localStorage.getItem("owd_theme") === "light" ? "light" : "dark"));
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [indexingMounted, setIndexingMounted] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    if (view === "settings") setSettingsMounted(true);
    if (view === "indexing") setIndexingMounted(true);
  }, [view]);

  useEffect(() => {
    document.body.dataset.theme = theme;
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("owd_theme", theme);
  }, [theme]);

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      props.onLogout();
    }
  }

  return (
    <div className="app-shell obsidian-shell">
      <a className="skip-link" href="#main-content">{t("skipToMain")}</a>
      <header className="workspace-topbar">
        <button className="brand topbar-brand" type="button" onClick={() => setView("workspace")} aria-label={t("app.openWorkspace")}>
          <span className="logo" aria-hidden="true" translate="no">OW</span>
          <div>
            <strong translate="no">{t("app.brand.name")}</strong>
            <span>{t("app.brand.tagline")}</span>
          </div>
        </button>
        <nav className="top-nav" aria-label={t("nav.aria")}>
          <button
            className={view === "workspace" ? "active" : ""}
            onClick={() => setView("workspace")}
            aria-current={view === "workspace" ? "page" : undefined}
          >
            <span className="nav-icon" aria-hidden="true"><WorkspaceIcon /></span>
            <span className="nav-label">{t("nav.workspace")}</span>
          </button>
          <button
            className={view === "indexing" ? "active" : ""}
            onClick={() => setView("indexing")}
            aria-current={view === "indexing" ? "page" : undefined}
          >
            <span className="nav-icon" aria-hidden="true"><IndexingIcon /></span>
            <span className="nav-label">{t("nav.indexing")}</span>
          </button>
          <button
            className={view === "settings" ? "active" : ""}
            onClick={() => setView("settings")}
            aria-current={view === "settings" ? "page" : undefined}
          >
            <span className="nav-icon" aria-hidden="true"><SettingsIcon /></span>
            <span className="nav-label">{t("nav.settings")}</span>
          </button>
        </nav>
        <div className="topbar-actions">
          <div className="lang-switch" role="group" aria-label={t("topbar.language")}>
            <button
              type="button"
              className={locale === "en" ? "active" : ""}
              aria-pressed={locale === "en"}
              onClick={() => setLocale("en")}
            >
              EN
            </button>
            <button
              type="button"
              className={locale === "zh" ? "active" : ""}
              aria-pressed={locale === "zh"}
              onClick={() => setLocale("zh")}
              lang="zh-Hans"
            >
              {"\u4e2d\u6587"}
            </button>
          </div>
          <button className="ghost" aria-label={t("topbar.toggleTheme")} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? t("topbar.themeLight") : t("topbar.themeDark")}
          </button>
          <button className="ghost" onClick={logout} disabled={loggingOut} aria-busy={loggingOut}>
            <BusyLabel busy={loggingOut} busyText={t("topbar.logoutBusy")}>{t("topbar.logout")}</BusyLabel>
          </button>
        </div>
      </header>
      <div id="main-content" className="main-content">
        <div hidden={view !== "workspace"} style={{ display: view === "workspace" ? undefined : "none" }}>
          <DocumentsView />
        </div>
        {indexingMounted ? (
          <div hidden={view !== "indexing"} style={{ display: view === "indexing" ? undefined : "none" }}>
            <SettingsView mode="indexing" />
          </div>
        ) : null}
        {settingsMounted ? (
          <div hidden={view !== "settings"} style={{ display: view === "settings" ? undefined : "none" }}>
            <SettingsView mode="settings" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
