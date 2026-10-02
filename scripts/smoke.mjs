// Post-deploy smoke test: node scripts/smoke.mjs <baseUrl>   (npm run smoke -- <baseUrl>)
// Prints a pass/fail table and exits non-zero if any check fails. Read-only apart from two requests the server
// must reject (the dev cron route and a request without the CSRF header).
import { allPassed, formatTable, runSmoke } from "./lib/smoke.mjs";

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error("Usage: node scripts/smoke.mjs <baseUrl>   e.g. https://booking.example.com");
  process.exit(2);
}

try {
  const results = await runSmoke(baseUrl);
  console.log(`Smoke test: ${baseUrl}\n`);
  console.log(formatTable(results));
  process.exit(allPassed(results) ? 0 : 1);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}
