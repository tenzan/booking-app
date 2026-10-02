export interface Env {
  DB: D1Database;
  EMAIL?: SendEmail;
  ASSETS?: Fetcher;
  APP_BASE_URL: string;
  APP_TIMEZONE: string;
  APP_LOCALE: string;
  ORG_NAME: string;
  MAIL_FROM: string;
  MAIL_FROM_NAME: string;
  MAIL_MODE: "cloudflare" | "dev";
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  BOOTSTRAP_ADMIN_EMAILS?: string;
}
export interface StaffPrincipal { id: number; email: string; name: string; role: "admin" | "technician" }
export interface Vars { staff?: StaffPrincipal; customerEmail?: string; sessionHash?: string }
export type AppEnv = { Bindings: Env; Variables: Vars };
