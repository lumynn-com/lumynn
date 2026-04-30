import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { DocumentsView } from "./DocumentsView";
import { SettingsView } from "./SettingsView";
import { IndexingIcon, SettingsIcon, WorkspaceIcon } from "./icons";

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
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const submitLabel = props.needsSetup ? "Create Account" : "Log In";
  const submitLoadingLabel = props.needsSetup ? "Creating Account\u2026" : "Logging In\u2026";

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
        <p className="eyebrow">Obsidian Web Docs</p>
        <h1>{props.needsSetup ? "Create your admin password" : "Welcome back"}</h1>
        <p className="muted">
          Manage a plain-text Markdown vault with preview, settings, and RAG Q&amp;A from a modern web interface.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.loading) {
              props.onLogin(username, password);
            }
          }}
        >
          <label>
            Username
            <input name="username" autoComplete="username" spellCheck={false} value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label>
            Password
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
            {props.loading ? submitLoadingLabel : submitLabel}
          </button>
        </form>
      </section>
    </main>
  );
}

function Workspace(props: { onLogout: () => void }) {
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
      <a className="skip-link" href="#main-content">Skip to Main Content</a>
      <header className="workspace-topbar">
        <button className="brand topbar-brand" type="button" onClick={() => setView("workspace")} aria-label="Open workspace">
          <span className="logo" aria-hidden="true">OW</span>
          <div>
            <strong>Obsidian Web</strong>
            <span>Markdown vault</span>
          </div>
        </button>
        <nav className="top-nav" aria-label="Primary">
          <button
            className={view === "workspace" ? "active" : ""}
            onClick={() => setView("workspace")}
            aria-current={view === "workspace" ? "page" : undefined}
          >
            <span className="nav-icon" aria-hidden="true"><WorkspaceIcon /></span>
            <span className="nav-label">Workspace</span>
          </button>
          <button
            className={view === "indexing" ? "active" : ""}
            onClick={() => setView("indexing")}
            aria-current={view === "indexing" ? "page" : undefined}
          >
            <span className="nav-icon" aria-hidden="true"><IndexingIcon /></span>
            <span className="nav-label">Indexing</span>
          </button>
          <button
            className={view === "settings" ? "active" : ""}
            onClick={() => setView("settings")}
            aria-current={view === "settings" ? "page" : undefined}
          >
            <span className="nav-icon" aria-hidden="true"><SettingsIcon /></span>
            <span className="nav-label">Settings</span>
          </button>
        </nav>
        <div className="topbar-actions">
          <button className="ghost" aria-label="Toggle Theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "Light Theme" : "Dark Theme"}
          </button>
          <button className="ghost" onClick={logout} disabled={loggingOut} aria-busy={loggingOut}>
            {loggingOut ? "Logging Out\u2026" : "Log Out"}
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
