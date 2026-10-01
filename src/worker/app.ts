import { Hono } from "hono";
import type { AppEnv } from "./env";
import { errorHandler } from "./lib/http";
import { security } from "./middleware/security";
import { devRoutes } from "./dev/routes";

export const app = new Hono<AppEnv>().basePath("/api");
app.use("*", security);
app.onError(errorHandler);
app.notFound((c) => c.json({ error: "not_found" }, 404));
app.get("/health", (c) => c.json({ ok: true }));
app.route("/dev", devRoutes);
