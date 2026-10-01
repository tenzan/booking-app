// Plain JS so the type-checked sources need no Node typings.
import { execSync } from "node:child_process";

/**
 * Seed the local database (staff, customers, weekly schedule) and clear what earlier runs left behind:
 * reservations, emails, sessions and rate-limit counters. Staff, customers and the schedule stay.
 */
export default function globalSetup() {
  execSync("npm run seed -- --reset", { stdio: "inherit" });
}
