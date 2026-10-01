import { app } from "./app";
import type { Env } from "./env";
import { processOutbox } from "./mail/outbox";
export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
  async scheduled(_c, env, ctx) {
    ctx.waitUntil(processOutbox(env, 50));
  },
} satisfies ExportedHandler<Env>;
