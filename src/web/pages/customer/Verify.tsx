import type { ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { apiFetch, isApiError, queryKeys, safePath, useFragmentToken } from "../../api";
import { Button, ButtonLink } from "../../components/Button";
import { Card, Notice } from "../../components/Card";
import { PageHeading, usePageTitle, type SignedInState } from "../../components/Layout";
import { t } from "../../i18n";

interface Redeemed {
  kind: "customer" | "staff";
  redirectPath: string | null;
}

export default function Verify() {
  usePageTitle(t("web.verify.heading"));
  const token = useFragmentToken();
  // Keyed by token: opening another link in this tab starts from a clean state.
  return <Redeem key={token} token={token} />;
}

function Redeem({ token }: { token: string | null }) {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const redeem = useMutation({
    mutationFn: (tok: string) => apiFetch<Redeemed>("/api/auth/redeem", { method: "POST", body: { token: tok } }),
    onSuccess: async (r) => {
      // A new session may be a different person: drop everything cached for the previous one, then refresh
      // "who am I" before navigating so the destination header can say whose session this is.
      qc.removeQueries({ queryKey: ["customer"] });
      await qc.invalidateQueries({ queryKey: queryKeys.me });
      const dest = safePath(r.redirectPath) ?? (r.kind === "staff" ? "/staff" : "/book");
      navigate(dest, { replace: true, state: { signedIn: true } satisfies SignedInState });
    },
  });
  const resend = useMutation({
    mutationFn: (tok: string) => apiFetch("/api/auth/resend", { method: "POST", body: { token: tok } }),
  });

  if (!token) {
    return (
      <Shell icon="warn" heading={t("web.verify.missingHeading")} body={t("web.verify.missingBody")}>
        <ButtonLink to="/" size="lg" block>
          {t("web.verify.requestNew")}
        </ButtonLink>
      </Shell>
    );
  }

  if (isApiError(redeem.error, 410)) {
    return (
      <Shell icon="clock" heading={t("web.verify.expiredHeading")} body={t("web.verify.expiredBody")}>
        <div aria-live="polite" className="empty:mb-0">
          {resend.isSuccess && <Notice tone="success">{t("web.verify.resent")}</Notice>}
          {resend.isError && <Notice tone="error">{errorText(resend.error)}</Notice>}
        </div>
        {!resend.isSuccess && (
          <Button size="lg" block loading={resend.isPending} onClick={() => resend.mutate(token)}>
            {t("web.verify.resend")}
          </Button>
        )}
        <p className="text-center text-sm">
          <Link to="/" className="inline-flex min-h-11 items-center text-blue-700 underline underline-offset-2 dark:text-blue-300">
            {t("web.common.homeLink")}
          </Link>
        </p>
      </Shell>
    );
  }

  if (isApiError(redeem.error, 400) || isApiError(redeem.error, 403)) {
    return (
      <Shell icon="warn" heading={t("web.verify.invalidHeading")} body={t("web.verify.invalidBody")}>
        <ButtonLink to="/" size="lg" block>
          {t("web.verify.requestNew")}
        </ButtonLink>
      </Shell>
    );
  }

  const busy = redeem.isPending || redeem.isSuccess;
  return (
    <Shell icon="key" heading={t("web.verify.heading")} body={t("web.verify.lead")}>
      <div aria-live="polite" className="empty:mb-0">
        {redeem.isError && <Notice tone="error">{errorText(redeem.error)}</Notice>}
      </div>
      <Button size="lg" block loading={busy} onClick={() => redeem.mutate(token)}>
        {busy ? t("web.verify.working") : t("web.verify.continue")}
      </Button>
    </Shell>
  );
}

function errorText(e: unknown): string {
  if (isApiError(e, 429)) return t("web.errors.rateLimited");
  if (isApiError(e, 0)) return t("web.errors.network");
  return t("web.errors.generic");
}

const icons = {
  key: <path d="M10 17l5-5-5-5M15 12H3M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />,
  clock: <path d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />,
  warn: <path d="M12 9v4m0 4h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />,
};

function Shell({ icon, heading, body, children }: { icon: keyof typeof icons; heading: string; body: string; children: ReactNode }) {
  const tone =
    icon === "key"
      ? "bg-blue-50 text-blue-700 dark:bg-blue-400/10 dark:text-blue-300"
      : "bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300";
  return (
    <Card className="space-y-5 py-8 text-center sm:py-10">
      <span className={`mx-auto grid size-14 place-items-center rounded-full ${tone}`} aria-hidden="true">
        <svg className="size-7" viewBox="0 0 24 24" fill="none">
          {icons[icon]}
        </svg>
      </span>
      <div className="space-y-2">
        <PageHeading>{heading}</PageHeading>
        <p className="text-slate-600 dark:text-slate-400">{body}</p>
      </div>
      <div className="space-y-4 text-left">{children}</div>
    </Card>
  );
}
