import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { DocumentsView } from "./DocumentsView";
import { SettingsView } from "./SettingsView";
import { BusyLabel } from "./icons";
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
  // Track viewport breakpoint here too: on desktop, indexing /
  // settings are rendered as overlay modals owned by
  // DocumentsView, so the legacy full-view fallback below should
  // never mount. Keeping this gate defends against any path
  // (deep link, dev tool, future code) that sets `view` to a
  // non-workspace value on a desktop layout.
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window === "undefined" ? false : window.matchMedia("(max-width: 860px)").matches
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 860px)");
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener?.("change", onChange);
    setIsMobile(mq.matches);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  // If the viewport flips from mobile to desktop while the user
  // is on a legacy settings / indexing view, snap back to the
  // workspace; the desktop affordance is the modal in
  // DocumentsView, not the full-view replacement.
  useEffect(() => {
    if (!isMobile && view !== "workspace") setView("workspace");
  }, [isMobile, view]);

  useEffect(() => {
    if (view === "settings") setSettingsMounted(true);
    if (view === "indexing") setIndexingMounted(true);
  }, [view]);

  // Measure the real rendered height of the active app chrome
  // and publish it as CSS custom properties. Desktop uses
  // .workspace-topbar; mobile uses .mobile-app-bar. The CSS uses
  // these values for all "fill the viewport minus topbar" sizing
  // instead of guessing magic numbers like 50/64/74px; otherwise
  // Android/iOS can pick up a few pixels of body overflow when
  // the rendered app bar is taller than the guess.
  useEffect(() => {
    const root = document.documentElement;
    const observedChrome = new Set<HTMLElement>();
    const standalone = window.matchMedia("(display-mode: standalone)").matches || Boolean(("standalone" in navigator) && navigator.standalone);
    const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    root.dataset.standalone = standalone ? "true" : "false";
    root.dataset.ios = iOS ? "true" : "false";
    function visibleHeight(selector: string) {
      const node = document.querySelector<HTMLElement>(selector);
      if (!node) return 0;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return 0;
      return Math.ceil(node.getBoundingClientRect().height);
    }
    function viewportHeight() {
      const visualHeight = window.visualViewport?.height ?? 0;
      const layoutHeight = window.innerHeight || root.clientHeight || 0;
      const screenHeight = window.screen?.height ?? 0;
      // iOS standalone Web Apps can report a too-small visualViewport
      // until the first user scroll/touch. In standalone mode there is no
      // browser address bar to reserve, so seed the layout from the
      // physical screen height instead of waiting for Safari's first
      // interaction-driven viewport correction.
      if (standalone && iOS) {
        return Math.ceil(Math.max(visualHeight, layoutHeight, screenHeight));
      }
      return Math.ceil(standalone ? Math.max(visualHeight, layoutHeight) : (visualHeight || layoutHeight));
    }
    function setChromeHeights() {
      const desktopTopbarH = visibleHeight(".workspace-topbar");
      const mobileAppbarH = visibleHeight(".mobile-app-bar");
      root.style.setProperty("--owd-topbar-h", `${desktopTopbarH}px`);
      root.style.setProperty("--owd-mobile-appbar-h", `${mobileAppbarH}px`);
      root.style.setProperty("--owd-viewport-h", `${viewportHeight()}px`);
    }
    const ro = new ResizeObserver(setChromeHeights);
    function observeChrome() {
      document.querySelectorAll<HTMLElement>(".workspace-topbar, .mobile-app-bar").forEach((node) => {
        if (observedChrome.has(node)) return;
        observedChrome.add(node);
        ro.observe(node);
      });
    }
    function refreshSoon() {
      observeChrome();
      setChromeHeights();
    }
    refreshSoon();
    const raf = window.requestAnimationFrame(refreshSoon);
    const timers = [100, 350, 800, 1500].map((delay) => window.setTimeout(refreshSoon, delay));
    const mo = new MutationObserver(refreshSoon);
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", setChromeHeights);
    window.addEventListener("orientationchange", refreshSoon);
    window.addEventListener("pageshow", refreshSoon);
    document.addEventListener("visibilitychange", refreshSoon);
    window.visualViewport?.addEventListener("resize", setChromeHeights);
    window.visualViewport?.addEventListener("scroll", setChromeHeights);
    return () => {
      window.cancelAnimationFrame(raf);
      timers.forEach((timer) => window.clearTimeout(timer));
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener("resize", setChromeHeights);
      window.removeEventListener("orientationchange", refreshSoon);
      window.removeEventListener("pageshow", refreshSoon);
      document.removeEventListener("visibilitychange", refreshSoon);
      window.visualViewport?.removeEventListener("resize", setChromeHeights);
      window.visualViewport?.removeEventListener("scroll", setChromeHeights);
    };
    // re-run when locale/theme/user/view changes might alter app bar layout
  }, [theme, locale, props.username, props.role, view]);

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
      {/* Desktop no longer renders a workspace topbar. All global
          actions (workspace / indexing / settings nav, theme,
          language, logout) live inside the editor panel's "\u22ef"
          command sheet, mirroring the mobile experience. The
          chrome height publisher above still measures the (now
          missing) topbar; visibleHeight() will return 0 and CSS
          will allocate the entire viewport to main content. */}
      <div id="main-content" className="main-content">
        <div hidden={view !== "workspace"} style={{ display: view === "workspace" ? undefined : "none" }}>
          <DocumentsView
            currentView={view}
            theme={theme}
            loggingOut={loggingOut}
            username={props.username}
            role={props.role}
            onSwitchView={setView}
            onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
            onLogout={logout}
          />
        </div>
        {/* Mobile-only legacy full-view fallback for indexing /
            settings. On desktop the same destinations open as
            modals owned by DocumentsView (so the user can dismiss
            and return to the editor without losing context), and
            the gate below makes sure those legacy mounts can
            never appear on desktop, keeping the DOM lean and the
            tab order free of hidden duplicates. */}
        {isMobile && indexingMounted ? (
          <div hidden={view !== "indexing"} style={{ display: view === "indexing" ? undefined : "none" }}>
            <SettingsView mode="indexing" role={props.role} onBackToWorkspace={() => setView("workspace")} />
          </div>
        ) : null}
        {isMobile && settingsMounted ? (
          <div hidden={view !== "settings"} style={{ display: view === "settings" ? undefined : "none" }}>
            <SettingsView mode="settings" role={props.role} onBackToWorkspace={() => setView("workspace")} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
