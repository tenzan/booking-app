import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import type { CustomerReservationDTO } from "../../../shared/types";
import { apiFetch, clearFragmentParams, fragmentParams, isApiError, queryKeys, useFragmentToken, useMe, type AccessView } from "../../api";
import { Button, ButtonLink } from "../../components/Button";
import { Card, Notice } from "../../components/Card";
import { EmailLinkForm, EmailStrong, LinkSent } from "../../components/EmailLinkForm";
import { EmptyState } from "../../components/EmptyState";
import { PageHeading, usePageTitle } from "../../components/Layout";
import { Skeleton } from "../../components/Spinner";
import { statusTone } from "../../components/StatusBadge";
import { TimezoneNote } from "../../components/TimezoneNote";
import { fmtWhen } from "../../format";
import { t, tNodes } from "../../i18n";
import { ReservationDetails } from "./MyReservations";
import { ProposalSection } from "./ProposalResponse";
import { CalendarButton, CancelControl, PhoneLink, ReplacementNote, tokenTransport } from "./ReservationActions";

/**
 * `/r#t=<token>` from emails: one reservation, no sign-in. The token is POSTed, never sent in a URL. The rest of the
 * fragment says what the email's button was for (`action=cancel|proposal|ics`, `option=<id>`, `choice=keep|other`):
 * that step is opened, but nothing is sent until the customer confirms it (link scanners open links too).
 */
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
        ) : null}
      </div>
      {/* Outside the live region above: actions announce their own outcomes. Keyed by token: another link opened in this tab starts afresh. */}
      {q.data && <AccessBody key={token} view={q.data} token={token} />}
    </div>
  );
}

function AccessBody({ view, token }: { view: AccessView; token: string }) {
  const { reservation: r, timezone: tz, supportPhone } = view;
  const qc = useQueryClient();
  const transport = useMemo(() => tokenTransport(token), [token]);
  // What the email's button asked for; read once, forgotten once answered or set aside.
  const [intent, setIntent] = useState(fragmentParams);
  const done = () => {
    clearFragmentParams();
    setIntent({});
  };

  const manageable = (r.status === "confirmed" || r.status === "pending") && r.endAt > Date.now();

  const onChanged = (next: CustomerReservationDTO) => {
    qc.setQueryData<AccessView>(["access", token], (v) => (v ? { ...v, reservation: next } : v));
    // A signed-in customer's lists are now out of date too.
    void qc.invalidateQueries({ queryKey: queryKeys.reservations });
  };

  return (
    <div className="space-y-6">
      <section className={`space-y-3 rounded-2xl border p-5 sm:p-6 ${statusTone[r.status].panel}`}>
        <p className="flex items-center gap-2 text-xl font-semibold">
          <span className={`size-3 shrink-0 rounded-full ${statusTone[r.status].dot}`} aria-hidden="true" />
          {t(`status.${r.status}`)}
        </p>
        <p>{t(`web.statusBanner.${r.status}`)}</p>
      </section>
      <ReplacementNote r={r} />
      <ProposalSection
        r={r}
        tz={tz}
        transport={transport}
        supportPhone={supportPhone || null}
        intent={intent.action === "proposal" ? intent : {}}
        showClosed={intent.action === "proposal"}
        onChanged={onChanged}
        onIntentDone={done}
        other={<ChooseOther id={r.id} />}
      />
      <Card className="space-y-5">
        <div>
          <p className="text-sm font-medium text-slate-500 dark:text-slate-400">{t("common.when")}</p>
          <p className="text-lg font-semibold">{fmtWhen(r.startAt, r.endAt, tz)}</p>
          <TimezoneNote tz={tz} atMs={r.startAt} className="mt-1" />
        </div>
        <ReservationDetails r={r} />
      </Card>
      {/* Stays mounted once the reservation is closed, so the outcome of a cancel is still said here. */}
      <section aria-labelledby={manageable ? "manage-heading" : undefined} className="space-y-4">
        {manageable && (
          <h2 id="manage-heading" className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
            {t("web.customer.actionsHeading")}
          </h2>
        )}
        <CalendarButton r={r} transport={transport} prompt={intent.action === "ics"} />
        <CancelControl
          r={r}
          tz={tz}
          transport={transport}
          supportPhone={supportPhone || null}
          cutoffMin={view.cancelCutoffMin}
          autoOpen={intent.action === "cancel"}
          onChanged={onChanged}
          onSettled={done}
        />
      </section>
      {supportPhone && (
        <p className="text-center text-slate-600 dark:text-slate-400">
          {t("web.access.questions")}{" "}
          <span className="text-blue-700 dark:text-blue-300">
            <PhoneLink phone={supportPhone} />
          </span>
        </p>
      )}
      <ButtonLink to="/my" variant="secondary" block>
        {t("web.nav.myReservations")}
      </ButtonLink>
    </div>
  );
}

/**
 * "Choose another time" from the link page. Signed in: straight to booking in replacement mode. Otherwise the customer
 * asks for a sign-in link that lands there (the address is typed, never shown from the reservation).
 */
function ChooseOther({ id }: { id: string }) {
  const me = useMe();
  const navigate = useNavigate();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const dest = `/book?replaces=${encodeURIComponent(id)}`;

  if (me.isPending) return <Skeleton className="h-14" />;
  if (me.data?.customer) {
    return (
      <Button size="lg" block onClick={() => navigate(dest)}>
        {t("web.customer.proposal.otherContinue")}
      </Button>
    );
  }
  if (sentTo) return <LinkSent body={tNodes("web.customer.proposal.otherSentBody", { email: <EmailStrong email={sentTo} /> })} onReset={() => setSentTo(null)} />;
  return (
    <div className="space-y-3">
      <p>{t("web.customer.proposal.otherSignIn")}</p>
      <EmailLinkForm
        kind="customer"
        siteKey={me.data?.turnstileSiteKey ?? null}
        next={dest}
        label={t("web.start.emailLabel")}
        submitLabel={t("web.start.submit")}
        onSent={setSentTo}
      />
    </div>
  );
}
