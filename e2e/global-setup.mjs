// Plain JS so the type-checked sources need no Node typings.
import { execSync } from "node:child_process";

/**
 * Seed the local database (staff, customers, weekly schedule) and clear what earlier runs left behind:
 * reservations, emails, sessions and rate-limit counters. Staff, customers and the schedule stay.
 */
export default function globalSetup() {
  console.warn(
    "\nWARNING (e2e): resetting the LOCAL D1 database of this checkout (.wrangler/state) — the one any dev server on port 5173" +
      " started from here uses. Local reservations, emails, sessions and rate-limit counters are deleted.\n",
  );
  execSync("npm run seed -- --reset", { stdio: "inherit" });
}
