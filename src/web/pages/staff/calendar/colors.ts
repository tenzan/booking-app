import { TECH_COLOR_COUNT } from "../../../../domain/tech-colors";

/**
 * Technician colours for confirmed bookings, legible in light and dark mode. Amber (pending) and violet (proposed
 * times) are kept out: they mean a status, not a person. Class strings are spelled out so Tailwind keeps them.
 */
export const TECH_COLORS: ReadonlyArray<{ dot: string; block: string; soft: string; chip: string }> = [
  {
    dot: "bg-sky-500",
    block: "border-sky-600 bg-sky-50 text-sky-950 hover:bg-sky-100 dark:border-sky-400 dark:bg-sky-950 dark:text-sky-50 dark:hover:bg-sky-900",
    soft: "border-sky-600 bg-sky-50 text-sky-950 hover:bg-sky-100 dark:border-sky-400/70 dark:bg-sky-400/10 dark:text-sky-50 dark:hover:bg-sky-400/15",
    chip: "has-checked:border-sky-600 has-checked:bg-sky-50 has-checked:ring-sky-600 dark:has-checked:border-sky-400 dark:has-checked:bg-sky-400/15 dark:has-checked:ring-sky-400",
  },
  {
    dot: "bg-emerald-500",
    block: "border-emerald-600 bg-emerald-50 text-emerald-950 hover:bg-emerald-100 dark:border-emerald-400 dark:bg-emerald-950 dark:text-emerald-50 dark:hover:bg-emerald-900",
    soft: "border-emerald-600 bg-emerald-50 text-emerald-950 hover:bg-emerald-100 dark:border-emerald-400/70 dark:bg-emerald-400/10 dark:text-emerald-50 dark:hover:bg-emerald-400/15",
    chip: "has-checked:border-emerald-600 has-checked:bg-emerald-50 has-checked:ring-emerald-600 dark:has-checked:border-emerald-400 dark:has-checked:bg-emerald-400/15 dark:has-checked:ring-emerald-400",
  },
  {
    dot: "bg-rose-500",
    block: "border-rose-600 bg-rose-50 text-rose-950 hover:bg-rose-100 dark:border-rose-400 dark:bg-rose-950 dark:text-rose-50 dark:hover:bg-rose-900",
    soft: "border-rose-600 bg-rose-50 text-rose-950 hover:bg-rose-100 dark:border-rose-400/70 dark:bg-rose-400/10 dark:text-rose-50 dark:hover:bg-rose-400/15",
    chip: "has-checked:border-rose-600 has-checked:bg-rose-50 has-checked:ring-rose-600 dark:has-checked:border-rose-400 dark:has-checked:bg-rose-400/15 dark:has-checked:ring-rose-400",
  },
  {
    dot: "bg-indigo-500",
    block: "border-indigo-600 bg-indigo-50 text-indigo-950 hover:bg-indigo-100 dark:border-indigo-400 dark:bg-indigo-950 dark:text-indigo-50 dark:hover:bg-indigo-900",
    soft: "border-indigo-600 bg-indigo-50 text-indigo-950 hover:bg-indigo-100 dark:border-indigo-400/70 dark:bg-indigo-400/10 dark:text-indigo-50 dark:hover:bg-indigo-400/15",
    chip: "has-checked:border-indigo-600 has-checked:bg-indigo-50 has-checked:ring-indigo-600 dark:has-checked:border-indigo-400 dark:has-checked:bg-indigo-400/15 dark:has-checked:ring-indigo-400",
  },
  {
    dot: "bg-lime-500",
    block: "border-lime-600 bg-lime-50 text-lime-950 hover:bg-lime-100 dark:border-lime-400 dark:bg-lime-950 dark:text-lime-50 dark:hover:bg-lime-900",
    soft: "border-lime-600 bg-lime-50 text-lime-950 hover:bg-lime-100 dark:border-lime-400/70 dark:bg-lime-400/10 dark:text-lime-50 dark:hover:bg-lime-400/15",
    chip: "has-checked:border-lime-600 has-checked:bg-lime-50 has-checked:ring-lime-600 dark:has-checked:border-lime-400 dark:has-checked:bg-lime-400/15 dark:has-checked:ring-lime-400",
  },
  {
    dot: "bg-fuchsia-500",
    block: "border-fuchsia-600 bg-fuchsia-50 text-fuchsia-950 hover:bg-fuchsia-100 dark:border-fuchsia-400 dark:bg-fuchsia-950 dark:text-fuchsia-50 dark:hover:bg-fuchsia-900",
    soft: "border-fuchsia-600 bg-fuchsia-50 text-fuchsia-950 hover:bg-fuchsia-100 dark:border-fuchsia-400/70 dark:bg-fuchsia-400/10 dark:text-fuchsia-50 dark:hover:bg-fuchsia-400/15",
    chip: "has-checked:border-fuchsia-600 has-checked:bg-fuchsia-50 has-checked:ring-fuchsia-600 dark:has-checked:border-fuchsia-400 dark:has-checked:bg-fuchsia-400/15 dark:has-checked:ring-fuchsia-400",
  },
  {
    dot: "bg-teal-500",
    block: "border-teal-600 bg-teal-50 text-teal-950 hover:bg-teal-100 dark:border-teal-400 dark:bg-teal-950 dark:text-teal-50 dark:hover:bg-teal-900",
    soft: "border-teal-600 bg-teal-50 text-teal-950 hover:bg-teal-100 dark:border-teal-400/70 dark:bg-teal-400/10 dark:text-teal-50 dark:hover:bg-teal-400/15",
    chip: "has-checked:border-teal-600 has-checked:bg-teal-50 has-checked:ring-teal-600 dark:has-checked:border-teal-400 dark:has-checked:bg-teal-400/15 dark:has-checked:ring-teal-400",
  },
  {
    dot: "bg-orange-700",
    block: "border-orange-800 bg-orange-100 text-orange-950 hover:bg-orange-200 dark:border-orange-300 dark:bg-orange-950 dark:text-orange-50 dark:hover:bg-orange-900",
    soft: "border-orange-800 bg-orange-100 text-orange-950 hover:bg-orange-200 dark:border-orange-300/70 dark:bg-orange-400/10 dark:text-orange-50 dark:hover:bg-orange-400/15",
    chip: "has-checked:border-orange-800 has-checked:bg-orange-100 has-checked:ring-orange-800 dark:has-checked:border-orange-300 dark:has-checked:bg-orange-400/15 dark:has-checked:ring-orange-300",
  },
];

if (TECH_COLORS.length !== TECH_COLOR_COUNT) throw new Error("TECH_COLORS must match TECH_COLOR_COUNT");
