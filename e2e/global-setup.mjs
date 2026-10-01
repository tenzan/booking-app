// Plain JS so the type-checked sources need no Node typings.
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const BASE_URL = "http://localhost:5173";
/** Playwright storage state with the sample administrator's session; e2e/helpers.ts names the same file. */
const ADMIN_STATE = "test-results/.auth/admin.json";
const ADMIN = "admin@example.test";

/**
 * Reset the local database to the sample baseline (`npm run seed -- --reset`): reservations, emails, sessions,
 * rate-limit counters, the audit log, date schedules, holidays, time off, saved settings and any staff or customers
 * earlier runs added are deleted; the sample staff, customers and weekly schedule are restored.
 *
 * Then sign the sample administrator in once for the whole run (Playwright starts the dev server before global setup):
 * the admin specs share that session, which keeps them under the sign-in rate limit of 3 links per address per 15 minutes.
 */
export default async function globalSetup() {
  console.warn(
    "\nWARNING (e2e): resetting the LOCAL D1 database of this checkout (.wrangler/state) — the one any dev server on port 5173" +
      " started from here uses. Local reservations, emails, sessions and rate-limit counters are deleted, and staff, customers," +
      " the schedule and settings go back to the sample data.\n",
  );
  execSync("npm run seed -- --reset", { stdio: "inherit" });
  await saveAdminSession();
}

const WRITE = { "Content-Type": "application/json", Origin: BASE_URL, "X-Requested-With": "fetch" };

async function post(path, body) {
  const res = await fetch(BASE_URL + path, { method: "POST", headers: WRITE, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`e2e setup: POST ${path} → ${res.status} ${await res.text()}`);
  return res;
}

async function saveAdminSession() {
  await post("/api/auth/staff/request", { email: ADMIN });
  let token;
  for (let i = 0; i < 60 && !token; i++) {
    const { messages } = await (await fetch(`${BASE_URL}/api/dev/mail`)).json();
    token = messages.find((m) => m.to === ADMIN)?.text.match(/#t=([A-Za-z0-9_-]+)/)?.[1];
    if (!token) await new Promise((r) => setTimeout(r, 500));
  }
  if (!token) throw new Error(`e2e setup: no sign-in link for ${ADMIN} in the dev mailbox`);

  const res = await post("/api/auth/redeem", { token });
  const cookies = res.headers.getSetCookie().map((header) => {
    const [pair, ...attrs] = header.split(";").map((s) => s.trim());
    const eq = pair.indexOf("=");
    const attr = (name) => attrs.find((a) => a.toLowerCase().startsWith(name.toLowerCase()));
    const maxAge = Number(attr("Max-Age=")?.split("=")[1] ?? 3600);
    return {
      name: pair.slice(0, eq),
      value: pair.slice(eq + 1),
      domain: "localhost",
      path: attr("Path=")?.split("=")[1] ?? "/",
      expires: Math.floor(Date.now() / 1000) + maxAge,
      httpOnly: Boolean(attr("HttpOnly")),
      secure: Boolean(attr("Secure")),
      sameSite: "Lax",
    };
  });
  if (cookies.length === 0) throw new Error("e2e setup: signing in set no cookie");
  mkdirSync(dirname(ADMIN_STATE), { recursive: true });
  writeFileSync(ADMIN_STATE, JSON.stringify({ cookies, origins: [] }, null, 2));
}
