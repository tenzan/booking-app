import { useQuery } from "@tanstack/react-query";
import { apiFetch, isApiError, useFragmentToken, type AccessView } from "../../api";
import { Button, ButtonLink } from "../../components/Button";
import { Card, Notice } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { PageHeading, usePageTitle } from "../../components/Layout";
import { Skeleton } from "../../components/Spinner";
import { statusTone } from "../../components/StatusBadge";
import { TimezoneNote } from "../../components/TimezoneNote";
import { fmtWhen } from "../../format";
import { t } from "../../i18n";
import { ReservationDetails } from "./MyReservations";

/** `/r#t=<token>` from emails: one reservation, no sign-in. The token is POSTed, never sent in a URL. */
export default function ReservationAccess() {
  usePageTitle(t("web.access.heading"));
  const token = useFragmentToken();
  const q = useQuery({
    queryKey: ["access", token],
    queryFn: () => apiFetch<AccessView>("/api/access/reservation", { method: "POST", body: { token } }),
    enabled: token !== null,
    retry: false,
    staleTime: 60_000,
  });

  if (!token || isApiError(q.error, 404) || isApiError(q.error, 400)) {
    return (
      <div className="space-y-6">
        <PageHeading>{t("web.access.heading")}</PageHeading>
        <EmptyState
          title={t("web.access.invalidHeading")}
          body={t("web.access.invalidBody")}
          action={
            <ButtonLink to="/" size="lg">
              {t("web.access.signIn")}
            </ButtonLink>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeading>{t("web.access.heading")}</PageHeading>
      <div aria-live="polite">
        {q.isPending ? (
          <div className="space-y-4" aria-busy="true">
            <span className="sr-only">{t("web.access.loading")}</span>
            <Skeleton className="h-28" />
            <Skeleton className="h-64" />
          </div>
        ) : q.isError ? (
          <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
            {isApiError(q.error, 429) ? t("web.errors.rateLimited") : isApiError(q.error, 0) ? t("web.errors.network") : t("web.errors.generic")}
            <Button variant="secondary" onClick={() => void q.refetch()}>
              {t("web.common.retry")}
            </Button>
          </Notice>
        ) : (
          <AccessBody view={q.data} />
        )}
      </div>
    </div>
  );
}

function AccessBody({ view }: { view: AccessView }) {
  const { reservation: r, timezone: tz, supportPhone } = view;
  return (
    <div className="space-y-6">
      <section className={`space-y-3 rounded-2xl border p-5 sm:p-6 ${statusTone[r.status].panel}`}>
        <p className="flex items-center gap-2 text-xl font-semibold">
          <span className={`size-3 shrink-0 rounded-full ${statusTone[r.status].dot}`} aria-hidden="true" />
          {t(`status.${r.status}`)}
        </p>
        <p>{t(`web.statusBanner.${r.status}`)}</p>
      </section>
      <Card className="space-y-5">
        <div>
          <p className="text-sm font-medium text-slate-500 dark:text-slate-400">{t("common.when")}</p>
          <p className="text-lg font-semibold">{fmtWhen(r.startAt, r.endAt, tz)}</p>
          <TimezoneNote tz={tz} atMs={r.startAt} className="mt-1" />
        </div>
        <ReservationDetails r={r} />
      </Card>
      {supportPhone && (
        <p className="text-center text-slate-600 dark:text-slate-400">
          {t("web.access.questions")}{" "}
          <a href={`tel:${supportPhone.replace(/[^0-9+]/g, "")}`} className="inline-flex min-h-11 items-center font-semibold text-blue-700 underline underline-offset-2 dark:text-blue-300">
            {supportPhone}
          </a>
        </p>
      )}
      <ButtonLink to="/my" variant="secondary" block>
        {t("web.nav.myReservations")}
      </ButtonLink>
    </div>
  );
}
