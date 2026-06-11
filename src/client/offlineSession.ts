import type { UserRole } from "../shared/types";

const OFFLINE_AUTH_KEY = "lumynn_offline_auth:v1";

export interface OfflineAuthState {
  authenticated: true;
  username: string;
  role: UserRole;
  offline: true;
  savedAt: string;
}

export function saveOfflineAuth(state: { authenticated: boolean; username: string | null; role: UserRole | null }): void {
  if (typeof window === "undefined" || !state.authenticated || !state.username || !state.role) return;
  const offlineState: OfflineAuthState = {
    authenticated: true,
    username: state.username,
    role: state.role,
    offline: true,
    savedAt: new Date().toISOString()
  };
  try {
    window.localStorage.setItem(OFFLINE_AUTH_KEY, JSON.stringify(offlineState));
  } catch {
    // ignore quota/private-mode failures
  }
  notifyServiceWorkerUser(state.username);
}

export function readOfflineAuth(): OfflineAuthState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(OFFLINE_AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OfflineAuthState>;
    if (!parsed.username || (parsed.role !== "admin" && parsed.role !== "user")) return null;
    return {
      authenticated: true,
      username: parsed.username,
      role: parsed.role,
      offline: true,
      savedAt: parsed.savedAt ?? new Date(0).toISOString()
    };
  } catch {
    return null;
  }
}

export function clearOfflineAuth(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(OFFLINE_AUTH_KEY);
  } catch {
    // ignore
  }
  clearServiceWorkerUser();
}

export function notifyServiceWorkerUser(username: string): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const message = { type: "LUMYNN_ACTIVE_USER", username };
  navigator.serviceWorker.controller?.postMessage(message);
  navigator.serviceWorker.ready
    .then((registration) => registration.active?.postMessage(message))
    .catch(() => undefined);
}

export function clearServiceWorkerUser(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const message = { type: "LUMYNN_CLEAR_ACTIVE_USER" };
  navigator.serviceWorker.controller?.postMessage(message);
  navigator.serviceWorker.ready
    .then((registration) => registration.active?.postMessage(message))
    .catch(() => undefined);
}
