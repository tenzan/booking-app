// Pushes runtime secrets from the environment (e.g. `doppler run -- npm run deploy`) to the deployed Worker.
// Only the Worker's runtime secrets are sent; deploy credentials and public config never leave the build machine.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RUNTIME_SECRETS = ["TURNSTILE_SECRET_KEY", "BOOTSTRAP_ADMIN_EMAILS"];

export function secretsFromEnv(env) {
  const out = {};
  for (const k of RUNTIME_SECRETS) {
    const v = env[k];
    if (v && !/^(REPLACE_ME|SET_BY)/.test(v)) out[k] = v;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const secrets = secretsFromEnv(process.env);
  const names = Object.keys(secrets);
  if (names.length === 0) {
    console.log("No runtime secrets set; nothing to sync.");
    process.exit(0);
  }
  const dir = mkdtempSync(join(tmpdir(), "secrets-"));
  const file = join(dir, "secrets.json");
  try {
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    const r = spawnSync("npx", ["wrangler", "secret", "bulk", file], { stdio: ["ignore", "inherit", "inherit"] });
    if (r.status !== 0) process.exit(r.status ?? 1);
    console.log(`Synced runtime secrets: ${names.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
