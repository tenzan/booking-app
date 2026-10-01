import { it, expect } from "vitest";
import { api } from "./helpers";
it("health", async () => {
  const r = await api("GET", "/api/health");
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ ok: true });
});
