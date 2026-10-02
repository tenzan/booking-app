import { useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ReservationDTO } from "../../../../shared/types";
import { apiFetch, isApiError } from "../../../api";
import { Button } from "../../../components/Button";
import { Notice } from "../../../components/Card";
import { Field, inputClass } from "../../../components/Field";
import { t } from "../../../i18n";
import { actionErrorText, type PanelProps } from "./shared";

const REASON_MAX = 500;
const k = (key: string, params?: Record<string, string | number>) => t(`web.staff.detail.cancel.${key}`, params);

/** 400 invalid with a schema issue on `reason` (e.g. only whitespace after trimming). */
const isReasonIssue = (e: unknown): boolean =>
  isApiError(e, 400, "invalid") && Array.isArray(e.details) && e.details.some((i: { path?: unknown }) => Array.isArray(i.path) && i.path[0] === "reason");

/**
 * Reason (1–500 characters, emailed to the customer), what happens next, and a confirm button. Not keyed by version:
 * a refresh of the reservation keeps the typed reason, and each send uses the latest `r.version`.
 */
export function CancelPanel({ r, onDone, onStale }: PanelProps) {
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const cancel = useMutation({
    mutationFn: (text: string) =>
      apiFetch<{ reservation: ReservationDTO }>(`/api/staff/reservations/${encodeURIComponent(r.id)}/cancel`, {
        method: "POST",
        body: { reason: text, version: r.version },
      }),
    onMutate: () => setProblem(null),
    onSuccess: () => onDone(k("done")),
    onError: (e) => {
      if (isApiError(e, 409, "stale")) onStale((e.details as { current?: ReservationDTO } | undefined)?.current);
      else if (isApiError(e, 409, "too_late")) setProblem(k("tooLate"));
      else if (isReasonIssue(e)) {
        setFieldError(k("required"));
        ref.current?.focus();
      } else if (!isApiError(e, 401)) setProblem(actionErrorText(e));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = reason.trim();
    const err = text === "" ? k("required") : text.length > REASON_MAX ? k("tooLong", { max: REASON_MAX }) : null;
    setFieldError(err);
    if (err) {
      ref.current?.focus();
      return;
    }
    cancel.mutate(text);
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div className="space-y-2 text-slate-600 dark:text-slate-400">
        <p>{r.status === "confirmed" ? k("leadConfirmed") : k("leadPending")}</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>{k("emailCustomer")}</li>
          <li>{k("emailTeam")}</li>
          <li>{k("freesTime")}</li>
          {r.replacedByStatus === "pending" && r.replacedByRef && <li className="font-medium text-slate-900 dark:text-slate-100">{k("alsoReplacement", { ref: r.replacedByRef })}</li>}
        </ul>
      </div>
      <Field
        id="cancel-reason"
        label={t("web.staff.detail.decline.reasonLabel")}
        hint={k("reasonHint")}
        error={fieldError}
        aside={t("web.book.details.counter", { n: reason.length, max: REASON_MAX })}
      >
        {(aria) => (
          <textarea
            {...aria}
            ref={ref}
            rows={4}
            maxLength={REASON_MAX}
            required
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (fieldError && e.target.value.trim() !== "") setFieldError(null);
            }}
            className={`${inputClass} min-h-28 resize-y`}
          />
        )}
      </Field>
      <div>
        {/* Always rendered so problems are announced; it takes no space while empty. */}
        <div aria-live="polite">{problem && <Notice tone="error" className="mb-4">{problem}</Notice>}</div>
        <Button type="submit" variant="danger" size="lg" block loading={cancel.isPending}>
          {cancel.isPending ? k("confirming") : k("confirm")}
        </Button>
      </div>
    </form>
  );
}
