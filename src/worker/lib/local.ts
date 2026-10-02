import type { Env } from "../env";

/** Loopback hostnames as `URL` spells them (IPv6 in brackets, already normalised: `[0:…:1]` becomes `[::1]`). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True when the URL's host is a loopback host (`localhost`, `127.0.0.1` or `[::1]`), i.e. a developer's machine. */
export function isLocalBaseUrl(base: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(base).hostname);
  } catch {
    return false;
  }
}

/** The dev mailbox (MAIL_MODE=dev) only ever works locally; a deployed app with MAIL_MODE=dev is misconfigured. */
export function devMailEnabled(env: Pick<Env, "MAIL_MODE" | "APP_BASE_URL">): boolean {
  return env.MAIL_MODE === "dev" && isLocalBaseUrl(env.APP_BASE_URL);
}

/**
 * The dev routes (/api/dev/*): dev mail enabled AND the request itself addressed to a loopback host, so a misconfigured
 * deployment that somehow passes the env guard still never serves them to the network.
 */
export function devRoutesEnabled(env: Pick<Env, "MAIL_MODE" | "APP_BASE_URL">, requestUrl: string): boolean {
  return devMailEnabled(env) && isLocalBaseUrl(requestUrl);
}
