import type { ReactNode } from "react";

type Tone = "brand" | "aqua" | "slate" | "amber" | "red" | "green";

const tones: Record<Tone, string> = {
  brand: "bg-brand-50 text-brand-700 ring-brand-600/20",
  aqua: "bg-aqua-50 text-aqua-700 ring-aqua-600/20",
  slate: "bg-slate-100 text-slate-700 ring-slate-600/20",
  amber: "bg-amber-50 text-amber-800 ring-amber-600/20",
  red: "bg-red-50 text-red-700 ring-red-600/20",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
};

export function Badge({
  tone = "slate",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${tones[tone]} ${className ?? ""}`}
    >
      {children}
    </span>
  );
}
