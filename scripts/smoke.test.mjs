// Plain-node tests for scripts/lib/smoke.mjs (no network: runSmoke gets a fake fetch). Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { allPassed, checkSecurityHeaders, formatTable, isHttpsRedirect, parseArgs, parseBaseUrl, parseCsp, runSmoke } from "./lib/smoke.mjs";

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

test("HSTS needs a max-age of at least one day", () => {
  const hsts = (v) => checkSecurityHeaders("P", headers({ "strict-transport-security": v }))[3].ok;
  assert.equal(hsts("includeSubDomains"), false);
  assert.equal(hsts("max-age=0"), false);
  assert.equal(hsts("max-age=86399"), false);
  assert.equal(hsts("max-age=86400"), true);
  assert.equal(hsts("includeSubDomains; max-age=31536000"), true);
});

test("parseArgs reads the base URL and --wait seconds", () => {
  assert.deepEqual(parseArgs(["https://booking.example.com"]), { baseUrl: "https://booking.example.com", wait: 0 });
  assert.deepEqual(parseArgs(["https://booking.example.com", "--wait", "60"]), { baseUrl: "https://booking.example.com", wait: 60 });
  assert.deepEqual(parseArgs(["--wait=30", "https://booking.example.com"]), { baseUrl: "https://booking.example.com", wait: 30 });
  assert.throws(() => parseArgs(["https://booking.example.com", "--wait", "soon"]), /--wait/);
  assert.throws(() => parseArgs(["https://booking.example.com", "--wait", "-5"]), /--wait/);
  assert.throws(() => parseArgs(["https://booking.example.com", "--wait"]), /--wait/);
  assert.throws(() => parseArgs([]), /Usage/);
  assert.throws(() => parseArgs(["https://a.example.com", "https://b.example.com"]), /Usage/);
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
    "GET https://booking.example.com/staff/login": { status: 200, headers: { ...GOOD, "content-type": "text/html; charset=utf-8" }, body: "<html></html>" },
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
    if (r === "hang") return new Promise(() => {}); // never settles and ignores the abort signal
    if (typeof r === "function") return r();
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
    { sleep: async () => {} },
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
  const down = await runSmoke("https://booking.example.com", fakeFetch({ "GET https://booking.example.com/api/health": { status: 503, headers: {}, body: "down" } }), {
    sleep: async () => {},
  });
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
    if (url.pathname === "/api/dev/cron") return new Response('{"error":"not_found"}', { status: 404 });
    if (url.pathname === "/api/auth/customer/request") return new Response('{"error":"csrf"}', { status: 403 });
    if (url.pathname === "/" || url.pathname === "/staff/login") return new Response("<html>", { status: 200, headers: { ...GOOD, "content-type": "text/html" } });
    return new Response('{"ok":true,"bookingEnabled":false}', { status: 200, headers: GOOD });
  };
  const results = await runSmoke("http://localhost:5181", fetchImpl);
  const redirect = results.find((r) => r.name.includes("redirects to https"));
  assert.equal(redirect.ok, null);
  assert.match(redirect.detail, /not https/);
  assert.equal(allPassed(results), true);
  assert.ok(calls.every((c) => c.includes("localhost:5181")), "no request leaves the base URL");
});

const HOST = "https://booking.example.com";
const failedNames = (results) => results.filter((r) => r.ok === false).map((r) => r.name);
const okHealth = () => new Response('{"ok":true}', { status: 200, headers: { ...GOOD, "content-type": "application/json" } });

test("runSmoke fails a request that never answers, with a timeout detail, and finishes", async () => {
  const results = await runSmoke(HOST, fakeFetch({ [`GET ${HOST}/api/auth/me`]: "hang" }), { timeoutMs: 30 });
  const me = results.find((r) => r.detail.includes("timed out"));
  assert.ok(me, formatTable(results));
  assert.equal(me.ok, false);
  assert.match(me.detail, /30 ?ms/);
  assert.equal(failedNames(results).length, 1);
});

test("runSmoke times out a body that never finishes", async () => {
  const stuck = () => {
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); } });
    return new Response(body, { status: 200, headers: { ...GOOD, "content-type": "application/json" } });
  };
  const results = await runSmoke(HOST, fakeFetch({ [`GET ${HOST}/api/health`]: stuck }), { timeoutMs: 30 });
  assert.ok(results.some((r) => r.ok === false && r.detail.includes("timed out")), formatTable(results));
});

test("runSmoke passes an abort signal to every request", async () => {
  const calls = [];
  await runSmoke(HOST, fakeFetch({}, calls));
  assert.ok(calls.length >= 7 && calls.every((c) => c.init.signal instanceof AbortSignal));
});

test("wait: polls /api/health until the first 200, then runs the checks", async () => {
  const sleeps = [];
  let health = 0;
  const flaky = () => (++health < 3 ? new Response("bad gateway", { status: 502 }) : okHealth());
  const results = await runSmoke(HOST, fakeFetch({ [`GET ${HOST}/api/health`]: flaky }), { wait: 60, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(sleeps, [10000, 10000]);
  assert.equal(health, 4, "three polls plus the health check itself");
  assert.equal(allPassed(results), true, formatTable(results));
});

test("wait: stops after 6 attempts and the health row fails", async () => {
  const sleeps = [];
  let health = 0;
  const down = () => { health++; return new Response("down", { status: 503, headers: GOOD }); };
  const results = await runSmoke(HOST, fakeFetch({ [`GET ${HOST}/api/health`]: down }), { wait: 60, sleep: async (ms) => sleeps.push(ms) });
  assert.equal(sleeps.length, 5);
  assert.equal(health, 7, "six polls plus the health check itself");
  assert.ok(failedNames(results).some((n) => n.startsWith("GET /api/health")));
});

test("wait: treats a network error as not ready yet", async () => {
  let health = 0;
  const sleeps = [];
  const refuse = () => {
    if (++health < 2) throw new Error("ECONNREFUSED");
    return okHealth();
  };
  const results = await runSmoke(HOST, fakeFetch({ [`GET ${HOST}/api/health`]: refuse }), { wait: 20, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(sleeps, [10000]);
  assert.equal(allPassed(results), true, formatTable(results));
});

test("no wait by default: a down health endpoint is checked once without sleeping", async () => {
  let health = 0;
  const down = () => { health++; return new Response("down", { status: 503, headers: GOOD }); };
  const sleeps = [];
  await runSmoke(HOST, fakeFetch({ [`GET ${HOST}/api/health`]: down }), { sleep: async (ms) => sleeps.push(ms) });
  assert.equal(health, 1);
  assert.deepEqual(sleeps, []);
});

test("dev cron and CSRF checks require the expected JSON error body, and show it when it differs", async () => {
  const results = await runSmoke(
    HOST,
    fakeFetch({
      [`POST ${HOST}/api/dev/cron`]: { status: 404, headers: { "content-type": "text/html" }, body: "<html>Not found</html>" },
      [`POST ${HOST}/api/auth/customer/request`]: { status: 403, headers: { "content-type": "text/html" }, body: "Forbidden by a proxy" },
    }),
  );
  const cron = results.find((r) => r.name.includes("/api/dev/cron"));
  const csrf = results.find((r) => r.name.includes("CSRF"));
  assert.equal(cron.ok, false);
  assert.match(cron.detail, /404/);
  assert.match(cron.detail, /Not found/);
  assert.equal(csrf.ok, false);
  assert.match(csrf.detail, /Forbidden by a proxy/);
});

test("runSmoke fails when / is not 200 HTML", async () => {
  const notFound = await runSmoke(HOST, fakeFetch({ [`GET ${HOST}/`]: { status: 404, headers: { ...GOOD, "content-type": "text/html" }, body: "nope" } }));
  assert.ok(failedNames(notFound).includes("GET /: 200 HTML"));
  const json = await runSmoke(HOST, fakeFetch({ [`GET ${HOST}/`]: { status: 200, headers: { ...GOOD, "content-type": "application/json" }, body: "{}" } }));
  assert.ok(failedNames(json).includes("GET /: 200 HTML"));
});

test("runSmoke fails the redirect check for a non-https or other-host Location", async () => {
  const key = "GET http://booking.example.com/";
  for (const location of ["http://booking.example.com/", "https://other.example.net/", "/login"]) {
    const results = await runSmoke(HOST, fakeFetch({ [key]: { status: 301, headers: { location }, body: "" } }));
    const row = results.find((r) => r.name.includes("redirects to https"));
    assert.equal(row.ok, false, location);
    assert.ok(row.detail.includes(location));
  }
});

test("runSmoke fails when /api/auth/me is not 200", async () => {
  const results = await runSmoke(HOST, fakeFetch({ [`GET ${HOST}/api/auth/me`]: { status: 500, headers: {}, body: "oops" } }));
  const me = results.find((r) => r.name.startsWith("GET /api/auth/me"));
  assert.equal(me.ok, false);
  assert.match(me.detail, /500/);
});

test("runSmoke checks the SPA fallback page (/staff/login): 200 HTML with the page security headers", async () => {
  const calls = [];
  const good = await runSmoke(HOST, fakeFetch({}, calls));
  assert.ok(calls.some((c) => c.key === `GET ${HOST}/staff/login`));
  const names = good.map((r) => r.name);
  assert.ok(names.includes("GET /staff/login: 200 HTML (SPA fallback)"), names.join("\n"));
  assert.equal(names.filter((n) => n.startsWith("Fallback page: ")).length, 4);
  assert.equal(allPassed(good), true, formatTable(good));

  const notFound = await runSmoke(HOST, fakeFetch({ [`GET ${HOST}/staff/login`]: { status: 404, headers: { ...GOOD, "content-type": "text/html" }, body: "nope" } }));
  assert.deepEqual(failedNames(notFound), ["GET /staff/login: 200 HTML (SPA fallback)"]);

  const noCsp = { ...GOOD };
  delete noCsp["content-security-policy"];
  const bare = await runSmoke(HOST, fakeFetch({ [`GET ${HOST}/staff/login`]: { status: 200, headers: { ...noCsp, "content-type": "text/html" }, body: "<html>" } }), { sleep: async () => {} });
  assert.deepEqual(failedNames(bare), ["Fallback page: CSP frame-ancestors 'none'"]);
});

test("header retry: a header check that fails once is re-run after 15 s, and the retry's result is reported", async () => {
  const sleeps = [];
  let pages = 0;
  // The first answer still comes from the previous version (no HSTS); the second from the new one.
  const propagating = () => {
    const h = ++pages === 1 ? { ...GOOD, "strict-transport-security": "" } : GOOD;
    return new Response("<html>", { status: 200, headers: { ...h, "content-type": "text/html" } });
  };
  const calls = [];
  const results = await runSmoke(HOST, fakeFetch({ [`GET ${HOST}/`]: propagating }, calls), { sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(sleeps, [15000]);
  assert.equal(pages, 2);
  assert.equal(allPassed(results), true, formatTable(results));
  // Only the header-bearing requests are repeated, and each check is reported once.
  const count = (key) => calls.filter((c) => c.key === key).length;
  assert.equal(count(`GET ${HOST}/api/health`), 2);
  assert.equal(count(`GET ${HOST}/staff/login`), 2);
  assert.equal(count(`POST ${HOST}/api/dev/cron`), 1);
  assert.equal(count(`POST ${HOST}/api/auth/customer/request`), 1);
  assert.equal(count(`GET ${HOST}/api/auth/me`), 1);
  assert.equal(count("GET http://booking.example.com/"), 1);
  assert.equal(results.filter((r) => r.name === "Page: Strict-Transport-Security (max-age >= 86400)").length, 1);
  assert.match(results.find((r) => r.name.startsWith("Page: Strict-Transport-Security")).detail, /retried after 15 s/);
});

test("header retry: a header check that still fails after the retry is reported as failed", async () => {
  const sleeps = [];
  const noHsts = { ...GOOD };
  delete noHsts["strict-transport-security"];
  const results = await runSmoke(HOST, fakeFetch({ [`GET ${HOST}/api/health`]: { status: 200, headers: noHsts, body: '{"ok":true}' } }), {
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.deepEqual(sleeps, [15000]);
  assert.deepEqual(failedNames(results), ["API: Strict-Transport-Security (max-age >= 86400)"]);
});

test("header retry: no retry (and no sleep) when every header check passes, or when only a non-header check fails", async () => {
  const sleeps = [];
  await runSmoke(HOST, fakeFetch(), { sleep: async (ms) => sleeps.push(ms) });
  await runSmoke(HOST, fakeFetch({ [`GET ${HOST}/api/auth/me`]: { status: 500, headers: {}, body: "oops" } }), { sleep: async (ms) => sleeps.push(ms) });
  await runSmoke(HOST, fakeFetch({ [`GET ${HOST}/`]: { status: 404, headers: { ...GOOD, "content-type": "text/html" }, body: "nope" } }), { sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(sleeps, []);
});
