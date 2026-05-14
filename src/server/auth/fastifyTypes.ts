// Fastify module augmentation: lets handlers read `request.user`
// after the requireAuth preHandler has resolved the calling user.
// This file has no runtime exports; it exists purely so TypeScript
// knows about the decoration.
import "fastify";
import type { UserRecord } from "../store";

declare module "fastify" {
  interface FastifyRequest {
    user?: UserRecord;
  }
}
