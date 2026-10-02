// Checks behind scripts/smoke.mjs. The header and assertion helpers are pure so they can be unit-tested without a
// network; `runSmoke` takes the fetch implementation (and sleep) as parameters for the same reason.

const MIN_HSTS_SECONDS = 86400;
const DEFAULT_TIMEOUT_MS = 15000;
const WAIT_INTERVAL_MS = 10000;
/** Pause before re-running failed header checks once (a PoP may briefly still serve the previous version). */
const HEADER_RETRY_MS = 15000;
/** The labels `checkSecurityHeaders` is called with; a failed row under one of them triggers the header retry. */
const HEADER_LABELS = ["API", "Page", "Fallback page"];
const isHeaderRow = (r) => HEADER_LABELS.some((label) => r.name.startsWith(`${label}: `));

/** Split a Content-Security-Policy into a Map of directive name to its list of values. */
export function parseCsp(csp) {
  const out = new Map();
  for (const part of String(csp ?? "").split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name.toLowerCase(), values);
  }
  return out;
}

/** A check result: `ok` is true (pass), false (fail) or null (skipped, with the reason in `detail`). */
const result = (name, ok, detail = "") => ({ name, ok, detail });

const snippet = (text) => {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > 120 ? `${t.slice(0, 120)}...` : t || "(empty body)";
};

/** Whether a Strict-Transport-Security value has a max-age of at least one day. */
function hstsOk(value) {
  const m = /max-age\s*=\s*"?(\d+)/i.exec(value ?? "");
  return !!m && Number(m[1]) >= MIN_HSTS_SECONDS;
}

/**
 * Security-header assertions shared by the page and API checks. `headers` is a Headers object (or anything with
 * a case-insensitive `get`).
 */
export function checkSecurityHeaders(label, headers) {
  const csp = parseCsp(headers.get("content-security-policy"));
  const frameAncestors = csp.get("frame-ancestors");
  const referrer = headers.get("referrer-policy");
  const nosniff = headers.get("x-content-type-options");
  const hsts = headers.get("strict-transport-security");
  return [
    result(
      `${label}: CSP frame-ancestors 'none'`,
      !!frameAncestors && frameAncestors.length === 1 && frameAncestors[0] === "'none'",
      frameAncestors ? `frame-ancestors ${frameAncestors.join(" ")}` : "no CSP frame-ancestors directive",
    ),
    result(`${label}: Referrer-Policy no-referrer`, (referrer ?? "").trim().toLowerCase() === "no-referrer", referrer ?? "missing"),
    result(`${label}: X-Content-Type-Options nosniff`, (nosniff ?? "").trim().toLowerCase() === "nosniff", nosniff ?? "missing"),
    result(`${label}: Strict-Transport-Security (max-age >= ${MIN_HSTS_SECONDS})`, hstsOk(hsts), hsts ?? "missing"),
  ];
}

/** Whether `status` is a redirect whose Location is an https URL for `host`. */
export function isHttpsRedirect(status, location, host) {
  if (![301, 302, 303, 307, 308].includes(status) || !location) return false;
  try {
    const target = new URL(location, `http://${host}/`);
    return target.protocol === "https:" && target.host === host;
  } catch {
    return false;
  }
}

/** Parse the base URL argument into { origin, host, https }, or throw a readable error. */
export function parseBaseUrl(arg) {
  let url;
  try {
    url = new URL(arg);
  } catch {
    throw new Error(`Not a valid URL: ${arg ?? "(missing)"}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Base URL must be http(s): ${arg}`);
  return { origin: url.origin, host: url.host, https: url.protocol === "https:" };
}

const USAGE = "Usage: node scripts/smoke.mjs <baseUrl> [--wait <seconds>]   e.g. https://booking.example.com --wait 60";

/** CLI arguments: one base URL and an optional `--wait <seconds>` (or `--wait=<seconds>`; default 0). */
export function parseArgs(argv) {
  let wait = 0;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--wait" || arg.startsWith("--wait=")) {
      const raw = arg === "--wait" ? argv[++i] : arg.slice("--wait=".length);
      if (raw === undefined || !/^\d+(\.\d+)?$/.test(raw)) throw new Error(`--wait needs a number of seconds (got ${raw ?? "nothing"})\n${USAGE}`);
      wait = Number(raw);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) throw new Error(USAGE);
  return { baseUrl: positional[0], wait };
}

/** Render results as a fixed-width pass/fail table. */
export function formatTable(results) {
  const mark = (r) => (r.ok === null ? "SKIP" : r.ok ? "PASS" : "FAIL");
  const width = Math.max(5, ...results.map((r) => r.name.length));
  const lines = results.map((r) => `${mark(r).padEnd(4)}  ${r.name.padEnd(width)}  ${r.detail}`.trimEnd());
  const failed = results.filter((r) => r.ok === false).length;
  const passed = results.filter((r) => r.ok === true).length;
  const skipped = results.filter((r) => r.ok === null).length;
  lines.push("", `${passed} passed, ${failed} failed, ${skipped} skipped`);
  return lines.join("\n");
}

/** True when nothing failed (skipped checks do not count against the run). */
export const allPassed = (results) => results.every((r) => r.ok !== false);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Await `work`, rejecting with a "timed out" error after `ms` (also covers a response body that never finishes). */
async function withTimeout(ms, work, onTimeout = () => {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run every check against `baseUrl`. Options: `timeoutMs` per request (default 15 s), `wait` (seconds to keep polling
 * /api/health before the checks, 10 s apart; default 0) and `sleep` (replaceable in tests). If a security-header
 * check fails, the requests that carry header checks are made once more after 15 s and their rows replaced.
 */
export async function runSmoke(baseUrl, fetchImpl = fetch, { timeoutMs = DEFAULT_TIMEOUT_MS, wait = 0, sleep = defaultSleep } = {}) {
  const base = parseBaseUrl(baseUrl);

  /** One request, body read inside the timeout. Resolves to { status, headers, text, json }. */
  const request = (url, init = {}) => {
    const controller = new AbortController();
    return withTimeout(
      timeoutMs,
      async () => {
        const res = await fetchImpl(url, { redirect: "manual", ...init, signal: controller.signal });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        return { status: res.status, headers: res.headers, text, json };
      },
      () => controller.abort(),
    );
  };
  const get = (path) => request(new URL(path, base.origin));
  const post = (path, headers) =>
    request(new URL(path, base.origin), {
      method: "POST",
      headers: { origin: base.origin, "content-type": "application/json", ...headers },
      body: "{}",
    });

  async function attempt(name, fn) {
    try {
      return await fn();
    } catch (e) {
      return [result(name, false, `request failed: ${e instanceof Error ? e.message : String(e)}`)];
    }
  }

  // A fresh deployment (new domain, certificate or Worker) may need a little while: wait for the first healthy answer.
  if (wait > 0) {
    const attempts = Math.max(1, Math.ceil((wait * 1000) / WAIT_INTERVAL_MS));
    for (let i = 0; i < attempts; i++) {
      const healthy = await get("/api/health").then((r) => r.status === 200, () => false);
      if (healthy) break;
      if (i < attempts - 1) await sleep(WAIT_INTERVAL_MS);
    }
  }

  /** Each check: a name (for a request failure), its rows, and whether its rows include security-header checks. */
  const checks = [
    {
      name: "GET /api/health",
      headers: true,
      fn: async () => {
        const res = await get("/api/health");
        return [
          result("GET /api/health: 200 {ok:true}", res.status === 200 && res.json?.ok === true, `${res.status} ${snippet(res.text)}`),
          ...checkSecurityHeaders("API", res.headers),
        ];
      },
    },
    {
      name: "http redirect",
      fn: async () => {
        const name = "GET http://host/ redirects to https";
        if (!base.https) return [result(name, null, "skipped: base URL is not https")];
        const res = await request(`http://${base.host}/`);
        const location = res.headers.get("location");
        return [result(name, isHttpsRedirect(res.status, location, base.host), `${res.status} ${location ?? "no Location"}`)];
      },
    },
    {
      name: "GET /",
      headers: true,
      fn: async () => {
        const res = await get("/");
        const type = res.headers.get("content-type") ?? "";
        return [result("GET /: 200 HTML", res.status === 200 && /text\/html/i.test(type), `${res.status} ${type}`), ...checkSecurityHeaders("Page", res.headers)];
      },
    },
    {
      // A route with no file of its own: served by the SPA fallback, which must carry the same page headers.
      name: "GET /staff/login",
      headers: true,
      fn: async () => {
        const res = await get("/staff/login");
        const type = res.headers.get("content-type") ?? "";
        return [
          result("GET /staff/login: 200 HTML (SPA fallback)", res.status === 200 && /text\/html/i.test(type), `${res.status} ${type}`),
          ...checkSecurityHeaders("Fallback page", res.headers),
        ];
      },
    },
    {
      name: "POST /api/dev/cron",
      fn: async () => {
        const res = await post("/api/dev/cron", { "x-requested-with": "fetch" });
        const ok = res.status === 404 && res.json?.error === "not_found";
        return [result("POST /api/dev/cron: 404 not_found (dev routes unreachable)", ok, ok ? "404" : `${res.status} ${snippet(res.text)}`)];
      },
    },
    {
      name: "CSRF guard",
      fn: async () => {
        const res = await post("/api/auth/customer/request", {});
        const ok = res.status === 403 && res.json?.error === "csrf";
        return [result("POST /api/auth/customer/request without X-Requested-With: 403 csrf (CSRF guard)", ok, ok ? "403" : `${res.status} ${snippet(res.text)}`)];
      },
    },
    {
      name: "GET /api/auth/me",
      fn: async () => {
        const res = await get("/api/auth/me");
        return [result("GET /api/auth/me: 200", res.status === 200, `${res.status}; bookingEnabled=${res.json?.bookingEnabled ?? "unknown"} (informational)`)];
      },
    },
  ];

  const rows = [];
  for (const check of checks) rows.push(await attempt(check.name, check.fn));

  // Right after a deploy, an edge location can still answer from the previous version for a few seconds: give
  // failed header checks one more chance before reporting them.
  if (rows.some((group) => group.some((r) => r.ok === false && isHeaderRow(r)))) {
    await sleep(HEADER_RETRY_MS);
    for (let i = 0; i < checks.length; i++) {
      if (!checks[i].headers) continue;
      const retried = await attempt(checks[i].name, checks[i].fn);
      rows[i] = retried.map((r) => ({ ...r, detail: `${r.detail} (retried after ${HEADER_RETRY_MS / 1000} s)` }));
    }
  }

  return rows.flat();
}
