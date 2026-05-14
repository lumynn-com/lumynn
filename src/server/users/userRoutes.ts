import fs from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config";
import { adminCount, changePassword, getSessionToken, requireAdmin } from "../auth/authService";
import { vectorIndexDirForUser } from "../rag/vectorStore";
import { adminUsers, emptyRagSettings, emptyVaultSettings, findUserByUsername, store, type UserRecord } from "../store";
import type { UserSummary } from "../../shared/types";

// Username rules: a single non-empty token, ASCII letters/digits/
// underscore/hyphen/dot, length 1..32. Kept conservative because
// the username is also used as the user's stable id throughout
// the system (sessions, vector-index folders, etc.).
const usernameSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9._-]+$/u, "Username may only contain letters, digits, dot, dash, underscore");

const createUserSchema = z.object({
  username: usernameSchema,
  password: z.string().min(8)
});

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8)
});

function toSummary(user: UserRecord): UserSummary {
  return {
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    vaultPathConfigured: Boolean(user.vault.path?.trim())
  };
}

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  // --- Self-service ----------------------------------------------------

  // Change the calling user's own password. Available to every
  // authenticated user (admin or not). Verifies the current
  // password before swapping, then invalidates every *other*
  // session for the user (the caller's own session is preserved).
  app.post("/api/users/me/password", async (request, reply) => {
    const user = request.user;
    if (!user) {
      reply.code(401);
      return { error: "Authentication required" };
    }
    const body = passwordChangeSchema.parse(request.body);
    const result = await changePassword(user, body.currentPassword, body.newPassword, getSessionToken(request));
    if ("error" in result) {
      reply.code(400);
      return result;
    }
    return result;
  });

  // --- Admin endpoints --------------------------------------------------

  app.get("/api/users", { preHandler: requireAdmin }, async () => {
    const data = await store.load();
    return data.users.map(toSummary);
  });

  app.post("/api/users", { preHandler: requireAdmin }, async (request, reply) => {
    const body = createUserSchema.parse(request.body);
    const data = await store.load();
    if (findUserByUsername(data, body.username)) {
      reply.code(409);
      return { error: "A user with that username already exists" };
    }
    const now = new Date().toISOString();
    const newUser: UserRecord = {
      username: body.username,
      role: "user",
      passwordHash: await bcrypt.hash(body.password, 12),
      passwordUpdatedAt: now,
      createdAt: now,
      // The new user must configure their vault before they can
      // do anything; we leave it blank on purpose so it shows up
      // as "not configured" in the UI.
      vault: emptyVaultSettings(),
      rag: emptyRagSettings(),
      createdAtByPath: {},
      metadataByPath: {}
    };
    data.users.push(newUser);
    await store.save();
    reply.code(201);
    return toSummary(newUser);
  });

  // Delete a user. Refuses self-delete (admin would lock
  // themselves out of admin until they could log back in) and
  // refuses to delete the last remaining admin (would brick
  // the install). Wipes the user's RAG vector-index dir + their
  // JSON metadata cache; the vault folder on disk is *never*
  // touched (it's the user's data and may live anywhere on the
  // server's filesystem).
  app.delete("/api/users/:username", { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({ username: usernameSchema }).parse(request.params);
    const data = await store.load();
    const target = findUserByUsername(data, params.username);
    if (!target) {
      reply.code(404);
      return { error: "User not found" };
    }
    if (request.user?.username === target.username) {
      reply.code(400);
      return { error: "You cannot delete your own account" };
    }
    if (target.role === "admin" && adminUsers(data).length <= 1) {
      reply.code(400);
      return { error: "Refusing to delete the only remaining admin" };
    }

    // Best-effort: remove any RAG index dir for the user. We
    // ignore errors so a missing directory doesn't block delete.
    const indexDir = vectorIndexDirForUser(target.username);
    await fs.rm(indexDir, { recursive: true, force: true }).catch(() => undefined);
    // Also drop sessions tied to this user.
    data.sessions = data.sessions.filter((session) => session.username !== target.username);
    data.users = data.users.filter((user) => user.username !== target.username);
    await store.save();
    return { ok: true };
  });
}

// Re-export so callers don't need to know where it lives.
export { vectorIndexDirForUser };
// Suppress unused-import warning in environments that prune
// path/config.
void path;
void config;
