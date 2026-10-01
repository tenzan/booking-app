import type { Account } from "../../../api";
import { t } from "../../../i18n";

/** Radio cards; only shown when the email is a contact for more than one account. */
export function AccountPicker({ accounts, value, onChange }: { accounts: Account[]; value: number | null; onChange: (id: number) => void }) {
  return (
    <fieldset>
      <legend className="mb-3 text-lg font-semibold">{t("web.book.account.heading")}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {accounts.map((a) => (
          <label
            key={a.id}
            className="flex min-h-16 cursor-pointer items-center gap-3 rounded-xl border border-slate-300 bg-white px-4 py-3 has-checked:border-blue-700 has-checked:bg-blue-50 has-checked:ring-1 has-checked:ring-blue-700 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-blue-600 dark:border-slate-600 dark:bg-slate-900 dark:has-checked:border-blue-400 dark:has-checked:bg-blue-400/10 dark:has-checked:ring-blue-400"
          >
            <input
              type="radio"
              name="account"
              value={a.id}
              checked={value === a.id}
              onChange={() => onChange(a.id)}
              className="size-5 shrink-0 accent-blue-700 focus-visible:outline-none"
            />
            <span className="min-w-0">
              <span className="block font-medium break-words">{a.name}</span>
              <span className="block text-sm text-slate-600 dark:text-slate-400">{t("web.book.account.number", { number: a.customerNumber })}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
