import type { Env } from "../env";
import { safeError } from "../mail/outbox";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Siteverify normally answers in well under a second; a sign-in request never waits longer than this for it. */
const VERIFY_TIMEOUT_MS = 5000;

/**
 * True when Turnstile is not configured; false on a missing or rejected token. Any failure to get an answer (timeout,
 * network error, non-2xx, unreadable body) is also false, logged as one line without the token or the secret.
 */
export async function verifyTurnstile(
  env: Env,
  token: string | undefined,
  ip: string | null,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET_KEY);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);
  try {
    const res = await fetch(VERIFY_URL, { method: "POST", body: form, signal: AbortSignal.timeout(opts.timeoutMs ?? VERIFY_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`siteverify answered ${res.status}`);
    const data = (await res.json()) as { success?: boolean } | null;
    return data?.success === true;
  } catch (e) {
    console.warn("turnstile verify failed", safeError(e));
    return false;
  }
}
