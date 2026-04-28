import { useEffect, useState } from "react";
import { api } from "./api";
import { DocumentsView } from "./DocumentsView";
import { SettingsView } from "./SettingsView";

type View = "workspace" | "indexing" | "settings";

export function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loginError, setLoginError] = useState("");

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
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      setAuthenticated(true);
      setNeedsSetup(false);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Login failed");
    }
  }

  if (!authenticated) {
    return <LoginPage needsSetup={needsSetup} error={loginError} onLogin={handleLogin} />;
  }

  return <Workspace onLogout={() => setAuthenticated(false)} />;
}

function LoginPage(props: { needsSetup: boolean; error: string; onLogin: (username: string, password: string) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  return (
    <main className="login-shell">
      <section className="login-card">
        <p className="eyebrow">Obsidian Web Docs</p>
        <h1>{props.needsSetup ? "Create your admin password" : "Welcome back"}</h1>
        <p className="muted">
          Manage a plain-text Markdown vault with preview, settings, and RAG Q&A from a modern web interface.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            props.onLogin(username, password);
          }}
        >
          <label>
            Username
            <input name="username" autoComplete="username" spellCheck={false} value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete={props.needsSetup ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {props.error ? <div className="error" aria-live="polite">{props.error}</div> : null}
          <button className="primary" type="submit">
            {props.needsSetup ? "Create Account" : "Log In"}
          </button>
        </form>
      </section>
    </main>
  );
}

function Workspace(props: { onLogout: () => void }) {
  const [view, setView] = useState<View>("workspace");
  const [theme, setTheme] = useState<"dark" | "light">(() => (localStorage.getItem("owd_theme") === "light" ? "light" : "dark"));

  useEffect(() => {
    document.body.dataset.theme = theme;
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("owd_theme", theme);
  }, [theme]);

  async function logout() {
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
          <button className={view === "workspace" ? "active" : ""} onClick={() => setView("workspace")}>
            <span aria-hidden="true">D</span>
            <span className="nav-label">Workspace</span>
          </button>
          <button className={view === "indexing" ? "active" : ""} onClick={() => setView("indexing")}>
            <span aria-hidden="true">I</span>
            <span className="nav-label">Indexing</span>
          </button>
          <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>
            <span aria-hidden="true">S</span>
            <span className="nav-label">Settings</span>
          </button>
        </nav>
        <div className="topbar-actions">
          <button className="ghost" aria-label="Toggle Theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "Light Theme" : "Dark Theme"}
          </button>
          <button className="ghost" onClick={logout}>
            Log Out
          </button>
        </div>
      </header>
      <div id="main-content" className="main-content">
        {view === "workspace" ? <DocumentsView /> : null}
        {view === "indexing" ? <SettingsView mode="indexing" /> : null}
        {view === "settings" ? <SettingsView mode="settings" /> : null}
      </div>
    </div>
  );
}
