import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "./env";
import { errorHandler, HttpError } from "./lib/http";
import { security } from "./middleware/security";
import { devRoutes } from "./dev/routes";
import { loadSession } from "./middleware/session";
import { bookingToggleRoutes } from "./admin/booking-toggle";
import { customerAdminRoutes } from "./admin/customer-routes";
import { scheduleRoutes } from "./admin/schedule-routes";
import { settingsRoutes } from "./admin/settings-routes";
import { staffRoutes } from "./admin/staff-routes";
import { authRoutes } from "./auth/routes";
import { accessRoutes } from "./reservations/access-routes";
import { customerRoutes } from "./reservations/customer-routes";
import { staffReservationRoutes } from "./reservations/staff-routes";

export const app = new Hono<AppEnv>().basePath("/api");
app.use("*", security);

const tooLarge = () => {
  throw new HttpError(413, "payload_too_large");
};
const smallBody = bodyLimit({ maxSize: 256 * 1024, onError: tooLarge });
const csvBody = bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge });
/** CSV imports (holidays, customers) may carry more than any other request; everything else is small JSON. */
const isCsvImport = (path: string) => /^\/api\/staff\/(holidays|customers)\/import(\/|$)/.test(path);
app.use("*", (c, next) => (isCsvImport(c.req.path) ? csvBody : smallBody)(c, next));
app.use("*", loadSession);
app.onError(errorHandler);
app.notFound((c) => c.json({ error: "not_found" }, 404));
app.get("/health", (c) => c.json({ ok: true }));
app.route("/dev", devRoutes);
app.route("/", authRoutes);
app.route("/customer", customerRoutes);
app.route("/access", accessRoutes);
app.route("/staff", staffReservationRoutes);
app.route("/staff", bookingToggleRoutes);
app.route("/staff", settingsRoutes);
app.route("/staff", staffRoutes);
app.route("/staff", customerAdminRoutes);
app.route("/staff/schedule", scheduleRoutes);
