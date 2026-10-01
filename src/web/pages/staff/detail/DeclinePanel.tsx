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

/** Reason (1–500 characters, emailed to the customer) and a confirm button. */
export function DeclinePanel({ r, onDone, onStale }: PanelProps) {
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const decline = useMutation({
    mutationFn: (text: string) =>
      apiFetch<{ reservation: ReservationDTO }>(`/api/staff/reservations/${encodeURIComponent(r.id)}/decline`, {
        method: "POST",
        body: { reason: text, version: r.version },
      }),
    onMutate: () => setProblem(null),
    onSuccess: () => onDone(t("web.staff.detail.decline.done")),
    onError: (e) => {
      if (isApiError(e, 409, "stale")) onStale((e.details as { current?: ReservationDTO } | undefined)?.current);
      else if (!isApiError(e, 401)) setProblem(actionErrorText(e));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = reason.trim();
    const err = text === "" ? t("web.staff.detail.decline.required") : text.length > REASON_MAX ? t("web.staff.detail.decline.tooLong", { max: REASON_MAX }) : null;
    setFieldError(err);
    if (err) {
      ref.current?.focus();
      return;
    }
    decline.mutate(text);
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field
        id="decline-reason"
        label={t("web.staff.detail.decline.reasonLabel")}
        hint={t("web.staff.detail.decline.reasonHint")}
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
        <Button type="submit" variant="danger" size="lg" block loading={decline.isPending}>
          {decline.isPending ? t("web.staff.detail.decline.confirming") : t("web.staff.detail.decline.confirm")}
        </Button>
      </div>
    </form>
  );
}
