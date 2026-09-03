import type { ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md" | "lg";

type AnchorButtonProps = {
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
  href: string;
  onClick?: () => void;
};

type ButtonButtonProps = {
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
  href?: undefined;
  onClick?: () => void;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
};

// No whitespace-nowrap: long labels (e.g. the demo hero CTA) must wrap on
// narrow viewports instead of pushing the button past the screen edge.
const base =
  "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50";

const variants: Record<Variant, string> = {
  primary: "bg-brand-600 text-white shadow-sm hover:bg-brand-700",
  secondary:
    "bg-white text-slate-900 ring-1 ring-inset ring-slate-300 hover:bg-slate-50",
  ghost: "text-brand-700 hover:bg-brand-50",
};

const sizes: Record<Size, string> = {
  sm: "h-9 px-3.5 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
};

export function Button(props: AnchorButtonProps | ButtonButtonProps) {
  const cls = [
    base,
    variants[props.variant ?? "primary"],
    sizes[props.size ?? "md"],
    props.className,
  ]
    .filter(Boolean)
    .join(" ");

  if (props.href) {
    return (
      <a href={props.href} className={cls} onClick={props.onClick}>
        {props.children}
      </a>
    );
  }

  const { type, disabled, children } = props as ButtonButtonProps;
  return (
    <button className={cls} onClick={props.onClick} type={type ?? "button"} disabled={disabled}>
      {children}
    </button>
  );
}
