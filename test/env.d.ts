import type { D1Migration } from "cloudflare:test";
import type { Env as WorkerEnv } from "../src/worker/env";

declare global {
  namespace Cloudflare {
    // Types the `env` exported by "cloudflare:test" / "cloudflare:workers".
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
