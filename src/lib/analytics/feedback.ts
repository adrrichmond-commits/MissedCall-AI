/**
 * P4-A customer feedback aggregation (pure, unit-tested).
 *
 * The owner thumbs-up/downs a conversation ("How did MissedCall AI handle
 * this?") in the inbox; the rows below are the stored per-conversation
 * results. Aggregation is honest: zero feedback → positivePct null (shown as
 * "no feedback yet"), never 0% or 100%.
 */
export type FeedbackRating = "up" | "down";

export interface FeedbackEntry {
  conversationId: string;
  rating: FeedbackRating;
  note: string | null;
  /** ISO string (client-safe); aggregation does not parse it. */
  at: string | null;
}

export interface FeedbackAggregate {
  total: number;
  up: number;
  down: number;
  /** Percent of ratings that are thumbs-up; null when there is no feedback. */
  positivePct: number | null;
}

/**
 * Aggregate feedback entries. Entries with a null/unknown rating are ignored
 * (a stored row always has a rating, but callers may pass raw partials).
 */
export function feedbackAggregate(entries: readonly { rating: string | null }[]): FeedbackAggregate {
  let up = 0;
  let down = 0;
  for (const e of entries) {
    if (e.rating === "up") up += 1;
    else if (e.rating === "down") down += 1;
  }
  const total = up + down;
  return {
    total,
    up,
    down,
    positivePct: total === 0 ? null : Math.round((up / total) * 100),
  };
}

/** The most recent N entries, newest first (at is ISO, so string sort works). */
export function recentFeedback<T extends { at: string | null }>(entries: readonly T[], n: number): T[] {
  return [...entries]
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .slice(0, Math.max(0, n));
}
