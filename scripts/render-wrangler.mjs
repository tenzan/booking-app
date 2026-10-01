import { writeFileSync, existsSync, readFileSync } from "node:fs";

// Load .env if present (simple KEY=VALUE parser) without overriding real env.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const strict = process.argv.includes("--strict");
const REQUIRED = ["APP_DOMAIN", "MAIL_FROM", "MAIL_FROM_NAME", "ORG_NAME", "APP_TIMEZONE", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID"];
const OPTIONAL = ["MAIL_REPLY_FORWARD_TO", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "BOOTSTRAP_ADMIN_EMAILS", "WORKER_NAME", "D1_DATABASE_NAME", "APP_LOCALE"];
const env = process.env;
if (strict) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) { console.error(`Missing env vars: ${missing.join(", ")}`); process.exit(1); }
  // Refuse anything that would deploy a dev or half-configured app. Values may come from a local .env too.
  const problems = [];
  const mailMode = env.MAIL_MODE || "cloudflare";
  if (mailMode !== "cloudflare") {
    problems.push(`MAIL_MODE must be "cloudflare" for a deployment (got "${mailMode}"; "dev" is for local development only — check your .env)`);
  }
  for (const k of ["CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID"]) {
    if (/^[0-]+$/.test(env[k])) problems.push(`${k} is a placeholder (all zeros); set your real value`);
  }
  // Any deployment value still holding a placeholder (required or optional) is a mistake.
  for (const k of [...REQUIRED, ...OPTIONAL]) {
    if (/^(REPLACE_ME|SET_BY)/.test(env[k] ?? "")) problems.push(`${k} is a placeholder ("${env[k]}"); set your real value`);
  }
  if (problems.length) {
    console.error(`Refusing to render a deployment config:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
}
const domain = env.APP_DOMAIN || "localhost";
const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: env.WORKER_NAME || "remote-support-booking",
  main: "src/worker/index.ts",
  compatibility_date: "2026-08-15",
  compatibility_flags: ["nodejs_compat"],
  ...(env.CLOUDFLARE_ACCOUNT_ID ? { account_id: env.CLOUDFLARE_ACCOUNT_ID } : {}),
  assets: { not_found_handling: "single-page-application", run_worker_first: ["/api/*"] },
  observability: { enabled: true },
  triggers: { crons: ["* * * * *"] },
  d1_databases: [{
    binding: "DB",
    database_name: env.D1_DATABASE_NAME || "remote-support-booking",
    database_id: env.D1_DATABASE_ID || "00000000-0000-0000-0000-000000000000",
    migrations_dir: "migrations",
  }],
  send_email: [{ name: "EMAIL", allowed_sender_addresses: [env.MAIL_FROM || "no-reply@example.com"] }],
  vars: {
    APP_BASE_URL: strict ? `https://${domain}` : (env.APP_BASE_URL || "http://localhost:5173"),
    APP_TIMEZONE: env.APP_TIMEZONE || "UTC",
    APP_LOCALE: env.APP_LOCALE || "en",
    ORG_NAME: env.ORG_NAME || "Example Support",
    MAIL_FROM: env.MAIL_FROM || "no-reply@example.com",
    MAIL_FROM_NAME: env.MAIL_FROM_NAME || "Example Support",
    MAIL_MODE: strict ? "cloudflare" : (env.MAIL_MODE || "dev"),
    MAIL_REPLY_FORWARD_TO: env.MAIL_REPLY_FORWARD_TO || "",
    TURNSTILE_SITE_KEY: env.TURNSTILE_SITE_KEY || "",
  },
  // Deployments are reachable only on the custom domain: no *.workers.dev URL or preview URLs
  // (they would bypass the Cloudflare-provided client IP that rate limiting relies on).
  ...(strict ? { routes: [{ pattern: domain, custom_domain: true }], workers_dev: false, preview_urls: false } : {}),
};
writeFileSync("wrangler.jsonc", JSON.stringify(config, null, 2) + "\n");
console.log(`wrangler.jsonc written (${strict ? "strict" : "dev defaults"})`);
