/**
 * Structured server-side logger (P4-I).
 *
 * JSON-lines to stdout — one JSON object per line so a log collector (or the
 * platform's log viewer) can index events without a regex parser. NO external
 * service is required; when the owner later wires a paid log drain, the drain
 * reads this process's stdout and nothing in application code changes.
 *
 * Levels: error < warn < info < debug. LOG_LEVEL env picks the minimum level
 * that is emitted (default "info"). Set LOG_LEVEL=debug temporarily when
 * diagnosing; never ship debug defaults to production.
 *
 * Every line carries ts/level/msg; callers add structured fields (never
 * secret material — no connection strings, tokens, passwords, or full
 * request bodies). Plain console.error lines elsewhere in the app still
 * appear in the log stream; new instrumentation should prefer this module.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
function minLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").trim().toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}
function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] > LEVEL_ORDER[minLevel()]) return;
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      line[k] = v instanceof Error ? (v.stack ?? v.message) : v;
    }
  }
  // One line per event — JSON.stringify of a flat object cannot emit newlines
  // (string values are escaped), so collectors can split on \n safely.
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else console.log(text);
}
export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
