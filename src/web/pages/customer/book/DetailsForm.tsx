import type { RefObject } from "react";
import { Field, inputClass } from "../../../components/Field";
import { t } from "../../../i18n";

export interface Details {
  contactName: string;
  phone: string;
  issue: string;
}
export type DetailsErrors = Partial<Record<keyof Details, string>>;

export const ISSUE_MAX = 1000;
const NAME_MAX = 100;
const PHONE_RE = /^[0-9+()\- ]+$/;

/** Mirrors the server's rules so problems show inline before submitting. */
export function validateDetails(d: Details): DetailsErrors {
  const e: DetailsErrors = {};
  const name = d.contactName.trim();
  if (!name) e.contactName = t("web.book.details.required");
  else if (name.length > NAME_MAX) e.contactName = t("web.book.details.tooLong", { max: NAME_MAX });
  if (!d.phone.trim()) e.phone = t("web.book.details.required");
  else if (d.phone.length < 5 || d.phone.length > 30 || !PHONE_RE.test(d.phone)) e.phone = t("web.book.details.phoneInvalid");
  const issue = d.issue.trim();
  if (!issue) e.issue = t("web.book.details.required");
  else if (issue.length > ISSUE_MAX) e.issue = t("web.book.details.tooLong", { max: ISSUE_MAX });
  return e;
}

interface Props {
  value: Details;
  errors: DetailsErrors;
  onChange: (field: keyof Details, value: string) => void;
  /** Lets the page focus the first invalid field. */
  refs: Record<keyof Details, RefObject<HTMLInputElement | HTMLTextAreaElement | null>>;
}

export function DetailsForm({ value, errors, onChange, refs }: Props) {
  return (
    <div className="space-y-6">
      <Field id="contactName" label={t("web.book.details.contactName")} error={errors.contactName}>
        {(aria) => (
          <input
            {...aria}
            ref={refs.contactName as RefObject<HTMLInputElement>}
            type="text"
            autoComplete="name"
            maxLength={NAME_MAX}
            value={value.contactName}
            onChange={(e) => onChange("contactName", e.target.value)}
            className={inputClass}
          />
        )}
      </Field>
      <Field id="phone" label={t("web.book.details.phone")} hint={t("web.book.details.lead")} error={errors.phone}>
        {(aria) => (
          <input
            {...aria}
            ref={refs.phone as RefObject<HTMLInputElement>}
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            maxLength={30}
            value={value.phone}
            onChange={(e) => onChange("phone", e.target.value)}
            className={inputClass}
          />
        )}
      </Field>
      <Field
        id="issue"
        label={t("web.book.details.issue")}
        hint={t("web.book.details.issueHint")}
        error={errors.issue}
        aside={t("web.book.details.counter", { n: value.issue.length, max: ISSUE_MAX })}
      >
        {(aria) => (
          <textarea
            {...aria}
            ref={refs.issue as RefObject<HTMLTextAreaElement>}
            rows={5}
            maxLength={ISSUE_MAX}
            value={value.issue}
            onChange={(e) => onChange("issue", e.target.value)}
            className={`${inputClass} min-h-32 resize-y`}
          />
        )}
      </Field>
    </div>
  );
}
