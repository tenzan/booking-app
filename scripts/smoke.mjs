// Post-deploy smoke test: node scripts/smoke.mjs <baseUrl> [--wait <seconds>]   (npm run smoke -- <baseUrl>)
// Prints a pass/fail table and exits non-zero if any check fails. `--wait` first polls /api/health for up to that
// many seconds (10 s apart), for a deployment that may still be coming up. Read-only apart from two requests the
// server must reject (the dev cron route and a request without the CSRF header).
import { allPassed, formatTable, parseArgs, runSmoke } from "./lib/smoke.mjs";

try {
  const { baseUrl, wait } = parseArgs(process.argv.slice(2));
  const results = await runSmoke(baseUrl, fetch, { wait });
  console.log(`Smoke test: ${baseUrl}\n`);
  console.log(formatTable(results));
  process.exit(allPassed(results) ? 0 : 1);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}
