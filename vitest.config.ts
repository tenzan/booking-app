import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: {
        TEST_MIGRATIONS: migrations,
        MAIL_MODE: "dev",
        APP_BASE_URL: "http://localhost:5173",
        APP_TIMEZONE: "Asia/Tokyo",
        BOOTSTRAP_ADMIN_EMAILS: "boot-admin@example.test",
      } },
    })],
    test: { setupFiles: ["./test/setup.ts"], include: ["test/**/*.test.ts"] },
  };
});
