import { Hono } from "hono";
import type { AppEnv } from "./env";
export const app = new Hono<AppEnv>().basePath("/api");
app.get("/health", (c) => c.json({ ok: true }));
