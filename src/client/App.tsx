import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { DocumentsView } from "./DocumentsView";
import { SettingsView } from "./SettingsView";
import { BusyLabel, IndexingIcon, SettingsIcon, WorkspaceIcon } from "./icons";
import { useLocale } from "./i18n";
import type { UserRole } from "../shared/types";

type View = "workspace" | "indexing" | "settings";

interface AuthState {
  authenticated: boolean;
  username: string | null;
  role: UserRole | null;
  needsSetup: boolean;
}

export function App() {
  const [auth, setAuth] = useState<AuthState>({ authenticated: false, username: null, role: null, needsSetup: false });
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  useEffect(() => {
    api<AuthState>("/api/auth/me")
      .then((state) => {
        setAuth({
          authenticated: Boolean(state.authenticated),
          username: state.username ?? null,
          role: state.role ?? null,
          needsSetup: Boolean(state.needsSetup)
        });
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
      // Re-fetch /me so we pick up the freshly-resolved role and
      // username instead of guessing from the form input.
      const state = await api<AuthState>("/api/auth/me");
      setAuth({
        authenticated: Boolean(state.authenticated),
        username: state.username ?? null,
        role: state.role ?? null,
        needsSetup: false
      });
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Login failed");
    } finally {
      setLoginLoading(false);
    }
  }

  if (!auth.authenticated) {
    return (
      <LoginPage
        needsSetup={auth.needsSetup}
        error={loginError}
        loading={loginLoading}
        onLogin={handleLogin}
      />
    );
  }

  return (
    <Workspace
      username={auth.username ?? ""}
      role={auth.role ?? "user"}
      onLogout={() => setAuth({ authenticated: false, username: null, role: null, needsSetup: false })}
    />
  );
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

function Workspace(props: { username: string; role: UserRole; onLogout: () => void }) {
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

  // Measure the sticky topbar's real rendered height and publish
  // it as a CSS custom property `--owd-topbar-h`. The CSS uses
  // it for all "fill the viewport minus topbar" sizing instead
  // of guessing a magic number; otherwise the page picks up a
  // few pixels of overflow whenever the topbar is taller than
  // the guess (admin badge, button wrapping, safe-area-top,
  // larger-font themes...).
  useEffect(() => {
    const root = document.documentElement;
    function setTopbarHeight() {
      const topbar = document.querySelector<HTMLElement>(".workspace-topbar");
      const h = topbar ? Math.ceil(topbar.getBoundingClientRect().height) : 0;
      root.style.setProperty("--owd-topbar-h", `${h}px`);
    }
    setTopbarHeight();
    const ro = new ResizeObserver(setTopbarHeight);
    const topbar = document.querySelector<HTMLElement>(".workspace-topbar");
    if (topbar) ro.observe(topbar);
    window.addEventListener("resize", setTopbarHeight);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", setTopbarHeight);
    };
    // re-run when locale or theme might change topbar layout
  }, [theme, locale, props.username, props.role]);

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
      <header className="workspace-topbar desktop-only">
        <button className="brand topbar-brand" type="button" onClick={() => setView("workspace")} aria-label={t("app.openWorkspace")}>
          <img className="logo" src="/apple-touch-icon.png" alt="" width={36} height={36} aria-hidden="true" />
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
          <div className="topbar-user" aria-label={t("topbar.signedInAs", { name: props.username })}>
            <span className="topbar-user-name" translate="no">{props.username}</span>
            {props.role === "admin" ? <span className="topbar-user-badge">{t("topbar.adminBadge")}</span> : null}
          </div>
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
          <DocumentsView
            currentView={view}
            theme={theme}
            loggingOut={loggingOut}
            username={props.username}
            onSwitchView={setView}
            onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
            onLogout={logout}
          />
        </div>
        {indexingMounted ? (
          <div hidden={view !== "indexing"} style={{ display: view === "indexing" ? undefined : "none" }}>
            <SettingsView mode="indexing" role={props.role} onBackToWorkspace={() => setView("workspace")} />
          </div>
        ) : null}
        {settingsMounted ? (
          <div hidden={view !== "settings"} style={{ display: view === "settings" ? undefined : "none" }}>
            <SettingsView mode="settings" role={props.role} onBackToWorkspace={() => setView("workspace")} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
