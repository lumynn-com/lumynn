import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { LocaleProvider } from "./i18n";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </React.StrictMode>
);

// Register the service worker in production secure contexts only. We
// skip it in dev (Vite serves modules with `Cache-Control: no-store`
// so a SW would just get in the way) and on insecure origins (Chrome
// would refuse the registration anyway). In the authenticated
// workspace, wait for Muya to mount before doing this extra network
// request so the editor keeps first priority on cold start.
if (
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  window.isSecureContext &&
  import.meta.env.MODE === "production"
) {
  const registerServiceWorker = () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  };

  window.addEventListener("load", () => {
    if (window.performance.getEntriesByName("owd:muya-editor-ready").length > 0) {
      registerServiceWorker();
      return;
    }
    const fallback = window.setTimeout(registerServiceWorker, 8000);
    window.addEventListener(
      "owd:muya-editor-ready",
      () => {
        window.clearTimeout(fallback);
        registerServiceWorker();
      },
      { once: true }
    );
  });
}
