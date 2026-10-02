import { it, expect } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "../../src/worker/index";
import { api } from "../helpers";
it("POST without Origin is rejected", async () => expect((await api("POST", "/api/auth/logout", { origin: null })).status).toBe(403));
it("POST with foreign Origin is rejected", async () => expect((await api("POST", "/api/auth/logout", { origin: "https://evil.example" })).status).toBe(403));
it("POST without X-Requested-With is rejected", async () => expect((await api("POST", "/api/auth/logout", { xrw: false })).status).toBe(403));
it("security headers", async () => { const r = await api("GET", "/api/health"); expect(r.headers.get("referrer-policy")).toBe("no-referrer"); });
it("API responses carry HSTS (no preload), on success and on errors", async () => {
  for (const r of [await api("GET", "/api/health"), await api("GET", "/api/nope"), await api("POST", "/api/auth/logout", { origin: null })]) {
    expect(r.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  }
});
it("API responses forbid rendering and framing via CSP, on success and on errors", async () => {
  for (const r of [await api("GET", "/api/health"), await api("GET", "/api/nope"), await api("POST", "/api/auth/logout", { origin: null })]) {
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  }
});

it("POST with correct Origin and X-Requested-With passes the middleware", async () => {
  const r = await api("POST", "/api/nope", { origin: "http://localhost:5173", xrw: true });
  expect(r.status).toBe(404);
  expect(r.json).toEqual({ error: "not_found" });
});
for (const origin of ["http://localhost:5173.evil.example", "http://localhost:5174", "https://localhost:5173", "http://localhost:5173/path", "null"]) {
  it(`near-miss Origin ${origin} is rejected`, async () => {
    const r = await api("POST", "/api/nope", { origin });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: "csrf" });
  });
}
it("wrong X-Requested-With value is rejected", async () => {
  const res = await worker.fetch!(
    new Request("http://localhost:5173/api/nope", { method: "POST", headers: { origin: "http://localhost:5173", "x-requested-with": "XMLHttpRequest" } }) as any,
    env as any,
    createExecutionContext(),
  );
  expect(res.status).toBe(403);
});
