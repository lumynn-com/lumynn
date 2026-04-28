import { useEffect, useState } from "react";
import { api } from "./api";
import { DocumentsView } from "./DocumentsView";
import { QaView } from "./QaView";
import { SettingsView } from "./SettingsView";

type View = "docs" | "settings" | "qa";

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
            <input value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {props.error ? <div className="error">{props.error}</div> : null}
          <button className="primary" type="submit">
            {props.needsSetup ? "Create account" : "Log in"}
          </button>
        </form>
      </section>
    </main>
  );
}

function Workspace(props: { onLogout: () => void }) {
  const [view, setView] = useState<View>("docs");
  const [theme, setTheme] = useState<"dark" | "light">(() => (localStorage.getItem("owd_theme") === "light" ? "light" : "dark"));

  useEffect(() => {
    document.body.dataset.theme = theme;
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
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">OW</span>
          <div>
            <strong>Obsidian Web</strong>
            <span>Markdown vault</span>
          </div>
        </div>
        <nav>
          <button className={view === "docs" ? "active" : ""} onClick={() => setView("docs")}>
            Documents
          </button>
          <button className={view === "qa" ? "active" : ""} onClick={() => setView("qa")}>
            Q&A
          </button>
          <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>
            Settings
          </button>
        </nav>
        <button className="ghost" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          {theme === "dark" ? "Light theme" : "Dark theme"}
        </button>
        <button className="ghost" onClick={logout}>
          Log out
        </button>
      </aside>
      {view === "docs" ? <DocumentsView /> : null}
      {view === "settings" ? <SettingsView /> : null}
      {view === "qa" ? <QaView /> : null}
    </div>
  );
}
