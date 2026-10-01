import { it, expect } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { errorHandler, readJson, HttpError } from "../../src/worker/lib/http";

const app = new Hono();
app.onError(errorHandler);
app.post("/echo", async (c) => c.json(await readJson(c, z.object({ n: z.number() }))));
app.get("/http-exception", () => { throw new HTTPException(413, { message: "secret detail" }); });
app.get("/http-error", () => { throw new HttpError(409, "conflict", { x: 1 }); });
app.get("/boom", () => { throw new Error("boom"); });

const post = (body: string) => app.request("/echo", { method: "POST", headers: { "content-type": "application/json" }, body });

it("readJson returns the parsed body", async () => {
  const r = await post('{"n":1}');
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ n: 1 });
});
it("malformed JSON -> 400 invalid_json", async () => {
  const r = await post("{");
  expect(r.status).toBe(400);
  expect(await r.json()).toMatchObject({ error: "invalid_json" });
});
it("schema mismatch -> 400 invalid", async () => {
  const r = await post('{"n":"x"}');
  expect(r.status).toBe(400);
  expect(await r.json()).toMatchObject({ error: "invalid" });
});
it("HTTPException keeps its status without leaking the message", async () => {
  const r = await app.request("/http-exception");
  expect(r.status).toBe(413);
  expect(await r.json()).toEqual({ error: "http_error" });
});
it("HttpError and unknown errors", async () => {
  const a = await app.request("/http-error");
  expect(a.status).toBe(409);
  expect(await a.json()).toEqual({ error: "conflict", details: { x: 1 } });
  const b = await app.request("/boom");
  expect(b.status).toBe(500);
  expect(await b.json()).toEqual({ error: "internal" });
});
