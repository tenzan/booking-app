import { it, expect } from "vitest";
import { api } from "../helpers";
it("POST without Origin is rejected", async () => expect((await api("POST", "/api/auth/logout", { origin: null })).status).toBe(403));
it("POST with foreign Origin is rejected", async () => expect((await api("POST", "/api/auth/logout", { origin: "https://evil.example" })).status).toBe(403));
it("POST without X-Requested-With is rejected", async () => expect((await api("POST", "/api/auth/logout", { xrw: false })).status).toBe(403));
it("security headers", async () => { const r = await api("GET", "/api/health"); expect(r.headers.get("referrer-policy")).toBe("no-referrer"); });
