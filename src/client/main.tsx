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
// would refuse the registration anyway). Register as soon as the page
// load settles so the first successful visit seeds an offline shell.
if (
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  window.isSecureContext &&
  import.meta.env.MODE === "production"
) {
  const registerServiceWorker = () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  };

  window.addEventListener("load", registerServiceWorker, { once: true });
}
