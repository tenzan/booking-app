import type { Env } from "../env";

/** True when the app's base URL is a loopback host, i.e. this is a developer's machine. */
export function isLocalBaseUrl(base: string): boolean {
  try {
    const { hostname } = new URL(base);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/** The dev mailbox (MAIL_MODE=dev) only ever works locally; a deployed app with MAIL_MODE=dev is misconfigured. */
export function devMailEnabled(env: Pick<Env, "MAIL_MODE" | "APP_BASE_URL">): boolean {
  return env.MAIL_MODE === "dev" && isLocalBaseUrl(env.APP_BASE_URL);
}
