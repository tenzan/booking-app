// Plain-node tests for scripts/lib/smoke.mjs (no network: runSmoke gets a fake fetch). Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { allPassed, checkSecurityHeaders, formatTable, isHttpsRedirect, parseBaseUrl, parseCsp, runSmoke } from "./lib/smoke.mjs";

const GOOD = {
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};
const headers = (over = {}) => new Headers({ ...GOOD, ...over });
const oks = (results) => results.map((r) => r.ok);

test("parseCsp splits directives and lower-cases names", () => {
  const csp = parseCsp("default-src 'self'; Frame-Ancestors 'none' ;; img-src 'self' data:");
  assert.deepEqual(csp.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(csp.get("img-src"), ["'self'", "data:"]);
  assert.equal(parseCsp(null).size, 0);
});

test("checkSecurityHeaders passes with all four headers", () => {
  const r = checkSecurityHeaders("Page", headers());
  assert.equal(r.length, 4);
  assert.deepEqual(oks(r), [true, true, true, true]);
});

test("checkSecurityHeaders flags each missing or wrong header", () => {
  assert.deepEqual(oks(checkSecurityHeaders("P", headers({ "content-security-policy": "default-src 'self'" }))), [false, true, true, true]);
  assert.deepEqual(oks(checkSecurityHeaders("P", headers({ "content-security-policy": "frame-ancestors 'self'" }))), [false, true, true, true]);
  assert.deepEqual(oks(checkSecurityHeaders("P", headers({ "content-security-policy": "frame-ancestors 'none' https://x.example.com" }))), [false, true, true, true]);
  assert.deepEqual(oks(checkSecurityHeaders("P", headers({ "referrer-policy": "origin" }))), [true, false, true, true]);
  assert.deepEqual(oks(checkSecurityHeaders("P", headers({ "x-content-type-options": "" }))), [true, true, false, true]);
  assert.deepEqual(oks(checkSecurityHeaders("P", new Headers({ ...GOOD, "strict-transport-security": "" }))), [true, true, true, false]);
  assert.deepEqual(oks(checkSecurityHeaders("P", new Headers())), [false, false, false, false]);
});

test("HSTS needs a max-age", () => {
  assert.equal(checkSecurityHeaders("P", headers({ "strict-transport-security": "includeSubDomains" }))[3].ok, false);
});

test("isHttpsRedirect accepts redirects to https on the same host only", () => {
  assert.equal(isHttpsRedirect(301, "https://booking.example.com/", "booking.example.com"), true);
  assert.equal(isHttpsRedirect(308, "/", "booking.example.com"), false);
  assert.equal(isHttpsRedirect(301, "http://booking.example.com/", "booking.example.com"), false);
  assert.equal(isHttpsRedirect(301, "https://evil.example.net/", "booking.example.com"), false);
  assert.equal(isHttpsRedirect(200, "https://booking.example.com/", "booking.example.com"), false);
  assert.equal(isHttpsRedirect(301, null, "booking.example.com"), false);
});

test("parseBaseUrl", () => {
  assert.deepEqual(parseBaseUrl("https://booking.example.com/"), { origin: "https://booking.example.com", host: "booking.example.com", https: true });
  assert.deepEqual(parseBaseUrl("http://localhost:5181"), { origin: "http://localhost:5181", host: "localhost:5181", https: false });
  assert.throws(() => parseBaseUrl("booking.example.com"), /Not a valid URL/);
  assert.throws(() => parseBaseUrl(undefined), /Not a valid URL/);
  assert.throws(() => parseBaseUrl("ftp://booking.example.com"), /http\(s\)/);
});

test("formatTable and allPassed treat skips as non-failures", () => {
  const results = [
    { name: "a", ok: true, detail: "200" },
    { name: "bb", ok: null, detail: "skipped: no https" },
    { name: "c", ok: false, detail: "missing" },
  ];
  const table = formatTable(results);
  assert.match(table, /^PASS {2}a +200$/m);
  assert.match(table, /^SKIP {2}bb +skipped: no https$/m);
  assert.match(table, /^FAIL {2}c +missing$/m);
  assert.match(table, /1 passed, 1 failed, 1 skipped/);
  assert.equal(allPassed(results), false);
  assert.equal(allPassed(results.slice(0, 2)), true);
});

/** A fake deployment: `over` replaces the response for a "METHOD url" key with { status, headers, body }. */
function fakeFetch(over = {}, calls = []) {
  const json = (status, body, h = GOOD) => ({ status, headers: { ...h, "content-type": "application/json" }, body: JSON.stringify(body) });
  const routes = {
    "GET http://booking.example.com/": { status: 301, headers: { location: "https://booking.example.com/" }, body: "" },
    "GET https://booking.example.com/api/health": json(200, { ok: true }),
    "GET https://booking.example.com/": { status: 200, headers: { ...GOOD, "content-type": "text/html; charset=utf-8" }, body: "<html></html>" },
    "POST https://booking.example.com/api/dev/cron": json(404, { error: "not_found" }),
    "POST https://booking.example.com/api/auth/customer/request": json(403, { error: "csrf" }),
    "GET https://booking.example.com/api/auth/me": json(200, { bookingEnabled: true }),
    ...over,
  };
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const key = `${init.method ?? "GET"} ${url.href}`;
    calls.push({ key, init });
    const r = routes[key];
    if (r instanceof Error) throw r;
    if (!r) throw new Error(`unexpected request ${key}`);
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
}

test("runSmoke passes against a healthy deployment, sending the right requests", async () => {
  const calls = [];
  const results = await runSmoke("https://booking.example.com", fakeFetch({}, calls));
  assert.equal(allPassed(results), true, formatTable(results));
  assert.equal(results.filter((r) => r.ok === null).length, 0);
  assert.match(results.find((r) => r.name.startsWith("GET /api/auth/me")).detail, /bookingEnabled=true/);
  const cron = calls.find((c) => c.key.endsWith("/api/dev/cron"));
  assert.equal(cron.init.headers.origin, "https://booking.example.com");
  assert.equal(cron.init.headers["x-requested-with"], "fetch");
  const csrf = calls.find((c) => c.key.endsWith("/api/auth/customer/request"));
  assert.equal(csrf.init.headers.origin, "https://booking.example.com");
  assert.equal(csrf.init.headers["x-requested-with"], undefined);
  assert.ok(calls.every((c) => c.init.redirect === "manual"));
});

test("runSmoke fails when dev routes are reachable, CSRF is not enforced or HSTS is missing", async () => {
  const noHsts = { ...GOOD };
  delete noHsts["strict-transport-security"];
  const results = await runSmoke(
    "https://booking.example.com",
    fakeFetch({
      "POST https://booking.example.com/api/dev/cron": { status: 200, headers: {}, body: "{}" },
      "POST https://booking.example.com/api/auth/customer/request": { status: 200, headers: {}, body: "{}" },
      "GET https://booking.example.com/": { status: 200, headers: { ...noHsts, "content-type": "text/html" }, body: "" },
    }),
  );
  const failed = results.filter((r) => r.ok === false).map((r) => r.name);
  assert.equal(failed.length, 3);
  assert.ok(failed.some((n) => n.includes("/api/dev/cron")));
  assert.ok(failed.some((n) => n.includes("CSRF")));
  assert.ok(failed.some((n) => n.startsWith("Page: Strict-Transport-Security")));
  assert.equal(allPassed(results), false);
});

test("runSmoke fails the health check on a non-200 or a body without ok:true", async () => {
  const bad = await runSmoke("https://booking.example.com", fakeFetch({ "GET https://booking.example.com/api/health": { status: 200, headers: GOOD, body: '{"ok":false}' } }));
  assert.equal(bad.find((r) => r.name.startsWith("GET /api/health")).ok, false);
  const down = await runSmoke("https://booking.example.com", fakeFetch({ "GET https://booking.example.com/api/health": { status: 503, headers: {}, body: "down" } }));
  assert.equal(down.find((r) => r.name.startsWith("GET /api/health")).ok, false);
});

test("runSmoke fails the redirect check when http is served directly", async () => {
  const results = await runSmoke("https://booking.example.com", fakeFetch({ "GET http://booking.example.com/": { status: 200, headers: {}, body: "<html>" } }));
  assert.equal(results.find((r) => r.name.includes("redirects to https")).ok, false);
});

test("runSmoke reports a network error as a failed check instead of throwing", async () => {
  const results = await runSmoke("https://booking.example.com", fakeFetch({ "GET https://booking.example.com/api/auth/me": new Error("boom") }));
  const me = results.find((r) => r.detail.includes("boom"));
  assert.equal(me.ok, false);
  assert.equal(allPassed(results), false);
});

test("runSmoke skips the redirect check, with a note, for an http base URL", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push(`${init.method ?? "GET"} ${url.href}`);
    if (url.pathname === "/api/dev/cron") return new Response("{}", { status: 404 });
    if (url.pathname === "/api/auth/customer/request") return new Response("{}", { status: 403 });
    if (url.pathname === "/") return new Response("<html>", { status: 200, headers: { ...GOOD, "content-type": "text/html" } });
    return new Response('{"ok":true,"bookingEnabled":false}', { status: 200, headers: GOOD });
  };
  const results = await runSmoke("http://localhost:5181", fetchImpl);
  const redirect = results.find((r) => r.name.includes("redirects to https"));
  assert.equal(redirect.ok, null);
  assert.match(redirect.detail, /not https/);
  assert.equal(allPassed(results), true);
  assert.ok(calls.every((c) => c.includes("localhost:5181")), "no request leaves the base URL");
});
