import { app } from "./app";
import type { Env } from "./env";
export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
  async scheduled(_c, _env, _ctx) {},
} satisfies ExportedHandler<Env>;
