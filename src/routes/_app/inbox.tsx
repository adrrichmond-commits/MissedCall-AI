import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getInboxListFn, getConversationThreadFn, setConversationFeedbackFn, type InboxThreadData } from "~/lib/server/appFns";
import { EmptyState, ErrorState, PageHeader, PageLoading, StatusBadge } from "~/components/app/pageStates";
import { formatDateTime } from "~/lib/format";

type InboxSearch = { c?: string };

export const Route = createFileRoute("/_app/inbox")({
  validateSearch: (s: Record<string, unknown>): InboxSearch => ({
    c: typeof s.c === "string" ? s.c : undefined,
  }),
  loaderDeps: ({ search }) => [search.c],
  loader: async () => {
    const res = await getInboxListFn();
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  pendingComponent: PageLoading,
  errorComponent: () => (
    <ErrorState message="The inbox couldn't load. Check your connection and retry." onRetry={() => window.location.reload()} />
  ),
  component: InboxPage,
});

function InboxPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const selectedId = search.c ?? data.conversations[0]?.id ?? null;

  const [thread, setThread] = useState<InboxThreadData | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  // P3-H state sweep: retry bumps this nonce so a failed thread load actually
  // re-fetches. (Navigating to the already-selected conversation was a no-op —
  // the effect only ran on selectedId changes — so "Try again" did nothing.)
  const [threadNonce, setThreadNonce] = useState(0);

  useEffect(() => {
    if (!selectedId) {
      setThread(null);
      return;
    }
    let alive = true;
    setThreadLoading(true);
    setThreadError(null);
    getConversationThreadFn({ data: { conversationId: selectedId } })
      .then((res) => {
        if (!alive) return;
        if (res.ok) {
          setThread(res.data);
        } else if (res.status === 404) {
          setThread(null);
          setThreadError("That conversation doesn't exist or belongs to another business.");
        } else {
          setThread(null);
          setThreadError(res.error);
        }
      })
      .catch(() => {
        if (alive) setThreadError("The conversation couldn't load. Retry from the list.");
      })
      .finally(() => {
        if (alive) setThreadLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selectedId, threadNonce]);

  function selectConversation(id: string) {
    navigate({ to: "/inbox", search: { c: id } });
  }

  const filtered = data.conversations;

  return (
    <div>
      <PageHeader
        title="Inbox"
        description="SMS conversations the AI assistant is having with your customers."
      />

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        {/* Conversation list */}
        <div className="rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-semibold text-slate-900">Conversations ({data.total})</p>
          </div>
          {data.conversations.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No conversations"
                description="When the AI assistant texts a customer about a missed call, the thread shows up here."
              />
            </div>
          ) : (
            <ul className="max-h-[560px] overflow-y-auto divide-y divide-slate-100">
              {filtered.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => selectConversation(c.id)}
                    className={`w-full px-4 py-3 text-left transition-colors ${
                      c.id === selectedId ? "bg-brand-50" : "hover:bg-slate-50"
                    }`}
                    aria-current={c.id === selectedId ? "true" : undefined}
                    data-testid={`convo-${c.id}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-semibold text-slate-900">
                        {c.leadName ?? c.customerPhone}
                      </p>
                      <StatusBadge status={c.status} />
                    </div>
                    <p className="mt-0.5 truncate text-sm text-slate-600">
                      {c.lastMessageDirection === "outbound" ? "You: " : ""}
                      {c.lastMessageBody ?? "No messages yet"}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {c.serviceNeed ? `${c.serviceNeed} · ` : ""}
                      {c.messageCount} messages
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Thread view */}
        <div className="rounded-xl border border-slate-200 bg-white flex flex-col" style={{ minHeight: 480 }}>
          {threadLoading ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <PageLoading label="Loading conversation…" />
            </div>
          ) : threadError ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <div className="w-full max-w-md">
                <ErrorState message={threadError} onRetry={() => setThreadNonce((n) => n + 1)} />
              </div>
            </div>
          ) : !thread ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <EmptyState
                title="Select a conversation"
                description="Pick a thread on the left to read the SMS exchange with your customer."
              />
            </div>
          ) : (
            <>
              <div className="border-b border-slate-100 px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      {thread.conversation.leadName ?? thread.conversation.customerPhone}
                    </p>
                    <p className="text-xs text-slate-500">
                      {thread.conversation.customerPhone}
                      {thread.conversation.serviceNeed ? ` · ${thread.conversation.serviceNeed}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={thread.conversation.status} />
                    {thread.conversation.leadId ? (
                      <a
                        href={`/leads/${thread.conversation.leadId}`}
                        className="text-xs font-semibold text-brand-700 hover:text-brand-800"
                      >
                        View lead →
                        </a>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto p-4 sm:p-5" aria-live="polite">
                {thread.messages.map((m) => (
                  <div key={m.id} className={`flex ${m.direction === "outbound" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm sm:max-w-[70%] ${
                        m.direction === "outbound"
                          ? "bg-brand-600 text-white"
                          : "bg-slate-100 text-slate-900"
                      }`}
                    >
                      <p className="whitespace-pre-wrap">{m.body}</p>
                      <p className={`mt-1 text-right text-[10px] ${m.direction === "outbound" ? "text-brand-100" : "text-slate-400"}`}>
                        {formatDateTime(m.sentAt)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="border-t border-slate-100 px-4 py-3 sm:px-5">
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Replying from here isn't available yet — the AI assistant handles customer replies. Phase 2 adds manual sending.
                </p>
                {/* P4-A: "How did MissedCall AI handle this?" — per-conversation
                    owner feedback. Ratings land in the AI quality view. */}
                <ConversationFeedback
                  conversationId={thread.conversation.id}
                  initialRating={thread.conversation.feedbackRating}
                  initialNote={thread.conversation.feedbackNote}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** P4-A feedback affordance: thumbs up/down + optional note on this thread. */
function ConversationFeedback(props: {
  conversationId: string;
  initialRating: "up" | "down" | null;
  initialNote: string | null;
}) {
  const [rating, setRating] = useState<"up" | "down" | null>(props.initialRating);
  const [note, setNote] = useState(props.initialNote ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save(nextRating: "up" | "down") {
    setBusy(true);
    setMsg(null);
    try {
      const res = await setConversationFeedbackFn({
        data: { conversationId: props.conversationId, rating: nextRating, note },
      });
      if (res.ok) {
        setRating(res.data.rating);
        setMsg("Thanks — recorded.");
      } else {
        setMsg(res.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
      <p className="text-xs font-semibold text-slate-700">How did MissedCall AI handle this?</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void save("up")}
          disabled={busy}
          className={
            "rounded-md border px-3 py-1 text-xs font-semibold disabled:opacity-50 " +
            (rating === "up"
              ? "border-emerald-500 bg-emerald-50 text-emerald-700"
              : "border-slate-300 bg-white text-slate-600 hover:bg-slate-100")
          }
        >
          👍 Good
        </button>
        <button
          type="button"
          onClick={() => void save("down")}
          disabled={busy}
          className={
            "rounded-md border px-3 py-1 text-xs font-semibold disabled:opacity-50 " +
            (rating === "down"
              ? "border-red-400 bg-red-50 text-red-700"
              : "border-slate-300 bg-white text-slate-600 hover:bg-slate-100")
          }
        >
          👎 Needs work
        </button>
        {msg ? <span className="text-xs text-slate-500">{msg}</span> : null}
      </div>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={1000}
        placeholder="Optional note (saved with your next rating)"
        className="mt-2 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs focus:border-brand-500 focus:outline-none"
      />
    </div>
  );
}
