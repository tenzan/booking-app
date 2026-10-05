import { useId } from "react";
import type { StaffDTO } from "../../../../shared/types";
import { TECH_COLORS } from "./colors";
import { k, type ColorOf } from "./items";

const CHIP =
  "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-slate-300 bg-white px-3.5 text-sm font-medium text-slate-800 hover:bg-slate-100 has-checked:ring-1 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-blue-600 lg:min-h-9 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";

/**
 * Technician filter as chips: everyone at a glance, each with the colour their bookings wear (so the chips are the
 * legend too). One is chosen at a time; "Everyone" clears it. The signed-in staff member comes first, marked "(You)".
 */
export function TechChips({
  staff,
  value,
  meId,
  colorOf,
  unknownName,
  onChange,
}: {
  /** Active staff. */
  staff: StaffDTO[];
  value: number | null;
  meId: number | null;
  colorOf: ColorOf;
  /** The filtered technician when not among `staff` (deactivated since): still shown so the filter can be seen and cleared. */
  unknownName: string | null;
  onChange: (staffId: number | null) => void;
}) {
  const name = useId();
  const labelId = useId();
  const me = staff.find((s) => s.id === meId);
  const ordered = [...(me ? [me] : []), ...staff.filter((s) => s.id !== meId).sort((a, b) => a.name.localeCompare(b.name))];
  const extra = value !== null && !staff.some((s) => s.id === value) ? [{ id: value, name: unknownName ?? k("unknownTech") }] : [];
  return (
    <div>
      <p id={labelId} className="mb-1.5 text-sm font-medium">
        {k("techLabel")}
      </p>
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-2">
        <label className={`${CHIP} has-checked:border-slate-900 has-checked:bg-slate-900 has-checked:text-white has-checked:ring-slate-900 dark:has-checked:border-slate-100 dark:has-checked:bg-slate-100 dark:has-checked:text-slate-900`}>
          <input type="radio" name={name} checked={value === null} onChange={() => onChange(null)} className="sr-only" />
          {k("everyone")}
        </label>
        {[...ordered, ...extra].map((s) => {
          const color = colorOf(s.id);
          return (
            <label key={s.id} className={`${CHIP} ${TECH_COLORS[color]!.chip}`}>
              <input type="radio" name={name} checked={value === s.id} onChange={() => onChange(s.id)} className="sr-only" />
              <span data-tech-color={color} className={`size-2.5 shrink-0 rounded-full ${TECH_COLORS[color]!.dot}`} aria-hidden="true" />
              {s.id === meId ? k("you", { name: s.name }) : s.name}
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** Week / Month: a segmented control, like Show. */
export function ViewSwitch({ value, onChange }: { value: "week" | "month"; onChange: (v: "week" | "month") => void }) {
  const name = useId();
  const labelId = useId();
  return (
    <div>
      <p id={labelId} className="mb-1.5 text-sm font-medium">
        {k("viewLabel")}
      </p>
      <div role="radiogroup" aria-labelledby={labelId} className="grid grid-cols-2 rounded-xl border border-slate-300 bg-white p-1 dark:border-slate-600 dark:bg-slate-900">
        {(["week", "month"] as const).map((v) => (
          <label
            key={v}
            className="flex min-h-11 cursor-pointer items-center justify-center rounded-lg px-4 text-sm font-medium text-slate-700 hover:bg-slate-100 has-checked:bg-blue-700 has-checked:text-white has-checked:hover:bg-blue-700 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-blue-600 lg:min-h-9 dark:text-slate-300 dark:hover:bg-slate-800 dark:has-checked:bg-blue-600"
          >
            <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} className="sr-only" />
            {k(`view.${v}`)}
          </label>
        ))}
      </div>
    </div>
  );
}
