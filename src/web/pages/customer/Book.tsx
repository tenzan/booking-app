import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router";
import { apiFetch, isApiError, queryKeys, useMe, type Account, type Availability, type Slot, type SubmittedReservation } from "../../api";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { PageHeading, usePageTitle } from "../../components/Layout";
import { Skeleton } from "../../components/Spinner";
import { TimezoneNote } from "../../components/TimezoneNote";
import { addDays, dateIn, fmtLongDate, fmtShortDate, fmtTimeRange, fmtTz, todayIn } from "../../format";
import { t } from "../../i18n";
import { AccountPicker } from "./book/AccountPicker";
import { DateStrip } from "./book/DateStrip";
import { DetailsForm, validateDetails, type Details, type DetailsErrors } from "./book/DetailsForm";
import { ReviewCard } from "./book/ReviewCard";
import { SlotList } from "./book/SlotList";
import { StickyBar } from "./book/StickyBar";
import { Steps, stepFromName, stepName, type Step } from "./book/Steps";

const PAGE_DAYS = 14;

export default function Book() {
  usePageTitle(t("web.book.heading"));
  const me = useMe();
  const accounts = useQuery({
    queryKey: queryKeys.accounts,
    queryFn: () => apiFetch<{ accounts: Account[] }>("/api/customer/accounts").then((r) => r.accounts),
  });

  let body: ReactNode;
  if (accounts.isPending || !me.data?.customer) body = <BookSkeleton />;
  else if (accounts.isError)
    body = (
      <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
        {t("web.errors.generic")}
        <Button variant="secondary" onClick={() => void accounts.refetch()}>
          {t("web.common.retry")}
        </Button>
      </Notice>
    );
  else if (accounts.data.length === 0)
    body = <EmptyState title={t("web.book.noAccounts.heading")} body={t("web.book.noAccounts.body")} />;
  else body = <BookFlow accounts={accounts.data} tz={me.data.timezone} email={me.data.customer.email} />;

  return (
    <div className="space-y-6">
      <PageHeading>{t("web.book.heading")}</PageHeading>
      {body}
    </div>
  );
}

/** A message tied to the step it belongs to; leaving that step drops it. */
type Banner = { step: Step; tone: "warning" | "error"; text: string; action?: "retry" | "my" };

const prefill = (a: Account): Details => ({
  contactName: a.contactName ?? "",
  phone: a.lastPhone ?? a.contactPhone ?? a.customerPhone ?? "",
  issue: "",
});

function BookFlow({ accounts, tz, email }: { accounts: Account[]; tz: string; email: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const single = accounts.length === 1 ? accounts[0]! : null;
  const [accountId, setAccountId] = useState<number | null>(single?.id ?? null);
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [details, setDetails] = useState<Details>(() => (single ? prefill(single) : { contactName: "", phone: "", issue: "" }));
  const edited = useRef(new Set<keyof Details>());
  const [errors, setErrors] = useState<DetailsErrors>({});
  const [banner, setBanner] = useState<Banner | null>(null);
  const idempotency = useRef<{ key: string; fingerprint: string } | null>(null);
  const fieldRefs = {
    contactName: useRef<HTMLInputElement>(null),
    phone: useRef<HTMLInputElement>(null),
    issue: useRef<HTMLTextAreaElement>(null),
  };

  // ---- availability, 14 days per page; a short page means the booking horizon was reached
  const today = useMemo(() => todayIn(tz), [tz]);
  const avail = useInfiniteQuery({
    queryKey: [...queryKeys.availability, today],
    initialPageParam: today,
    queryFn: async ({ pageParam }) => {
      const to = addDays(pageParam, PAGE_DAYS - 1);
      const r = await apiFetch<Availability>(`/api/customer/availability?from=${pageParam}&to=${to}`);
      return { ...r, to };
    },
    getNextPageParam: (last) => (last.days.at(-1)?.date === last.to ? addDays(last.to, 1) : undefined),
    staleTime: 30_000,
  });
  const days = useMemo(() => avail.data?.pages.flatMap((p) => p.days) ?? [], [avail.data]);
  const dayHasSlots = (d: string | null) => days.some((x) => x.date === d && x.slots.length > 0);
  const selectedDay = days.find((d) => d.date === date) ?? null;

  // ---- step, kept in the URL so the browser back button walks back through the steps
  // Derived from the current list, so a refetched list (access revoked, account added) can't leave a stale pick.
  const account = accounts.length === 1 ? accounts[0]! : (accounts.find((a) => a.id === accountId) ?? null);
  const requested = stepFromName(params.get("step"));
  const detailsOk = Object.keys(validateDetails(details)).length === 0;
  const step: Step = account && slot ? (requested === 3 && !detailsOk ? 2 : requested) : 1;

  const goTo = (s: Step, replace = false) => setParams(s === 1 ? {} : { step: stepName(s) }, { replace });

  // A reload or history jump can leave the URL ahead of what has been filled in; pull it back.
  useEffect(() => {
    if (step !== requested) goTo(step, true);
  }, [step, requested]);

  useEffect(() => {
    if (accountId !== null && !accounts.some((a) => a.id === accountId)) setAccountId(null);
  }, [accounts, accountId]);

  // Prefill contact name and phone from the chosen account, keeping anything the customer typed.
  const prefilledFor = useRef(single?.id ?? null);
  useEffect(() => {
    if (!account || prefilledFor.current === account.id) return;
    prefilledFor.current = account.id;
    const p = prefill(account);
    setDetails((d) => ({
      contactName: edited.current.has("contactName") ? d.contactName : p.contactName,
      phone: edited.current.has("phone") ? d.phone : p.phone,
      issue: d.issue,
    }));
  }, [account]);

  // Pick the first day with times, and re-pick when the chosen day runs out of times.
  useEffect(() => {
    if (!dayHasSlots(date)) setDate(days.find((d) => d.slots.length > 0)?.date ?? null);
  }, [days]);

  // A refetch may drop the chosen time while the customer is still choosing.
  useEffect(() => {
    if (slot && step === 1 && !days.some((d) => d.slots.some((s) => s.startAt === slot.startAt))) setSlot(null);
  }, [days]);

  // Move focus to the new step's heading so keyboard and screen-reader users land in the right place.
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const prevStep = useRef(step);
  useEffect(() => {
    if (prevStep.current === step) return;
    prevStep.current = step;
    window.scrollTo(0, 0);
    stepHeading.current?.focus({ preventScroll: true });
    setBanner((b) => (b && b.step === step ? b : null));
  }, [step]);

  const submit = useMutation({
    mutationFn: () => {
      const body = {
        customerId: account!.id,
        startAt: slot!.startAt,
        contactName: details.contactName.trim(),
        phone: details.phone,
        issue: details.issue.trim(),
      };
      // One key per exact request: a retry of the same request reuses it, any changed fact gets a new one.
      const fingerprint = JSON.stringify(body);
      if (idempotency.current?.fingerprint !== fingerprint) idempotency.current = { key: crypto.randomUUID(), fingerprint };
      return apiFetch<{ reservation: SubmittedReservation }>("/api/customer/reservations", {
        method: "POST",
        body: { ...body, idempotencyKey: idempotency.current.key },
      });
    },
    onMutate: () => setBanner(null),
    onSuccess: ({ reservation }) => {
      qc.removeQueries({ queryKey: queryKeys.availability });
      void qc.invalidateQueries({ queryKey: queryKeys.reservations });
      void qc.invalidateQueries({ queryKey: queryKeys.accounts });
      navigate(`/book/success/${reservation.id}`, { replace: true });
    },
    onError: (e) => {
      if (isApiError(e, 409, "slot_unavailable") || isApiError(e, 400, "too_soon")) {
        setSlot(null);
        setBanner({ step: 1, tone: "warning", text: t(e.code === "too_soon" ? "web.book.errors.tooSoon" : "web.book.errors.slotTaken") });
        void qc.invalidateQueries({ queryKey: queryKeys.availability });
        goTo(1, true);
      } else if (isApiError(e, 409, "limit_reached")) {
        setBanner({ step: 3, tone: "warning", text: t("web.book.errors.limitReached"), action: "my" });
      } else if (isApiError(e, 403, "not_eligible")) {
        setBanner({ step: 3, tone: "error", text: t("web.book.errors.notEligible") });
        void qc.invalidateQueries({ queryKey: queryKeys.accounts });
      } else if (isApiError(e, 409, "idempotency_conflict")) {
        idempotency.current = null;
        goTo(2, true);
        setBanner({ step: 2, tone: "error", text: t("web.errors.generic") });
      } else if (isApiError(e, 400)) {
        goTo(2, true);
        setBanner({ step: 2, tone: "error", text: t("web.book.errors.invalid") });
      } else if (isApiError(e, 429)) {
        setBanner({ step: 3, tone: "error", text: t("web.errors.rateLimited") });
      } else if (isApiError(e, 503)) {
        setBanner({ step: 3, tone: "warning", text: t("web.errors.busy"), action: "retry" });
      } else if (!isApiError(e, 401)) {
        setBanner({ step: 3, tone: "error", text: t(isApiError(e, 0) ? "web.errors.network" : "web.errors.generic"), action: "retry" });
      }
    },
  });

  function chooseAccount(id: number) {
    setAccountId(id);
    setBanner(null);
  }

  function changeDetail(field: keyof Details, value: string) {
    edited.current.add(field);
    const next = { ...details, [field]: value };
    setDetails(next);
    if (errors[field]) setErrors((e) => ({ ...e, [field]: validateDetails(next)[field] }));
  }

  function continueFromTime() {
    if (!account) {
      setBanner({ step: 1, tone: "error", text: t("web.book.account.required") });
      return;
    }
    setBanner(null);
    goTo(2);
  }

  function continueFromDetails(e: FormEvent) {
    e.preventDefault();
    const errs = validateDetails(details);
    setErrors(errs);
    const first = (["contactName", "phone", "issue"] as const).find((f) => errs[f]);
    if (first) {
      fieldRefs[first].current?.focus();
      return;
    }
    setBanner(null);
    goTo(3);
  }

  const summary = slot ? (
    <>
      <span className="block font-semibold">{fmtShortDate(dateIn(slot.startAt, tz))}</span>
      <span className="block text-slate-600 tabular-nums dark:text-slate-400">{fmtTimeRange(slot.startAt, slot.endAt, tz)}</span>
      <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{fmtTz(tz, slot.startAt)}</span>
    </>
  ) : (
    <span className="text-slate-600 dark:text-slate-400">{t("web.book.bar.noSelection")}</span>
  );

  const headingClass = "text-lg font-semibold outline-none";

  return (
    <div className="space-y-6 pb-28 sm:pb-0">
      <Steps current={step} onGo={(s) => goTo(s)} />

      <div aria-live="polite" className="empty:mb-0">
        {banner && banner.step === step && (
          <Notice tone={banner.tone} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <span>{banner.text}</span>
            {banner.action === "my" && (
              <Link to="/my" className="inline-flex min-h-11 items-center font-semibold underline underline-offset-2">
                {t("web.book.errors.limitLink")}
              </Link>
            )}
            {banner.action === "retry" && step === 3 && (
              <Button variant="secondary" onClick={() => submit.mutate()} loading={submit.isPending}>
                {t("web.common.retry")}
              </Button>
            )}
          </Notice>
        )}
      </div>

      {step === 1 && (
        <div className="space-y-8">
          {accounts.length > 1 && <AccountPicker accounts={accounts} value={accountId} onChange={chooseAccount} />}
          <section aria-labelledby="day-heading" className="space-y-3">
            <h2 id="day-heading" ref={stepHeading} tabIndex={-1} className={headingClass}>
              {t("web.book.date.heading")}
            </h2>
            {avail.isPending ? (
              <StripSkeleton />
            ) : avail.isError && days.length === 0 ? (
              <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
                {t("web.book.date.loadFailed")}
                <Button variant="secondary" onClick={() => void avail.refetch()}>
                  {t("web.common.retry")}
                </Button>
              </Notice>
            ) : !days.some((d) => d.slots.length > 0) && !avail.hasNextPage ? (
              <EmptyState title={t("web.book.date.noneAtAll")} />
            ) : (
              <DateStrip
                days={days}
                selected={date}
                onSelect={setDate}
                hasMore={avail.hasNextPage}
                loadingMore={avail.isFetchingNextPage}
                onLoadMore={() => void avail.fetchNextPage()}
              />
            )}
          </section>
          <section aria-labelledby="time-heading" className="space-y-3">
            <div>
              <h2 id="time-heading" className={headingClass}>
                {t("web.book.slot.heading")}
              </h2>
              {selectedDay && <p className="font-medium">{fmtLongDate(selectedDay.date)}</p>}
              <TimezoneNote tz={tz} atMs={selectedDay?.slots[0]?.startAt} className="mt-1" />
            </div>
            {avail.isPending ? (
              <SlotSkeleton />
            ) : selectedDay ? (
              <SlotList
                date={selectedDay.date}
                slots={selectedDay.slots}
                tz={tz}
                selected={slot?.startAt ?? null}
                onSelect={(s) => {
                  setSlot(s);
                  setBanner(null);
                }}
              />
            ) : days.length > 0 && avail.hasNextPage ? (
              <p className="text-slate-600 dark:text-slate-400">{t("web.book.date.noneInRange")}</p>
            ) : null}
          </section>
          <StickyBar
            summary={summary}
            action={
              <Button size="lg" disabled={!slot} onClick={continueFromTime}>
                {t("web.book.bar.next")}
              </Button>
            }
          />
        </div>
      )}

      {step === 2 && (
        <form id="details-form" onSubmit={continueFromDetails} noValidate className="space-y-6">
          <BackButton onClick={() => goTo(1)} />
          <h2 ref={stepHeading} tabIndex={-1} className={headingClass}>
            {t("web.book.details.heading")}
          </h2>
          <DetailsForm value={details} errors={errors} onChange={changeDetail} refs={fieldRefs} />
          <StickyBar
            summary={summary}
            action={
              <Button size="lg" type="submit">
                {t("web.book.bar.next")}
              </Button>
            }
          />
        </form>
      )}

      {step === 3 && account && slot && (
        <div className="space-y-6">
          <BackButton onClick={() => goTo(2)} />
          <div className="space-y-1">
            <h2 ref={stepHeading} tabIndex={-1} className={headingClass}>
              {t("web.book.review.heading")}
            </h2>
            <p className="text-slate-600 dark:text-slate-400">{t("web.book.review.lead")}</p>
          </div>
          <ReviewCard account={account} slot={slot} tz={tz} details={details} email={email} onEdit={(s) => goTo(s)} />
          <StickyBar
            summary={summary}
            action={
              <Button size="lg" loading={submit.isPending} onClick={() => submit.mutate()}>
                {submit.isPending ? t("web.book.review.sending") : t("web.book.review.submit")}
              </Button>
            }
          />
        </div>
      )}
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" onClick={onClick} className="-ml-3">
      <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M19 12H5m5 5-5-5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {t("web.common.back")}
    </Button>
  );
}

function StripSkeleton() {
  return (
    <div className="-mx-4 flex gap-2 overflow-hidden px-4 pt-1 pb-3 sm:mx-0 sm:grid sm:grid-cols-7 sm:px-0">
      {Array.from({ length: 7 }, (_, i) => (
        <Skeleton key={i} className="h-20 w-16 shrink-0 sm:w-auto" />
      ))}
    </div>
  );
}

function SlotSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-16" />
      ))}
    </div>
  );
}

function BookSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true">
      <span className="sr-only">{t("web.common.loading")}</span>
      <Skeleton className="h-11" />
      <StripSkeleton />
      <SlotSkeleton />
    </div>
  );
}
