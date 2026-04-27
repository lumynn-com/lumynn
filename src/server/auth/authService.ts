import bcrypt from "bcryptjs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import { newToken, sha256 } from "../crypto";
import { store } from "../store";

const cookieName = "owd_session";
const sessionTtlMs = 1000 * 60 * 60 * 12;

export async function setInitialPasswordIfMissing(password: string): Promise<void> {
  const data = await store.load();
  if (data.user.passwordHash) {
    return;
  }

  data.user.passwordHash = await bcrypt.hash(password, 12);
  data.user.passwordUpdatedAt = new Date().toISOString();
  data.settings.auth.hasPassword = true;
  await store.save();
}

export async function login(username: string, password: string): Promise<string | null> {
  const data = await store.load();
  if (username !== data.user.username || !data.user.passwordHash) {
    return null;
  }

  const ok = await bcrypt.compare(password, data.user.passwordHash);
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

export async function updateCredentials(username: string, password: string): Promise<void> {
  const data = await store.load();
  data.user.username = username;
  data.user.passwordHash = await bcrypt.hash(password, 12);
  data.user.passwordUpdatedAt = new Date().toISOString();
  data.settings.auth.username = username;
  data.settings.auth.hasPassword = true;
  data.sessions = [];
  await store.save();
}

export async function getSessionUser(request: FastifyRequest): Promise<string | null> {
  const token = request.cookies[cookieName];
  if (!token) {
    return null;
  }

  const data = await store.load();
  const hash = sha256(token);
  const now = Date.now();
  const session = data.sessions.find((item) => item.idHash === hash && Date.parse(item.expiresAt) > now);
  return session?.username ?? null;
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

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await getSessionUser(request);
  if (!user) {
    reply.code(401).send({ error: "Authentication required" });
  }
}
