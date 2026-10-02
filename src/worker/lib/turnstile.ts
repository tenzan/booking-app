import type { Env } from "../env";
import { safeError } from "../mail/outbox";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Siteverify normally answers in well under a second; a sign-in request never waits longer than this for it. */
const VERIFY_TIMEOUT_MS = 5000;
/** Rejections that mean the operator's secret is wrong or missing (every sign-in fails), not that a visitor failed. */
const MISCONFIGURED = ["invalid-input-secret", "missing-input-secret"];

/**
 * True when Turnstile is not configured; false on a missing or rejected token. Any failure to get an answer (timeout,
 * network error, non-2xx, unreadable body) is also false, logged as one line without the token or the secret. A
 * rejection is logged (its error codes only) when the codes say the secret itself is invalid or missing.
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
    const data = (await res.json()) as { success?: boolean; "error-codes"?: unknown } | null;
    if (data?.success === true) return true;
    const codes = Array.isArray(data?.["error-codes"]) ? data["error-codes"].filter((c): c is string => typeof c === "string") : [];
    if (codes.some((c) => MISCONFIGURED.includes(c))) console.error("turnstile verify rejected", codes.join(","));
    return false;
  } catch (e) {
    console.warn("turnstile verify failed", safeError(e));
    return false;
  }
}
