/**
 * Client banner for the authenticated app: when the current session is an
 * admin impersonating a customer account, show the persistent "Viewing as
 * <business> — admin session" banner with an Exit control on EVERY /app
 * page. Reads state via getImpersonationStateFn (safe for any session).
 */
import { useEffect, useState } from "react";
import { getImpersonationStateFn, exitImpersonationFn } from "~/lib/server/adminFns";

export function AdminViewingBanner() {
  const [state, setState] = useState<{ active: boolean; viewedBusinessName: string | null; adminEmail: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getImpersonationStateFn()
      .then((s) => {
        if (alive) setState(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!state?.active) return null;

  async function exit() {
    setBusy(true);
    try {
      const res = await exitImpersonationFn();
      if (res.ok) window.location.href = "/admin/accounts";
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-b-2 border-amber-600 bg-amber-400 px-4 py-2.5 text-amber-950">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold">
          Viewing as {state.viewedBusinessName} — admin session
          {state.adminEmail ? (
            <span className="ml-2 text-xs font-normal opacity-80">({state.adminEmail})</span>
          ) : null}
        </p>
        <button
          type="button"
          onClick={exit}
          disabled={busy}
          className="rounded-md border border-amber-700 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900 hover:bg-white disabled:opacity-50"
        >
          {busy ? "Exiting…" : "Exit view-as"}
        </button>
      </div>
    </div>
  );
}
