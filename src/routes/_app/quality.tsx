/**
 * /quality — P4-A owner view: customer feedback + AI-quality review queue.
 *
 * HONESTY: no seeded feedback and no fabricated stats — empty states say
 * exactly what has and hasn't happened yet. Real volume arrives with launch.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  getQualityPageDataFn,
  resolveReviewFlagFn,
  type QualityPageData,
} from "~/lib/server/appFns";
import { PageHeader, PageLoading, ErrorState } from "~/components/app/pageStates";
import { formatDateTime } from "~/lib/format";

export const Route = createFileRoute("/_app/quality")({
  loader: async (): Promise<QualityPageData> => {
    const res = await getQualityPageDataFn();
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  pendingComponent: PageLoading,
  errorComponent: () => (
    <ErrorState message="Quality data couldn't load. Check your connection and retry." onRetry={() => window.location.reload()} />
  ),
  component: QualityPage,
});

function QualityPage() {
  const data = Route.useLoaderData() as QualityPageData;
  const [resolving, setResolving] = useState<string | null>(null);
  void resolving;

  async function resolve(flagId: string) {
    setResolving(flagId);
    try {
      const res = await resolveReviewFlagFn({ data: { flagId } });
      if (res.ok) window.location.reload();
    } finally {
      setResolving(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <PageHeader
        title="AI quality & feedback"
        description="How the AI is handling your customers — and anything that needs a human look."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm font-medium text-slate-600">Positive feedback</p>
          <p className="mt-3 text-2xl font-bold tracking-tight text-slate-900 lg:text-3xl">
            {data.feedback.positivePct === null ? "—" : data.feedback.positivePct + "%"}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {data.feedback.total === 0
              ? "No feedback yet — rate conversations from the inbox."
              : data.feedback.total + " rating" + (data.feedback.total === 1 ? "" : "s") + " (" + data.feedback.up + " up / " + data.feedback.down + " down)"}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm font-medium text-slate-600">Needs review</p>
          <p className="mt-3 text-2xl font-bold tracking-tight text-slate-900 lg:text-3xl">
            {data.openFlagCount}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {data.openFlagCount === 0 ? "Nothing flagged right now." : "Conversations a human should look at."}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm font-medium text-slate-600">AI turns handled</p>
          <p className="mt-3 text-2xl font-bold tracking-tight text-slate-900 lg:text-3xl">
            {data.ai ? data.ai.classifiedTurns : 0}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {data.ai && data.ai.avgLatencyMs !== null
              ? "Avg last-turn response " + (data.ai.avgLatencyMs / 1000).toFixed(1) + "s"
              : "No AI turns yet."}
          </p>
        </div>
      </div>

      <h2 className="mt-8 text-sm font-semibold text-slate-900">Review queue</h2>
      {data.openFlags.length === 0 ? (
        <p className="mt-2 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
          Nothing is flagged. Conversations get flagged for: negative owner feedback, an emergency
          that didn't complete escalation, repeated AI failures, no contact captured after several
          turns, or very slow responses.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {data.openFlags.map((f) => (
            <li key={f.id} className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-amber-900">{f.reasonLabel}</p>
                <button
                  type="button"
                  onClick={() => void resolve(f.id)}
                  className="rounded-md border border-amber-300 bg-white px-3 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100"
                >
                  Mark reviewed
                </button>
              </div>
              <p className="mt-1 text-xs text-amber-800">
                {f.leadName ?? f.customerPhone} · flagged {formatDateTime(f.createdAt)}
                {f.detail ? " · " + f.detail : ""}
              </p>
              <Link
                to="/inbox"
                search={{ c: f.conversationId }}
                className="mt-1 inline-block text-xs font-semibold text-brand-700 hover:underline"
              >
                Open conversation →
              </Link>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-8 text-sm font-semibold text-slate-900">Recent feedback</h2>
      {data.recent.length === 0 ? (
        <p className="mt-2 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
          No feedback yet. After the AI handles a text conversation, rate it from the inbox with
          "How did MissedCall AI handle this?" — your ratings show up here.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {data.recent.map((r) => (
            <li key={r.conversationId} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-900">
                  <span className={r.rating === "up" ? "text-emerald-600" : "text-red-600"}>
                    {r.rating === "up" ? "👍 Helpful" : "👎 Not helpful"}
                  </span>
                  <span className="ml-2 text-slate-500">{r.leadName ?? r.customerPhone}</span>
                </p>
                <span className="text-xs text-slate-400">{formatDateTime(r.at)}</span>
              </div>
              {r.note ? <p className="mt-1 text-sm text-slate-600">{r.note}</p> : null}
              <Link
                to="/inbox"
                search={{ c: r.conversationId }}
                className="mt-1 inline-block text-xs font-semibold text-brand-700 hover:underline"
              >
                Open conversation →
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
