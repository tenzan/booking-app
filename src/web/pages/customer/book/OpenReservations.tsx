import type { OpenReservationDTO } from "../../../../shared/types";
import type { Account } from "../../../api";
import { ButtonLink } from "../../../components/Button";
import { Card, Notice } from "../../../components/Card";
import { StatusBadge } from "../../../components/StatusBadge";
import { fmtWhenTz } from "../../../format";
import { t } from "../../../i18n";

export const atLimit = (a: Account) => a.open.length >= a.openLimit;

/**
 * The account already has as many open reservations as it may: shown instead of the time picker, so nobody fills in a
 * request that would be refused at the end. Each one can be moved ("Choose another time") or looked at and cancelled.
 */
export function LimitReached({ account, tz, headingRef }: { account: Account; tz: string; headingRef?: React.Ref<HTMLHeadingElement> }) {
  const one = account.open.length === 1;
  return (
    <section aria-labelledby="limit-heading" className="space-y-4">
      <div className="space-y-1">
        <h2 id="limit-heading" ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
          {t(one ? "web.book.open.headingOne" : "web.book.open.headingMany", { count: account.open.length })}
        </h2>
        <p className="text-slate-600 dark:text-slate-400">{t(one ? "web.book.open.leadOne" : "web.book.open.leadMany", { limit: account.openLimit })}</p>
      </div>
      <ul className="space-y-3">
        {account.open.map((r) => (
          <li key={r.id}>
            <Card className="space-y-4">
              <OpenSummary r={r} tz={tz} />
              <div className="flex flex-col gap-3 sm:flex-row">
                <ButtonLink to={`/book?replaces=${encodeURIComponent(r.id)}`} className="sm:flex-1">
                  {t("web.book.open.change")}
                </ButtonLink>
                <ButtonLink to="/my" variant="secondary" className="sm:flex-1">
                  {t("web.book.open.view")}
                </ButtonLink>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Below the limit but with something open: a reminder above the times, so a second booking is a deliberate one. */
export function AlsoOpen({ account, tz }: { account: Account; tz: string }) {
  return (
    <Notice tone="info" className="space-y-2">
      <p className="font-medium">{t("web.book.open.also")}</p>
      <ul className="space-y-1">
        {account.open.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="tabular-nums">{fmtWhenTz(r.startAt, r.endAt, tz)}</span>
            <StatusBadge status={r.status} />
          </li>
        ))}
      </ul>
      <ButtonLink to="/my" variant="ghost" className="-ml-3">
        {t("web.book.open.view")}
      </ButtonLink>
    </Notice>
  );
}

function OpenSummary({ r, tz }: { r: OpenReservationDTO; tz: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-lg font-semibold">{fmtWhenTz(r.startAt, r.endAt, tz)}</p>
        <p className="font-mono text-sm text-slate-600 dark:text-slate-400">{r.ref}</p>
      </div>
      <StatusBadge status={r.status} />
    </div>
  );
}
