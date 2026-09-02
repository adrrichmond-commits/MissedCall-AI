import type { ReactNode } from "react";

/**
 * Shared card layout for the auth pages (login/signup/forgot/reset/verify).
 * Mirrors the landing page design system: white card on a soft brand-tinted
 * backdrop, Button/Badge primitives, consistent footer links.
 */
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-slate-50">
      <header className="px-6 py-5">
        <a href="/" className="inline-flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            M
          </span>
          <span className="text-base font-bold tracking-tight text-slate-900">MissedCall AI</span>
        </a>
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 pb-16 sm:px-6">
        <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
          {subtitle ? <p className="mt-2 text-sm text-slate-600">{subtitle}</p> : null}
          <div className="mt-6">{children}</div>
        </div>
        {footer ? <div className="mt-6 text-center text-sm text-slate-600">{footer}</div> : null}
      </main>
    </div>
  );
}

/** Red inline error banner for form errors. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
      {message}
    </div>
  );
}

/** Green/brand success banner. */
export function FormSuccess({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
      role="status"
    >
      {message}
    </div>
  );
}

/** Amber "delivery pending" notice used on token flows (no email provider yet). */
export function DeliveryPendingNotice({ context }: { context: string }) {
  return (
    <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-800">
      <strong className="font-semibold">Email delivery pending:</strong> {context} We have not
      connected an email provider yet, so no email is actually sent.
    </p>
  );
}
