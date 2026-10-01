import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Link, type LinkProps } from "react-router";
import { Spinner } from "./Spinner";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors select-none disabled:cursor-not-allowed disabled:opacity-60";
const variants: Record<Variant, string> = {
  primary: "bg-blue-700 text-white hover:bg-blue-800 active:bg-blue-900 dark:bg-blue-600 dark:hover:bg-blue-700",
  secondary:
    "border border-slate-300 bg-white text-slate-900 hover:bg-slate-100 active:bg-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800",
  ghost: "text-blue-700 hover:bg-blue-50 active:bg-blue-100 dark:text-blue-300 dark:hover:bg-slate-800",
  danger: "bg-red-700 text-white hover:bg-red-800 active:bg-red-900 dark:bg-red-600 dark:hover:bg-red-700",
};
const sizes: Record<Size, string> = {
  md: "min-h-11 px-4 text-base",
  lg: "min-h-13 px-6 text-lg",
};

export const buttonClass = (variant: Variant = "primary", size: Size = "md", block = false): string =>
  `${base} ${variants[variant]} ${sizes[size]} ${block ? "w-full" : ""}`;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  /** Disables the button and shows a spinner; `children` should then say what is happening. */
  loading?: boolean;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant, size, block, loading = false, disabled, className = "", children, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`${buttonClass(variant, size, block)} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function ButtonLink({ variant, size, block, className = "", ...rest }: LinkProps & { variant?: Variant; size?: Size; block?: boolean }) {
  return <Link className={`${buttonClass(variant, size, block)} ${className}`} {...rest} />;
}
