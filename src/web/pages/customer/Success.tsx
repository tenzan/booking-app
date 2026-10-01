import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import type { CustomerReservationDTO } from "../../../shared/types";
import { apiFetch, queryKeys, useMe } from "../../api";
import { ButtonLink } from "../../components/Button";
import { Card, Notice } from "../../components/Card";
import { PageHeading, usePageTitle } from "../../components/Layout";
import { Skeleton } from "../../components/Spinner";
import { TimezoneNote } from "../../components/TimezoneNote";
import { fmtWhen } from "../../format";
import { t } from "../../i18n";

export default function Success() {
  usePageTitle(t("web.success.heading"));
  const { id = "" } = useParams();
  const tz = useMe().data?.timezone ?? "UTC";
  const q = useQuery({
    queryKey: queryKeys.reservation(id),
    queryFn: () => apiFetch<{ reservation: CustomerReservationDTO }>(`/api/customer/reservations/${encodeURIComponent(id)}`).then((r) => r.reservation),
  });

  if (q.isPending) return <Skeleton className="h-96" />;
  if (q.isError) {
    return (
      <div className="space-y-6">
        <Notice tone="error">{t("web.success.notFound")}</Notice>
        <ButtonLink to="/my" block size="lg">
          {t("web.success.myReservations")}
        </ButtonLink>
      </div>
    );
  }
  const r = q.data;
  const steps = [t("web.success.next1"), t("web.success.next2"), t("web.success.next3", { phone: r.phone })];

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-2xl border border-amber-300 bg-amber-50 p-6 text-amber-950 sm:p-8 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-50">
        <span className="grid size-14 place-items-center rounded-full bg-amber-200 text-amber-900 dark:bg-amber-400/20 dark:text-amber-200" aria-hidden="true">
          <svg className="size-8" viewBox="0 0 24 24" fill="none">
            <path d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
          </svg>
        </span>
        <PageHeading>{t("web.success.heading")}</PageHeading>
        <p className="text-lg">{t("email.requestReceived.intro")}</p>
        <dl className="grid gap-4 border-t border-amber-300/70 pt-4 sm:grid-cols-[auto_1fr] sm:gap-x-8 dark:border-amber-400/30">
          <div>
            <dt className="text-sm font-medium opacity-80">{t("web.success.reference")}</dt>
            <dd className="font-mono text-xl font-semibold tracking-wider">{r.ref}</dd>
          </div>
          <div>
            <dt className="text-sm font-medium opacity-80">{t("common.when")}</dt>
            <dd className="text-lg font-semibold">{fmtWhen(r.startAt, r.endAt, tz)}</dd>
            <dd>
              <TimezoneNote tz={tz} atMs={r.startAt} inheritColor className="mt-1" />
            </dd>
          </div>
        </dl>
      </section>

      <Card>
        <h2 className="mb-4 text-lg font-semibold">{t("web.success.nextHeading")}</h2>
        <ol className="space-y-4">
          {steps.map((s, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-blue-100 text-sm font-semibold text-blue-800 dark:bg-blue-400/20 dark:text-blue-200">
                {i + 1}
              </span>
              <span className="pt-0.5">{s}</span>
            </li>
          ))}
        </ol>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row">
        <ButtonLink to="/my" size="lg" className="sm:flex-1">
          {t("web.success.myReservations")}
        </ButtonLink>
        <ButtonLink to="/" variant="secondary" size="lg" className="sm:flex-1">
          {t("web.success.done")}
        </ButtonLink>
      </div>
    </div>
  );
}
