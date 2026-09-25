/**
 * /admin/prompts — P4-A runtime AI prompt editor (platform-owner only).
 *
 * Edits the AI system-prompt overlays WITHOUT a redeploy: saving creates a
 * new version (full history, who/when) and activates it — the next
 * conversation reads the active row (30s cache). Revert flips the active
 * pointer to any prior version; nothing is ever deleted.
 *
 * SAFETY: the overlay is APPENDED after the code's guardrail prompt and can
 * never weaken the safety policy — the editor states this explicitly.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { adminPromptsDataFn, revertPromptVersionFn, savePromptVersionFn } from "~/lib/server/adminFns";
import type { P4APromptsView } from "~/lib/server/adminReads";

export const Route = createFileRoute("/admin/prompts")({
  loader: async (): Promise<P4APromptsView> => {
    // PR #27 SSR rule: plain read during SSR, RPC in the browser.
    if (import.meta.env.SSR) {
      const { adminPromptsPage } = await import("~/lib/server/adminReads");
      const res = await adminPromptsPage();
      if (!res.ok) throw new Error(res.error);
      return res.data;
    }
    const res = await adminPromptsDataFn();
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  component: PromptsPage,
});

const SURFACE_HELP: Record<string, string> = {
  lead_capture:
    "Applied to the missed-call SMS assistant's classification/reply prompt on every inbound text.",
  receptionist:
    "Applied to the AI receptionist's post-call summary prompt. Call-flow policies (greeting, transfer rules, FAQ) are configured per business in the Receptionist studio.",
};

function PromptsPage() {
  const data = Route.useLoaderData() as P4APromptsView;
  const [selected, setSelected] = useState(0);
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const surface = data.surfaces[selected];

  async function save() {
    if (!surface) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await savePromptVersionFn({ data: { surface: surface.surface, body, note } });
      setMessage(
        res.ok
          ? "Saved as version " + res.data.version + " — active for the next conversation."
          : res.error,
      );
      if (res.ok) {
        setBody("");
        setNote("");
        window.location.reload();
      }
    } finally {
      setBusy(false);
    }
  }

  async function revert(version: number) {
    if (!surface) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await revertPromptVersionFn({ data: { surface: surface.surface, version } });
      setMessage(
        res.ok ? "Reverted to version " + res.data.version + "." : res.error,
      );
      if (res.ok) window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 lg:text-2xl">AI prompts</h1>
          <p className="mt-1 text-sm text-slate-600">
            Runtime prompt overlays — changes take effect on the next conversation, no deploy.
            Full version history; revert to any prior version.
          </p>
        </div>
        <nav className="flex items-center gap-3 text-sm">
          <a href="/admin/accounts" className="text-slate-600 hover:text-brand-700">Accounts</a>
          <a href="/admin/funnel" className="text-slate-600 hover:text-brand-700">Funnel</a>
          <a href="/admin/prompts" className="font-semibold text-brand-700">AI prompts</a>
          <a href="/admin/health" className="text-slate-600 hover:text-brand-700">System health</a>
          <a href="/admin/audit" className="text-slate-600 hover:text-brand-700">Audit log</a>
        </nav>
      </div>

      <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Safety: your text is APPENDED after the built-in safety and honesty rules — it can add
        operating instructions but never weaken or override them. When an instruction here conflicts
        with the safety policy, the safety policy wins.
      </div>

      <div className="mt-5 flex gap-2">
        {data.surfaces.map((s, i) => (
          <button
            key={s.surface}
            type="button"
            onClick={() => {
              setSelected(i);
              setMessage(null);
            }}
            className={
              "rounded-lg border px-3 py-1.5 text-sm font-medium " +
              (i === selected
                ? "border-brand-500 bg-brand-50 text-brand-700"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
            }
          >
            {s.label}
          </button>
        ))}
      </div>

      {surface ? (
        <>
          <p className="mt-3 text-xs text-slate-500">{SURFACE_HELP[surface.surface]}</p>
          {surface.activeVersion !== null ? (
            <p className="mt-1 text-xs text-emerald-700">
              Active: version {surface.activeVersion}.
            </p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">
              No custom overlay active — the built-in code default is in use.
            </p>
          )}

          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">New version</h2>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              maxLength={8000}
              placeholder="Extra operating instructions for the AI (appended after the safety policy)…"
              className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              placeholder="Change note (optional, shown in history)"
              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy || body.trim().length === 0}
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save & activate"}
              </button>
              {message ? <span className="text-sm text-slate-600">{message}</span> : null}
            </div>
          </div>

          <h2 className="mt-6 text-sm font-semibold text-slate-900">Version history</h2>
          {surface.versions.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">
              No custom versions yet — the code default (with the KB safety policy) is used verbatim.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {surface.versions.map((v) => (
                <li key={v.id} className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-900">
                      Version {v.version}
                      {v.isActive ? (
                        <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                          active
                        </span>
                      ) : null}
                    </p>
                    {!v.isActive ? (
                      <button
                        type="button"
                        onClick={() => void revert(v.version)}
                        disabled={busy}
                        className="rounded-md border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        Revert to this version
                      </button>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {v.editedBy ?? "unknown editor"} · {v.createdAt}
                    {v.note ? " · " + v.note : ""}
                  </p>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
                    {v.body}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}
