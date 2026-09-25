/**
 * P4-V (owner requirement 12): demo mode must be VISIBLY labeled.
 *
 * Rendered at the top of every authenticated page when the session's business
 * is the seeded demo business (businesses.is_demo, migration 018). Persistent
 * and undismissable on purpose: sample leads, conversations, and revenue must
 * never be mistaken for a real shop's numbers. It states plainly that the data
 * is sample data — no fake production claims.
 */
export function DemoBanner() {
  return (
    <div
      data-testid="demo-banner"
      className="border-b border-violet-200 bg-violet-50 px-4 py-2.5 sm:px-6"
      role="note"
      aria-label="Demo mode"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center rounded-full bg-violet-600 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-white">
          Demo
        </span>
        <p className="text-sm text-violet-900">
          You&apos;re viewing the MissedCall AI demo business — everything here is{" "}
          <strong>sample data</strong>, not your numbers.{" "}
          <a href="/signup" className="font-semibold underline hover:text-violet-700">
            Start your free trial
          </a>{" "}
          to use MissedCall AI on your own business.
        </p>
      </div>
    </div>
  );
}
