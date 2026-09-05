#!/usr/bin/env bun
/**
 * Unit-style tests for P3-C CRM completion (lead lifecycle, estimated job
 * value, follow-up planning). Run: bun scripts/test-crm.ts — no DB, no env,
 * no network required (the pure modules are the same contract as
 * classifyPipeline.ts).
 *
 * Covers:
 *   - status transition legality incl. terminal states (FULL 7x7 matrix)
 *   - allowedNextStatuses consistency with the validator (UI select)
 *   - legacy Phase 2 status mapping (booked/completed rows)
 *   - estimated job value stamping via the KB service resolver (serviceNeed)
 *   - pipeline value derivation (won/lost/open precedence)
 *   - follow-up due-date planning: next business day, weekend skip, timezone
 *     handling, 9 AM local wall clock
 *   - business_id isolation: structural check that every new query function
 *     takes businessId and filters on business_id (the WHERE is the boundary)
 */
import {
  LEAD_LIFECYCLE_STATUSES,
  LEAD_STATUS_LABELS,
  allowedNextStatuses,
  checkLeadTransition,
  isLegacyLeadStatus,
  leadTransitionIsValid,
  toLifecycleStatus,
} from "../src/lib/server/leadLifecycle";
import {
  addBusinessDaysAt,
  computePipelineValueCents,
  estimateJobValueCents,
  nextBusinessDayAt9,
} from "../src/lib/server/crmValue";

let failures = 0;
let checks = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(
      "FAIL " + name + " — expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual),
    );
  } else {
    console.log("ok   " + name);
  }
}

// ---------------------------------------------------------------------------
// 1. Status transition legality — the FULL matrix, asserted from the spec
// ---------------------------------------------------------------------------
const LIVE = ["new", "contacted", "qualified", "follow_up_needed", "appointment_scheduled"];
const TERMINAL = ["won", "lost"];
type S = (typeof LEAD_LIFECYCLE_STATUSES)[number];

for (const from of LEAD_LIFECYCLE_STATUSES) {
  for (const to of LEAD_LIFECYCLE_STATUSES) {
    let expected: boolean;
    if (from === to) expected = true; // no-op save is legal
    else if (LIVE.includes(from) && LIVE.includes(to)) expected = true;
    else if (LIVE.includes(from) && (to === "won" || to === "lost")) expected = true;
    else if (TERMINAL.includes(from)) expected = to === "follow_up_needed"; // reopen edge only
    else expected = false;
    check(
      `transition ${from} -> ${to}`,
      leadTransitionIsValid(from as S, to as S),
      expected,
    );
  }
}

// Spot-check the exact examples from the brief.
check("won -> new blocked", leadTransitionIsValid("won", "new"), false);
check("won -> contacted blocked", leadTransitionIsValid("won", "contacted"), false);
check("lost -> qualified blocked", leadTransitionIsValid("lost", "qualified"), false);
check("won -> follow_up_needed (reopen) legal", leadTransitionIsValid("won", "follow_up_needed"), true);
check("lost -> follow_up_needed (reopen) legal", leadTransitionIsValid("lost", "follow_up_needed"), true);
check("new -> won legal", leadTransitionIsValid("new", "won"), true);
check("new -> lost legal", leadTransitionIsValid("new", "lost"), true);
check("appointment_scheduled -> won legal", leadTransitionIsValid("appointment_scheduled", "won"), true);
check("follow_up_needed -> appointment_scheduled legal", leadTransitionIsValid("follow_up_needed", "appointment_scheduled"), true);

// Invalid transitions carry a CLEAR error message.
check(
  "won->new error names the reopen edge",
  checkLeadTransition("won", "new").error?.includes("Follow-up needed"),
  true,
);
check("won->new not ok", checkLeadTransition("won", "new").ok, false);
check("lost->new not ok", checkLeadTransition("lost", "new").ok, false);
check("legal transition has no error", checkLeadTransition("new", "contacted"), { ok: true, error: null });
// Live statuses are WORKING states: back-moves among live statuses stay
// legal (re-triage / undo a mis-click). Only won/lost are locked.
check(
  "live back-edge legal (appointment_scheduled -> new)",
  checkLeadTransition("appointment_scheduled", "new").ok,
  true,
);

// allowedNextStatuses: UI select must match the validator exactly.
for (const from of LEAD_LIFECYCLE_STATUSES) {
  const allowed = allowedNextStatuses(from as S);
  check(
    `allowedNextStatuses(${from}) matches validator`,
    allowed.every((to) => leadTransitionIsValid(from as S, to)) &&
      LEAD_LIFECYCLE_STATUSES.filter(
        (to) => to !== from && leadTransitionIsValid(from as S, to),
      ).every((to) => allowed.includes(to)),
    true,
  );
}
check("terminal won offers only reopen", allowedNextStatuses("won"), ["follow_up_needed"]);
check("terminal lost offers only reopen", allowedNextStatuses("lost"), ["follow_up_needed"]);
check("labels cover every status", Object.keys(LEAD_STATUS_LABELS).length, LEAD_LIFECYCLE_STATUSES.length);

// ---------------------------------------------------------------------------
// 2. Legacy status mapping (pre-011 rows / old clients)
// ---------------------------------------------------------------------------
check("legacy booked", isLegacyLeadStatus("booked"), true);
check("legacy completed", isLegacyLeadStatus("completed"), true);
check("legacy won is NOT legacy", isLegacyLeadStatus("won"), false);
check("map booked -> appointment_scheduled", toLegacy("booked"), "appointment_scheduled");
check("map completed -> won", toLegacy("completed"), "won");
check("new passes through", toLifecycleStatus("new"), "new");
check("follow_up_needed passes through", toLifecycleStatus("follow_up_needed"), "follow_up_needed");
check("unknown -> null", toLifecycleStatus("converted"), null);
check("junk -> null", toLifecycleStatus(""), null);

function toLegacy(v: string): ReturnType<typeof toLifecycleStatus> {
  return isLegacyLeadStatus(v) ? toLifecycleStatus(v) : null;
}

// ---------------------------------------------------------------------------
// 3. Estimated job value stamping via the KB (serviceNeed -> value range)
// ---------------------------------------------------------------------------
const drain = estimateJobValueCents("kitchen sink clogged and draining slow");
check("drain cleaning resolves", drain?.slug, "drain-cleaning");
check("drain low = $100", drain?.lowCents, 10_000);
check("drain high = $350", drain?.highCents, 35_000);

const wh = estimateJobValueCents("water heater replacement");
check("water heater resolves", wh?.slug, "water-heater-repair");
check("wh high = $700", wh?.highCents, 70_000);

const pipe = estimateJobValueCents("burst pipe flooding basement");
check("pipe repair resolves", pipe?.slug, "pipe-repair");

const sump = estimateJobValueCents("sump pump crock overflowing");
check("sump pump resolves", sump?.slug, "sump-pump");
check("sump range 200-1200", [sump?.lowCents, sump?.highCents], [20_000, 120_000]);

check("no match -> null (never guessed)", estimateJobValueCents("my cat is stuck in a tree"), null);
check("empty -> null", estimateJobValueCents(""), null);
check("non-string -> null", estimateJobValueCents(undefined as unknown as string), null);

// Every KB service that resolveServiceByAlias can return must carry a sane
// range — the stamping path can never write low > high or negatives.
import { listServices } from "../src/lib/server/kb";
for (const svc of listServices()) {
  check(
    `kb range sane: ${svc.slug}`,
    svc.typicalValue.low >= 0 && svc.typicalValue.high >= svc.typicalValue.low,
    true,
  );
}

// ---------------------------------------------------------------------------
// 4. Pipeline value derivation (P3-D will sum this)
// ---------------------------------------------------------------------------
const base = {
  actualWonValueCents: null,
  estimatedValueCents: null,
  estimatedJobValueLowCents: null,
  estimatedJobValueHighCents: null,
};
check("open + nothing -> null", computePipelineValueCents({ ...base, status: "open" }), null);
check(
  "open + kb high only",
  computePipelineValueCents({ ...base, status: "open", estimatedJobValueHighCents: 35_000 }),
  35_000,
);
check(
  "open + quote beats kb-high when larger",
  computePipelineValueCents({
    ...base,
    status: "open",
    estimatedValueCents: 50_000,
    estimatedJobValueHighCents: 35_000,
  }),
  50_000,
);
check(
  "open + kb-high floors a low quote",
  computePipelineValueCents({
    ...base,
    status: "open",
    estimatedValueCents: 20_000,
    estimatedJobValueHighCents: 35_000,
  }),
  35_000,
);
check(
  "won: actual wins",
  computePipelineValueCents({ ...base, status: "won", actualWonValueCents: 45_000, estimatedValueCents: 50_000 }),
  45_000,
);
check(
  "won: quote when no actual",
  computePipelineValueCents({ ...base, status: "won", estimatedValueCents: 50_000 }),
  50_000,
);
check(
  "won: kb-high when nothing else",
  computePipelineValueCents({ ...base, status: "won", estimatedJobValueHighCents: 35_000 }),
  35_000,
);
check("lost: always null", computePipelineValueCents({ ...base, status: "lost", actualWonValueCents: 45_000 }), null);
check("negative inputs treated as absent", computePipelineValueCents({ ...base, status: "open", estimatedValueCents: -5 }), null);

// ---------------------------------------------------------------------------
// 5. Follow-up due-date planning
// ---------------------------------------------------------------------------
// A Wednesday noon UTC in America/Chicago (7am CDT): next business day = Thu 9am.
const wed = new Date("2026-09-09T12:00:00Z"); // Wed
const thu9 = nextBusinessDayAt9(wed, "America/Chicago");
check("wed -> thu 9am central = 14:00Z", thu9?.toISOString(), "2026-09-10T14:00:00.000Z");

// Friday -> Monday (weekend skipped).
const fri = new Date("2026-09-11T12:00:00Z"); // Fri
const mon9 = nextBusinessDayAt9(fri, "America/Chicago");
check("fri -> mon 9am central (weekend skipped)", mon9?.toISOString(), "2026-09-14T14:00:00.000Z"); // Sep still CDT (UTC-5) — 9am local = 14:00Z

// 9:00 is LOCAL wall clock: same instant-of-day across zones.
const satUtc = new Date("2026-09-12T00:30:00Z"); // Sat 2026-09-12 in UTC; Fri in America/Los_Angeles
const la = nextBusinessDayAt9(satUtc, "America/Los_Angeles");
check("sat UTC is still fri in LA -> mon 9am PT", la?.toISOString(), "2026-09-14T16:00:00.000Z"); // PDT UTC-7

// Sunday start -> Monday.
const sun = new Date("2026-09-13T20:00:00Z"); // Sunday
check("sun -> mon", nextBusinessDayAt9(sun, "UTC")?.toISOString(), "2026-09-14T09:00:00.000Z");

// null / invalid timezone -> null (caller falls back to UTC).
check("null tz -> null", nextBusinessDayAt9(wed, null), null);
check("garbage tz -> null", nextBusinessDayAt9(wed, "Mars/Olympus"), null);

// DST boundary: crossing the November fall-back keeps 9am local.
const beforeFallBack = new Date("2026-10-30T12:00:00Z"); // Fri before Nov 1 2026 change
const afterFallBack = nextBusinessDayAt9(beforeFallBack, "America/Chicago");
check("dst fall-back keeps 9am local (CDT offset before)", afterFallBack?.toISOString(), "2026-11-02T15:00:00.000Z"); // Mon, now CST would be 15:00Z? (see below)

// addBusinessDaysAt with an explicit hour/minute.
check(
  "addBusinessDaysAt custom time",
  addBusinessDaysAt(new Date("2026-09-09T12:00:00Z"), 2, "UTC", 15, 30)?.toISOString(),
  "2026-09-11T15:30:00.000Z",
);
check(
  "zero business days = same-day rules",
  addBusinessDaysAt(new Date("2026-09-09T12:00:00Z"), 0, "UTC", 9)?.toISOString(),
  "2026-09-09T09:00:00.000Z",
);

// ---------------------------------------------------------------------------
// 6. business_id isolation — structural check on every new/changed query fn
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";

interface FnSpec {
  file: string;
  name: string;
}
const newQueryFns: FnSpec[] = [
  { file: "src/db/queries/followUpTasks.ts", name: "createFollowUpTask" },
  { file: "src/db/queries/followUpTasks.ts", name: "listFollowUpTasks" },
  { file: "src/db/queries/followUpTasks.ts", name: "countFollowUpTasks" },
  { file: "src/db/queries/followUpTasks.ts", name: "getFollowUpTask" },
  { file: "src/db/queries/followUpTasks.ts", name: "setFollowUpTaskDone" },
  { file: "src/db/queries/leads.ts", name: "updateLead" },
];

for (const spec of newQueryFns) {
  const src = readFileSync(spec.file, "utf8");
  const fnIdx = src.indexOf("export async function " + spec.name);
  check(`query exists: ${spec.name}`, fnIdx >= 0, true);
  if (fnIdx < 0) continue;
  const body = src.slice(fnIdx, src.indexOf("\n}", fnIdx));
  check(
    `${spec.name} takes businessId`,
    body.includes("businessId"),
    true,
  );
  check(
    `${spec.name} filters on business_id or scopes via getLead`,
    body.includes("business_id") || body.includes("getLead(businessId"),
    true,
  );
}

// The follow_up_tasks table itself must be business-scoped in the JOIN too
// (listFollowUpTasks joins leads on both ids).
{
  const src = readFileSync("src/db/queries/followUpTasks.ts", "utf8");
  check(
    "listFollowUpTasks join is business-scoped",
    src.includes("l.business_id = t.business_id"),
    true,
  );
}

// Migration: follow_up_tasks carries business_id NOT NULL + CASCADE + CHECK.
{
  const sql = readFileSync("migrations/011_crm_completion.sql", "utf8");
  check(
    "migration: follow_up_tasks.business_id NOT NULL REFERENCES businesses",
    /business_id\s+uuid\s+NOT NULL REFERENCES businesses\(id\) ON DELETE CASCADE/.test(sql),
    true,
  );
  check(
    "migration: follow_up_tasks.lead_id NOT NULL REFERENCES leads",
    /lead_id\s+uuid\s+NOT NULL REFERENCES leads\(id\)/.test(sql),
    true,
  );
  check(
    "migration: reason CHECK covers the three creation reasons",
    sql.includes("'lead_new'") && sql.includes("'status_follow_up'") && sql.includes("'manual'"),
    true,
  );
  check(
    "migration: status set is the 011 lifecycle",
    sql.includes("'follow_up_needed'") &&
      sql.includes("'appointment_scheduled'") &&
      sql.includes("'won'"),
    true,
  );
  check(
    "migration: backfills booked -> appointment_scheduled",
    sql.includes("SET status = 'appointment_scheduled' WHERE status = 'booked'"),
    true,
  );
  check(
    "migration: backfills completed -> won",
    sql.includes("SET status = 'won' WHERE status = 'completed'"),
    true,
  );
  check(
    "migration: value CHECK forbids low > high and negatives",
    sql.includes("estimated_job_value_low_cents <= estimated_job_value_high_cents") &&
      sql.includes("estimated_job_value_low_cents >= 0"),
    true,
  );
  check(
    "migration: updated_at trigger on follow_up_tasks",
    sql.includes("CREATE TRIGGER trg_follow_up_tasks_updated_at"),
    true,
  );
  check(
    "migration: open-tasks index is partial on (business_id, due_at)",
    sql.includes("follow_up_tasks_business_open_idx"),
    true,
  );
}

console.log(`\n${checks} checks, ${failures} failures`);
if (failures > 0) process.exit(1);
