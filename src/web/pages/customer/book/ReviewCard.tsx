import type { ReactNode } from "react";
import type { Account, Slot } from "../../../api";
import { Card } from "../../../components/Card";
import { TimezoneNote } from "../../../components/TimezoneNote";
import { fmtWhen } from "../../../format";
import { t } from "../../../i18n";
import type { Details } from "./DetailsForm";
import type { Step } from "./Steps";

interface Props {
  account: Account;
  slot: Slot;
  tz: string;
  details: Details;
  email: string;
  onEdit: (step: Step) => void;
}

export function ReviewCard({ account, slot, tz, details, email, onEdit }: Props) {
  return (
    <Card flush className="divide-y divide-slate-200 dark:divide-slate-800">
      <Row label={t("web.book.review.when")} onEdit={() => onEdit(1)}>
        <span className="font-semibold">{fmtWhen(slot.startAt, slot.endAt, tz)}</span>
        <TimezoneNote tz={tz} atMs={slot.startAt} className="mt-1" />
      </Row>
      <Row label={t("web.book.review.account")}>
        {account.name}
        <span className="block text-sm text-slate-600 dark:text-slate-400">{t("web.book.account.number", { number: account.customerNumber })}</span>
      </Row>
      <Row label={t("web.book.review.contact")} onEdit={() => onEdit(2)}>
        {details.contactName.trim()}
      </Row>
      <Row label={t("web.book.review.phone")} onEdit={() => onEdit(2)}>
        <span className="tabular-nums">{details.phone}</span>
      </Row>
      <Row label={t("web.book.review.issue")} onEdit={() => onEdit(2)}>
        <span className="whitespace-pre-wrap">{details.issue.trim()}</span>
      </Row>
      <Row label={t("web.book.review.email")}>{email}</Row>
    </Card>
  );
}

function Row({ label, onEdit, children }: { label: string; onEdit?: () => void; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-5 py-4 sm:px-6">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-500 dark:text-slate-400">{label}</div>
        <div className="mt-0.5 break-words">{children}</div>
      </div>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="-my-2 -mr-2 inline-flex min-h-11 shrink-0 items-center rounded-lg px-3 text-sm font-medium text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-slate-800"
        >
          {t("web.common.change")}
          <span className="sr-only">: {label}</span>
        </button>
      )}
    </div>
  );
}
