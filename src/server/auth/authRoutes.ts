import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getCurrentUser,
  login,
  logout,
  setInitialAdminIfMissing,
  setSessionCookie
} from "./authService";
import { store } from "../store";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/auth/me", async (request, reply) => {
    const data = await store.load();
    // Pass `reply` so the auth-check itself can slide the session
    // forward when the user simply opens the app after a long time.
    const user = await getCurrentUser(request, reply);
    return {
      authenticated: Boolean(user),
      username: user?.username ?? null,
      role: user?.role ?? null,
      // First-run: there are no users yet. The login form repurposes
      // itself into "create the first admin" mode.
      needsSetup: data.users.length === 0
    };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const data = await store.load();

    if (data.users.length === 0) {
      // Bootstrap path: no users yet, treat the first POST as
      // "create the initial admin with these credentials".
      await setInitialAdminIfMissing(body.username, body.password);
      const token = await login(body.username, body.password);
      if (token) {
        setSessionCookie(reply, token);
        return { ok: true, setupCompleted: true };
      }
    }

    const token = await login(body.username, body.password);
    if (!token) {
      reply.code(401);
      return { error: "Invalid username or password" };
    }

    setSessionCookie(reply, token);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await logout(request, reply);
    return { ok: true };
  });
}
