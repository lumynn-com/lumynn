import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSessionUser, login, logout, setInitialPasswordIfMissing, setSessionCookie } from "./authService";
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
    const user = await getSessionUser(request, reply);
    return {
      authenticated: Boolean(user),
      username: user,
      needsSetup: !data.settings.auth.hasPassword
    };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const data = await store.load();

    if (!data.settings.auth.hasPassword) {
      await setInitialPasswordIfMissing(body.password);
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
