// Checks behind scripts/smoke.mjs. The header and assertion helpers are pure so they can be unit-tested without a
// network; `runSmoke` takes the fetch implementation as a parameter for the same reason.

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
    result(`${label}: Strict-Transport-Security`, !!hsts && /max-age=\d+/i.test(hsts), hsts ?? "missing"),
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

async function attempt(name, fn) {
  try {
    return await fn();
  } catch (e) {
    return [result(name, false, `request failed: ${e instanceof Error ? e.message : String(e)}`)];
  }
}

/** Run every check against `baseUrl`; `fetchImpl` defaults to the global fetch. Returns the list of results. */
export async function runSmoke(baseUrl, fetchImpl = fetch) {
  const base = parseBaseUrl(baseUrl);
  const get = (path, init) => fetchImpl(new URL(path, base.origin), { redirect: "manual", ...init });
  const post = (path, headers) =>
    fetchImpl(new URL(path, base.origin), {
      method: "POST",
      redirect: "manual",
      headers: { origin: base.origin, "content-type": "application/json", ...headers },
      body: "{}",
    });
  const results = [];

  results.push(
    ...(await attempt("GET /api/health", async () => {
      const res = await get("/api/health");
      const body = await res.json().catch(() => null);
      return [
        result("GET /api/health: 200 {ok:true}", res.status === 200 && body?.ok === true, `${res.status} ${JSON.stringify(body)}`),
        ...checkSecurityHeaders("API", res.headers),
      ];
    })),
  );

  results.push(
    ...(await attempt("http redirect", async () => {
      if (!base.https) return [result("GET http://host/ redirects to https", null, "skipped: base URL is not https")];
      const res = await fetchImpl(`http://${base.host}/`, { redirect: "manual" });
      const location = res.headers.get("location");
      return [result("GET http://host/ redirects to https", isHttpsRedirect(res.status, location, base.host), `${res.status} ${location ?? "no Location"}`)];
    })),
  );

  results.push(
    ...(await attempt("GET /", async () => {
      const res = await get("/");
      const type = res.headers.get("content-type") ?? "";
      return [
        result("GET /: 200 HTML", res.status === 200 && /text\/html/i.test(type), `${res.status} ${type}`),
        ...checkSecurityHeaders("Page", res.headers),
      ];
    })),
  );

  results.push(
    ...(await attempt("POST /api/dev/cron", async () => {
      const res = await post("/api/dev/cron", { "x-requested-with": "fetch" });
      return [result("POST /api/dev/cron: 404 (dev routes unreachable)", res.status === 404, String(res.status))];
    })),
  );

  results.push(
    ...(await attempt("CSRF guard", async () => {
      const res = await post("/api/auth/customer/request", {});
      return [result("POST /api/auth/customer/request without X-Requested-With: 403 (CSRF guard)", res.status === 403, String(res.status))];
    })),
  );

  results.push(
    ...(await attempt("GET /api/auth/me", async () => {
      const res = await get("/api/auth/me");
      const body = await res.json().catch(() => null);
      return [result("GET /api/auth/me: 200", res.status === 200, `${res.status}; bookingEnabled=${body?.bookingEnabled ?? "unknown"} (informational)`)];
    })),
  );

  return results;
}
