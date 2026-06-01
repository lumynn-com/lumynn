import bcrypt from "bcryptjs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { DEFAULT_RAG_INDEXING, DEFAULT_RAG_RETRIEVAL, type UserRole } from "../../shared/types";
import { config } from "../config";
import { newToken, sha256 } from "../crypto";
import { adminUsers, findUserByUsername, store, type UserRecord } from "../store";

const cookieName = "owd_session";
// Long-lived "remember me" sessions: cookies live for 90 days and
// the server-side record is bumped forward every time the session
// is used, so an active user effectively never has to log in
// again. A fully dormant session still expires (security
// hygiene), but anyone who opened the app within the last 90
// days stays signed in.
const sessionTtlMs = 1000 * 60 * 60 * 24 * 90;
// When more than half of the TTL has elapsed since `createdAt`,
// silently extend the session instead of letting it tick down
// toward expiry. Half is conservative: we don't rewrite the
// store on every request, only when meaningfully aged.
const sessionRefreshAfterMs = sessionTtlMs / 2;

// Bootstrap path for the very first install: when no users
// exist yet, the next successful login form POST creates the
// initial admin with the supplied username + password. After
// that, this function is a no-op.
export async function setInitialAdminIfMissing(username: string, password: string): Promise<UserRecord | null> {
  const data = await store.load();
  if (data.users.length > 0) {
    return null;
  }
  const now = new Date().toISOString();
  const admin: UserRecord = {
    username,
    role: "admin",
    passwordHash: await bcrypt.hash(password, 12),
    passwordUpdatedAt: now,
    createdAt: now,
    vault: {
      path: config.defaultVaultPath,
      allowPlainMarkdownFolder: true
    },
    rag: emptyRagSettingsForBootstrap(),
    createdAtByPath: {},
    metadataByPath: {}
  };
  data.users.push(admin);
  await store.save();
  return admin;
}

// Legacy-named shim used by the very-first-login path so the
// JSON shape doesn't import from store.ts back through
// authService.
function emptyRagSettingsForBootstrap() {
  return {
    embedding: { provider: "disabled" as const, apiMode: "embeddings" as const, endpointPath: "/embeddings", baseUrl: "", model: "", timeoutMs: 30000 },
    qa: { provider: "disabled" as const, apiMode: "chat-completions" as const, endpointPath: "/chat/completions", reasoningMode: "disabled" as const, reasoningDetected: false, baseUrl: "", model: "", timeoutMs: 30000 },
    retrieval: { ...DEFAULT_RAG_RETRIEVAL },
    indexing: { ...DEFAULT_RAG_INDEXING }
  };
}

export async function login(username: string, password: string): Promise<string | null> {
  const data = await store.load();
  const user = findUserByUsername(data, username);
  if (!user || !user.passwordHash) {
    return null;
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return null;
  }

  const token = newToken();
  const now = Date.now();
  data.sessions = data.sessions.filter((session) => Date.parse(session.expiresAt) > now);
  data.sessions.push({
    idHash: sha256(token),
    username,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + sessionTtlMs).toISOString()
  });
  await store.save();
  return token;
}

// Per-user password change. Verifies the current password, swaps
// in the new hash, then invalidates every other session for the
// user (keeping the calling session so they aren't logged out).
export async function changePassword(
  user: UserRecord,
  currentPassword: string,
  newPassword: string,
  currentSessionToken: string | undefined
): Promise<{ ok: true } | { error: string }> {
  if (!user.passwordHash) {
    return { error: "User has no password set" };
  }
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) {
    return { error: "Current password is incorrect" };
  }
  if (newPassword.length < 8) {
    return { error: "New password must be at least 8 characters" };
  }

  const data = await store.load();
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  user.passwordUpdatedAt = new Date().toISOString();
  // Drop every other session for this user. Keep the current
  // one so the user doesn't get bounced out of the app right
  // after changing their own password.
  const keepHash = currentSessionToken ? sha256(currentSessionToken) : null;
  data.sessions = data.sessions.filter((session) => session.username !== user.username || session.idHash === keepHash);
  await store.save();
  return { ok: true };
}

// Direct password reset, bypassing the current-password check.
// Used by the CLI escape hatch in src/server/cli/resetPassword.ts;
// also used by the legacy "first-run setup" flow on the very
// first login. Never exposed via the HTTP API.
export async function setPasswordDirect(user: UserRecord, newPassword: string): Promise<void> {
  if (newPassword.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const data = await store.load();
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  user.passwordUpdatedAt = new Date().toISOString();
  // A password reset done out-of-band (CLI) invalidates every
  // existing session for that user. They have to log in again.
  data.sessions = data.sessions.filter((session) => session.username !== user.username);
  await store.save();
}

export async function getCurrentUser(request: FastifyRequest, reply?: FastifyReply): Promise<UserRecord | null> {
  const token = request.cookies[cookieName];
  if (!token) {
    return null;
  }

  const data = await store.load();
  const hash = sha256(token);
  const now = Date.now();
  const session = data.sessions.find((item) => item.idHash === hash && Date.parse(item.expiresAt) > now);
  if (!session) {
    return null;
  }

  const user = findUserByUsername(data, session.username);
  if (!user) {
    // Session refers to a deleted user; clean it up so the next
    // request doesn't waste time on the same lookup.
    data.sessions = data.sessions.filter((item) => item.idHash !== hash);
    await store.save();
    return null;
  }

  // Sliding refresh: see the comment on sessionRefreshAfterMs.
  const age = now - Date.parse(session.createdAt);
  if (reply && age > sessionRefreshAfterMs) {
    session.createdAt = new Date(now).toISOString();
    session.expiresAt = new Date(now + sessionTtlMs).toISOString();
    data.sessions = data.sessions.filter((item) => Date.parse(item.expiresAt) > now);
    await store.save();
    setSessionCookie(reply, token);
  }

  return user;
}

export async function logout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[cookieName];
  if (token) {
    const data = await store.load();
    data.sessions = data.sessions.filter((session) => session.idHash !== sha256(token));
    await store.save();
  }
  reply.clearCookie(cookieName, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.nodeEnv === "production"
  });
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(cookieName, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.nodeEnv === "production",
    maxAge: Math.floor(sessionTtlMs / 1000)
  });
}

// Read the raw session token off the request. Useful for the
// password-change flow which needs the cookie value to know
// which session to keep alive after invalidating the rest.
export function getSessionToken(request: FastifyRequest): string | undefined {
  return request.cookies[cookieName];
}

// Decorates `request.user` with the resolved UserRecord. All
// /api routes that aren't /api/auth/* go through this hook
// (registered in server.ts) so individual handlers can just
// read `request.user`. If unauthenticated, we 401 here and
// short-circuit.
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await getCurrentUser(request, reply);
  if (!user) {
    reply.code(401).send({ error: "Authentication required" });
    return;
  }
  // Attach for downstream handlers. Fastify's type augmentation
  // for `request.user` lives in `src/server/auth/fastifyTypes.ts`.
  (request as { user?: UserRecord }).user = user;
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // The global preHandler in server.ts already populates
  // request.user via requireAuth for any non /api/auth URL, so
  // this just checks the role. Falls back to running the auth
  // resolver if some caller wires this up without the global
  // preHandler.
  let user = (request as { user?: UserRecord }).user;
  if (!user) {
    await requireAuth(request, reply);
    if (reply.sent) return;
    user = (request as { user?: UserRecord }).user;
  }
  if (!user || user.role !== "admin") {
    reply.code(403).send({ error: "Admin access required" });
  }
}

// Convenience: count how many admin accounts exist. Used to
// refuse "delete the last admin" requests.
export async function adminCount(): Promise<number> {
  const data = await store.load();
  return adminUsers(data).length;
}

// Re-export role type for callers that import everything from
// authService.
export type { UserRole };
