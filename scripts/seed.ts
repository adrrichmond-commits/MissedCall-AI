#!/usr/bin/env bun
/**
 * Demo seed — `bun run db:seed`.
 *
 * Idempotent: re-running removes the previous demo business (CASCADE removes
 * all of its users/leads/conversations/appointments/services) and re-creates
 * it fresh. Only the demo business ("Rapid Rooter Plumbing") is touched;
 * any other rows in the database are left alone.
 *
 * Creates:
 *   - 1 demo plumbing business + business hours + service areas
 *   - 3 users (owner / manager / employee) sharing the demo password
 *     `demo-password-1234` (hashed via src/lib/server/password.ts using
 *     runtime-agnostic node:crypto scrypt, so logins work under Node and Bun)
 *   - the global service_defaults catalog + the business's services
 *     (8 instantiated from defaults, 3 custom)
 *   - 25 leads across the Phase 2 lifecycle (new/contacted/booked/completed/lost)
 *     with priority (emergency/high/normal) and realistic plumbing jobs
 *   - 14 SMS conversations with message threads matching each lead
 *   - 10 appointments under the Phase 2 REQUESTED/CONFIRMED lifecycle
 *     (migration 006): 7 past (5 completed, 2 declined) and 3 upcoming
 *     split 2 confirmed / 1 requested so the dashboard metric reads
 *     "2 confirmed - 1 requested" and the Appointments page has both
 *     actions to exercise
 *
 * Requires DATABASE_URL; for a local Postgres also set USE_LOCAL_POSTGRES=1
 * (see scripts/db.ts).
 */
import { query } from "./db";
import { hashPassword } from "../src/lib/server/password";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Offset from now: d(-3, 14) = 3 days ago at 14:00 local-machine time. */
function at(dayOffset: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function minutesFrom(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}
void minutesFrom;

interface Inserted {
  id: string;
}

// ---------------------------------------------------------------------------
// Demo fixtures
// ---------------------------------------------------------------------------

const BUSINESS = {
  name: "Rapid Rooter Plumbing",
  phone: "(512) 555-0134",
  email: "office@rapidrooter.example.com",
  website: "https://rapidrooter.example.com",
  addressLine1: "4110 Commercial Center Dr",
  city: "Austin",
  state: "TX",
  postalCode: "78744",
  timezone: "America/Chicago",
  plan: "trial" as const,
  // Phase 2 trial enforcement: the demo must always sit on an ACTIVE trial so
  // the expired-trial read-only gate never shows in the demo account.
  trialEndsInDays: 14,
};

const USERS = [
  { email: "dana@rapidrooter.example.com", fullName: "Dana Whitfield", role: "owner" as const },
  { email: "marcus@rapidrooter.example.com", fullName: "Marcus Lee", role: "manager" as const },
  { email: "jesse@rapidrooter.example.com", fullName: "Jesse Ortiz", role: "employee" as const },
];

const SERVICE_DEFAULTS = [
  { name: "Drain Cleaning", description: "Clear clogged sinks, tubs, and main lines.", basePriceCents: 18900, durationMinutes: 60 },
  { name: "Water Heater Repair", description: "Diagnose and repair tank and tankless water heaters.", basePriceCents: 16500, durationMinutes: 90 },
  { name: "Water Heater Replacement", description: "Remove and replace tank water heaters, 40–80 gal.", basePriceCents: 185000, durationMinutes: 240 },
  { name: "Leak Detection & Repair", description: "Locate hidden leaks and repair supply or drain lines.", basePriceCents: 22900, durationMinutes: 120 },
  { name: "Sewer Line Repair", description: "Camera inspection, spot repair, and full line replacement.", basePriceCents: 320000, durationMinutes: 300 },
  { name: "Sump Pump Installation", description: "Install or replace sump pumps and backup systems.", basePriceCents: 115000, durationMinutes: 180 },
  { name: "Fixture Repair & Replacement", description: "Faucets, toilets, garbage disposals, and shutoff valves.", basePriceCents: 14500, durationMinutes: 75 },
  { name: "Gas Line Services", description: "Run and repair gas lines for appliances and heaters.", basePriceCents: 38500, durationMinutes: 150 },
];

const CUSTOM_SERVICES = [
  { name: "Tankless Water Heater Flush", description: "Annual descale and flush for tankless units.", basePriceCents: 24900, durationMinutes: 90 },
  { name: "Hydro Jetting", description: "High-pressure jetting for grease and root-choked lines.", basePriceCents: 47500, durationMinutes: 120 },
  { name: "Backflow Prevention Testing", description: "Annual certified backflow device testing (city filing included).", basePriceCents: 13500, durationMinutes: 45 },
];

const SERVICE_AREAS = [
  { kind: "zip" as const, value: "78701", state: "TX" },
  { kind: "zip" as const, value: "78702", state: "TX" },
  { kind: "zip" as const, value: "78704", state: "TX" },
  { kind: "zip" as const, value: "78745", state: "TX" },
  { kind: "zip" as const, value: "78748", state: "TX" },
  { kind: "city" as const, value: "Austin", state: "TX" },
  { kind: "city" as const, value: "Round Rock", state: "TX" },
  { kind: "city" as const, value: "Cedar Park", state: "TX" },
  { kind: "city" as const, value: "Pflugerville", state: "TX" },
];

// 0 = Sunday … 6 = Saturday.
const BUSINESS_HOURS = [
  { dayOfWeek: 0, isOpen: false, opensAt: null, closesAt: null },
  { dayOfWeek: 1, isOpen: true, opensAt: "07:00:00", closesAt: "18:00:00" },
  { dayOfWeek: 2, isOpen: true, opensAt: "07:00:00", closesAt: "18:00:00" },
  { dayOfWeek: 3, isOpen: true, opensAt: "07:00:00", closesAt: "18:00:00" },
  { dayOfWeek: 4, isOpen: true, opensAt: "07:00:00", closesAt: "18:00:00" },
  { dayOfWeek: 5, isOpen: true, opensAt: "07:00:00", closesAt: "18:00:00" },
  { dayOfWeek: 6, isOpen: true, opensAt: "08:00:00", closesAt: "13:00:00" },
];

interface LeadFixture {
  source: "missed_call" | "web_form" | "referral" | "repeat_customer";
  status: "new" | "contacted" | "booked" | "completed" | "lost";
  /** Phase 2 triage ranking: emergency = drop everything, high = today, normal = scheduled. */
  priority: "emergency" | "high" | "normal";
  serviceNeed: string;
  urgency: "emergency" | "same_day" | "within_week" | "flexible";
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  contactAddress: string | null;
  description: string | null;
  estimatedValueCents: number | null;
  notes: string | null;
  createdOffsetDays: number;
  /** Days after creation when it converted (converted leads only). */
  convertedAfterDays?: number;
}

const LEADS: LeadFixture[] = [
  // ---- new (6) — fresh missed calls from the last few days -----------------
  {
    source: "missed_call", status: "new", serviceNeed: "Water Heater Replacement", urgency: "same_day",
    priority: "high",
    contactName: "Karen Dell'Aquila", contactPhone: "(512) 555-0114", contactEmail: null,
    contactAddress: "1908 Baylor St, Austin, TX 78703",
    description: "40-gal gas water heater is leaking from the tank; caller says water is spreading across the garage floor.",
    estimatedValueCents: 185000, notes: null, createdOffsetDays: 0,
  },
  {
    source: "missed_call", status: "new", serviceNeed: "Drain Cleaning", urgency: "same_day",
    priority: "high",
    contactName: "Robert Nguyen", contactPhone: "(512) 555-0155", contactEmail: "k.dell@example.com",
    contactAddress: "1204 E 12th St, Austin, TX 78702",
    description: "Kitchen sink completely backed up; running dishwasher makes it overflow.",
    estimatedValueCents: 18900, notes: null, createdOffsetDays: 0,
  },
  {
    source: "missed_call", status: "new", serviceNeed: "Burst Pipe Repair", urgency: "emergency",
    priority: "emergency",
    contactName: "Sam Okafor", contactPhone: "(512) 555-0162", contactEmail: null,
    contactAddress: "504 Chicon St, Austin, TX 78702",
    description: "Supply line burst under the bathroom sink overnight; water shut off at the main, needs repair today.",
    estimatedValueCents: 45000, notes: "Caller very stressed — water off since 6am.", createdOffsetDays: 1,
  },
  {
    source: "web_form", status: "new", serviceNeed: "Sump Pump Installation",
    urgency: "within_week",
    priority: "normal",
    contactName: "Priya Raman", contactPhone: "(512) 555-0178", contactEmail: "praman@example.com",
    contactAddress: "1205 Cullen Ave, Austin, TX 78757",
    description: "Finished basement floods during heavy rain; wants a sump pump with battery backup quoted.",
    estimatedValueCents: 160000, notes: "Submitted from website contact form.", createdOffsetDays: 1,
  },
  {
    source: "missed_call", status: "new", serviceNeed: "Toilet Repair", urgency: "flexible",
    priority: "normal",
    contactName: "Walter Simmons", contactPhone: "(512) 555-0183", contactEmail: null,
    contactAddress: "3010 Harris Park Ave, Austin, TX 78705",
    description: "Toilet runs constantly and the flapper looks warped; handy owner, wants a quote on parts + labor.",
    estimatedValueCents: 14500, notes: null, createdOffsetDays: 2,
  },
  {
    source: "missed_call", status: "new", serviceNeed: "Garbage Disposal Replacement",
    urgency: "flexible",
    priority: "normal",
    contactName: "Bethany Cruz", contactPhone: "(512) 555-0197", contactEmail: "bcruz@example.com",
    contactAddress: "9412 Little Texas Dr, Austin, TX 78748",
    description: "Disposal hums but won't spin; unit is about 9 years old and she'd rather replace than repair.",
    estimatedValueCents: 42000, notes: null, createdOffsetDays: 3,
  },

  // ---- contacted (11) — 6 in conversation, 5 quoted, awaiting decision -----
  {
    source: "missed_call", status: "contacted", serviceNeed: "Low Water Pressure Diagnosis",
    urgency: "same_day",
    priority: "high",
    contactName: "Derek Malone", contactPhone: "(512) 555-0141", contactEmail: null,
    contactAddress: "1604 Woodland Ave, Austin, TX 78741",
    description: "Whole-house pressure dropped over two days; suspects a partially closed valve or a failing PRV.",
    estimatedValueCents: 22900, notes: null, createdOffsetDays: 2,
  },
  {
    source: "missed_call", status: "contacted", serviceNeed: "Water Heater Repair", urgency: "same_day",
    priority: "high",
    contactName: "Angela Fontaine", contactPhone: "(512) 555-0136", contactEmail: "afontaine@example.com",
    contactAddress: "2307 Kinney Ave, Austin, TX 78704",
    description: "Pilot light won't stay lit on an 8-year-old 50-gal heater; water is lukewarm by evening.",
    estimatedValueCents: 16500, notes: null, createdOffsetDays: 3,
  },
  {
    source: "referral", status: "contacted", serviceNeed: "Repipe / Slab Leak Repair",
    urgency: "within_week",
    priority: "normal",
    contactName: "Hector Barrientos", contactPhone: "(512) 555-0129", contactEmail: null,
    contactAddress: "8104 Mesa Dr, Austin, TX 78759",
    description: "Warm spot on the kitchen floor and a spike in the water bill; referred by the Hendersons on the same street.",
    estimatedValueCents: 280000, notes: "Referral — predecessor customer raved about us.", createdOffsetDays: 5,
  },
  {
    source: "web_form", status: "contacted", serviceNeed: "Shower Valve Replacement",
    urgency: "within_week",
    priority: "normal",
    contactName: "Molly Tran", contactPhone: "(512) 555-0117", contactEmail: "molly.tran@example.com",
    contactAddress: "2001 S I-35 Frontage Rd, Austin, TX 78704",
    description: "Shower drips even with the handle off; single-handle Moen valve likely needs a cartridge swap.",
    estimatedValueCents: 28500, notes: null, createdOffsetDays: 6,
  },
  {
    source: "missed_call", status: "contacted", serviceNeed: "Outdoor Faucet Repair", urgency: "flexible",
    priority: "normal",
    contactName: "Calvin Bedrossian", contactPhone: "(512) 555-0109", contactEmail: null,
    contactAddress: "4908 Duval St, Austin, TX 78751",
    description: "Hose bib drips year-round and sprays at the threads; wants a freeze-proof sillcock installed.",
    estimatedValueCents: 19500, notes: null, createdOffsetDays: 8,
  },
  {
    source: "repeat_customer", status: "contacted", serviceNeed: "Sewer Line Camera Inspection",
    urgency: "within_week",
    priority: "normal",
    contactName: "The Hendersons (Jim & Ruth)", contactPhone: "(512) 555-0123", contactEmail: "jhenderson@example.com",
    contactAddress: "8122 Mesa Dr, Austin, TX 78759",
    description: "Two toilets gurgle when the washer drains; repeat customers (drain cleaning last spring) want a camera run before it becomes an excavation.",
    estimatedValueCents: 34900, notes: "Repeat customer — 3rd job in 2 years. Bill to the old account rate.", createdOffsetDays: 9,
  },

  // ---- quoted (5) -> contacted — quotes out, awaiting decision --------------
  {
    source: "missed_call", status: "contacted", serviceNeed: "Water Heater Replacement", urgency: "within_week",
    priority: "normal",
    contactName: "Gloria Nkemdirim", contactPhone: "(512) 555-0146", contactEmail: "g.nkemdirim@example.com",
    contactAddress: "1305 Garden Villa Ln, Austin, TX 78745",
    description: "Electric 50-gal heater is 12 years old and rusting at the seams; wants a quote for like-for-like plus expansion tank.",
    estimatedValueCents: 195000, notes: "Quote sent 9/2 — deciding between standard and power-vent.", createdOffsetDays: 4,
  },
  {
    source: "referral", status: "contacted", serviceNeed: "Gas Line for Grill", urgency: "flexible",
    priority: "normal",
    contactName: "Tanner Whitmore", contactPhone: "(512) 555-0102", contactEmail: null,
    contactAddress: "3404 Golden Arrow Dr, Austin, TX 78745",
    description: "Wants a natural gas line stubbed to the back patio for a built-in grill; needs permit guidance.",
    estimatedValueCents: 95000, notes: "Referred by Gloria Nkemdirim.", createdOffsetDays: 7,
  },
  {
    source: "web_form", status: "contacted", serviceNeed: "Bathroom Remodel Rough-In", urgency: "flexible",
    priority: "normal",
    contactName: "Alicia Grant", contactPhone: "(512) 555-0189", contactEmail: "agrant@example.com",
    contactAddress: "704 West Ave, Austin, TX 78701",
    description: "Converting a tub to a walk-in shower; needs drain relocation and pressure-balance valve quoted for the GC.",
    estimatedValueCents: 320000, notes: "GC is Hartline Renovations — coordinate with their site supervisor.", createdOffsetDays: 10,
  },
  {
    source: "missed_call", status: "contacted", serviceNeed: "Tankless Water Heater Install", urgency: "within_week",
    priority: "normal",
    contactName: "Devon Achterberg", contactPhone: "(512) 555-0171", contactEmail: "devon.a@example.com",
    contactAddress: "4606 Deep Hollow Rd, Austin, TX 78749",
    description: "Tank unit died; wants a tankless conversion quote including gas line upsizing and new venting.",
    estimatedValueCents: 420000, notes: "Wrote up the Navien NPE-240A2 option; awaiting decision.", createdOffsetDays: 12,
  },
  {
    source: "missed_call", status: "contacted", serviceNeed: "Hydro Jetting", urgency: "same_day",
    priority: "high",
    contactName: "Rosa Villarreal", contactPhone: "(512) 555-0158", contactEmail: null,
    contactAddress: "1802 Perchalk St, Austin, TX 78744",
    description: "Restaurant kitchen lines slow every 3 months; owner wants hydro jetting on a maintenance cadence instead of emergency clears.",
    estimatedValueCents: 47500, notes: "Potential quarterly maintenance contract — manager to follow up.", createdOffsetDays: 14,
  },

  // ---- ex-converted (5) -> booked (3) / completed (2 — completed appt) ------
  {
    source: "missed_call", status: "booked", serviceNeed: "Water Heater Replacement", urgency: "emergency",
    priority: "emergency",
    contactName: "Frank Delgado", contactPhone: "(512) 555-0111", contactEmail: "fdelgado@example.com",
    contactAddress: "2204 Burton Dr, Austin, TX 78704",
    description: "Rusted 40-gal heater flooded the utility closet; replaced with a 50-gal power-vent unit same week.",
    estimatedValueCents: 215000, notes: "Paid by check on completion.", createdOffsetDays: 21, convertedAfterDays: 1,
  },
  {
    source: "repeat_customer", status: "completed", serviceNeed: "Sump Pump Replacement", urgency: "same_day",
    priority: "high",
    contactName: "Nadia Petrov", contactPhone: "(512) 555-0168", contactEmail: "nadia.p@example.com",
    contactAddress: "7412 Rain Creek Pkwy, Austin, TX 78759",
    description: "Existing sump pump failed ahead of storm season; swapped in a 1/2 HP primary with battery backup.",
    estimatedValueCents: 148000, notes: null, createdOffsetDays: 18, convertedAfterDays: 0,
  },
  {
    source: "web_form", status: "completed", serviceNeed: "Main Water Line Replacement", urgency: "within_week",
    priority: "normal",
    contactName: "Owen Mbeki", contactPhone: "(512) 555-0139", contactEmail: "owen.mbeki@example.com",
    contactAddress: "3909 Shoal Creek Blvd, Austin, TX 78756",
    description: "Polybutylene main line cracked at the yard wall; replaced ~40 ft with PEX and new shutoff.",
    estimatedValueCents: 380000, notes: "Insurance covered part — invoiced remainder to owner.", createdOffsetDays: 26, convertedAfterDays: 3,
  },
  {
    source: "referral", status: "booked", serviceNeed: "Drain Cleaning", urgency: "same_day",
    priority: "high",
    contactName: "Jun Watanabe", contactPhone: "(512) 555-0193", contactEmail: null,
    contactAddress: "1605 E 6th St, Austin, TX 78702",
    description: "Main line clogged with roots; cleared with a cable machine and left root-treatment tabs.",
    estimatedValueCents: 27500, notes: null, createdOffsetDays: 15, convertedAfterDays: 0,
  },
  {
    source: "missed_call", status: "booked", serviceNeed: "Fixture Repair & Replacement", urgency: "flexible",
    priority: "normal",
    contactName: "Colleen O'Shea", contactPhone: "(512) 555-0126", contactEmail: "coshea@example.com",
    contactAddress: "2903 Miriam Ave, Austin, TX 78745",
    description: "Two dripping faucets and a running toilet handled in one visit; also swapped corroded angle stops.",
    estimatedValueCents: 38500, notes: null, createdOffsetDays: 30, convertedAfterDays: 2,
  },

  // ---- lost (3) -------------------------------------------------------------
  {
    source: "missed_call", status: "lost", serviceNeed: "Sewer Line Replacement", urgency: "emergency",
    priority: "emergency",
    contactName: "Bernard Kessler", contactPhone: "(512) 555-0104", contactEmail: null,
    contactAddress: "1109 Chalmers Ave, Austin, TX 78722",
    description: "Sewer collapse under the driveway; needed excavation on a deadline we couldn't schedule in time.",
    estimatedValueCents: 520000, notes: "Lost — caller needed same-day excavation; referred him to Austin Slab Co.", createdOffsetDays: 24,
  },
  {
    source: "web_form", status: "lost", serviceNeed: "Commercial Repipe Quote", urgency: "flexible",
    priority: "normal",
    contactName: "DeeAnn Kowalczyk", contactPhone: "(512) 555-0176", contactEmail: "dkowalczyk@example.com",
    contactAddress: "6406 Springdale Rd, Austin, TX 78723",
    description: "10-unit strip center repipe inquiry; outside our service scope for commercial jobs.",
    estimatedValueCents: null, notes: "Lost — commercial scope; referred to a commercial outfit.", createdOffsetDays: 28,
  },
  {
    source: "missed_call", status: "lost", serviceNeed: "Water Heater Repair", urgency: "same_day",
    priority: "high",
    contactName: "Peter Ainsworth", contactPhone: "(512) 555-0152", contactEmail: null,
    contactAddress: "1104 Nuevo Leon St, Austin, TX 78704",
    description: "Thermocouple replacement on an older heater; caller took a cheaper handyman quote.",
    estimatedValueCents: 16500, notes: "Lost to price — left door open for future service.", createdOffsetDays: 32,
  },
];

interface ConversationFixture {
  /** Index into LEADS. */
  lead: number;
  status: "active" | "awaiting_customer" | "booked" | "closed";
  summary: string | null;
  /** Minutes between messages. */
  gaps: [number, number, number, number, number, number];
}

const CONVERSATIONS: ConversationFixture[] = [
  // converted → booked threads
  { lead: 15, status: "booked", summary: "Tank leaking; booked 50-gal power-vent replacement for Friday.", gaps: [4, 9, 14, 26, 40, 60] },
  { lead: 16, status: "booked", summary: "Sump pump dead; same-day replacement with battery backup booked.", gaps: [3, 7, 12, 20, 30, 45] },
  { lead: 17, status: "booked", summary: "Yard-line crack; scheduled water line replacement estimate, then install.", gaps: [5, 11, 18, 30, 55, 75] },
  { lead: 18, status: "booked", summary: "Roots in main; cable clear + booked follow-up camera check.", gaps: [4, 8, 15, 25, 35, 50] },
  { lead: 19, status: "booked", summary: "Two faucets + toilet; bundled fixture visit booked for Saturday morning.", gaps: [6, 10, 16, 28, 42, 58] },
  // quoted → awaiting customer decision
  { lead: 10, status: "awaiting_customer", summary: "Quoted like-for-like vs power-vent heater; customer deciding.", gaps: [4, 9, 13, 22, 0, 0] },
  { lead: 13, status: "awaiting_customer", summary: "Tankless conversion quote (Navien 240A2) sent; awaiting go-ahead.", gaps: [5, 10, 16, 25, 0, 0] },
  { lead: 14, status: "active", summary: "Restaurant wants hydro jetting cadence; drafting quarterly plan.", gaps: [3, 8, 12, 18, 0, 0] },
  { lead: 12, status: "awaiting_customer", summary: "Walk-in shower rough-in quote sent to GC; awaiting site schedule.", gaps: [6, 12, 20, 0, 0, 0] },
  // contacted → active threads
  { lead: 6, status: "active", summary: "Suspected failing PRV; tech consult scheduled for pressure test.", gaps: [4, 9, 15, 0, 0, 0] },
  { lead: 7, status: "active", summary: "Pilot won't stay lit; likely thermocouple, quote pending photo of label.", gaps: [5, 10, 14, 0, 0, 0] },
  { lead: 8, status: "active", summary: "Warm floor slab leak suspicion; camera + pressure test proposed.", gaps: [7, 12, 19, 0, 0, 0] },
  { lead: 11, status: "active", summary: "Repeat customers; camera inspection booked request pending slot.", gaps: [4, 9, 13, 0, 0, 0] },
  // lost → closed
  { lead: 22, status: "closed", summary: "Cheaper handyman quote won; kept for future service.", gaps: [5, 11, 16, 22, 0, 0] },
];

interface AppointmentFixture {
  lead: number;
  /** Index into the business's service list (0-10 after seeding; resolved by name). */
  serviceName: string;
  technician: string;
  status: "requested" | "confirmed" | "declined" | "completed";
  dayOffset: number;
  hour: number;
  /** When set, scheduled_at = now + this many minutes (overrides dayOffset/hour). */
  startOffsetMinutes?: number;
  durationMinutes: number;
  notes: string | null;
}

const APPOINTMENTS: AppointmentFixture[] = [
  // past — completed
  { lead: 15, serviceName: "Water Heater Replacement", technician: "Mike Ruiz", status: "completed", dayOffset: -17, hour: 9, durationMinutes: 240, notes: "Old 40-gal rusted out; hauled away. Expansion tank added." },
  { lead: 18, serviceName: "Drain Cleaning", technician: "Tony Galdamez", status: "completed", dayOffset: -14, hour: 11, durationMinutes: 90, notes: "Roots cut from main at cleanout; camera verified flow." },
  { lead: 19, serviceName: "Fixture Repair & Replacement", technician: "Chris Pham", status: "completed", dayOffset: -27, hour: 13, durationMinutes: 75, notes: "Two faucets + toilet flapper; angle stops replaced." },
  { lead: 16, serviceName: "Sump Pump Installation", technician: "Dave Sorensen", status: "completed", dayOffset: -17, hour: 15, durationMinutes: 180, notes: "1/2 HP primary + battery backup installed and tested." },
  // past — cancelled / no-show
  { lead: 9, serviceName: "Shower Valve Replacement", technician: "Chris Pham", status: "declined", dayOffset: -3, hour: 10, durationMinutes: 75, notes: "Customer rescheduling until after her kitchen remodel." },
  { lead: 17, serviceName: "Leak Detection & Repair", technician: "Mike Ruiz", status: "declined", dayOffset: -6, hour: 14, durationMinutes: 120, notes: "Customer not home; left card, office to re-book." },
  // present / upcoming
  { lead: 14, serviceName: "Hydro Jetting", technician: "Tony Galdamez", status: "completed", dayOffset: 0, hour: 0, startOffsetMinutes: -90, durationMinutes: 120, notes: "Quarterly maintenance jetting — kitchen lines." },
  { lead: 6, serviceName: "Leak Detection & Repair", technician: "Mike Ruiz", status: "confirmed", dayOffset: 1, hour: 10, durationMinutes: 120, notes: "Pressure test + PRV inspection." },
  { lead: 10, serviceName: "Water Heater Replacement", technician: "Dave Sorensen", status: "confirmed", dayOffset: 3, hour: 9, durationMinutes: 240, notes: "Pending final heater choice — standard vs power-vent." },
  { lead: 13, serviceName: "Water Heater Repair", technician: "Tony Galdamez", status: "requested", dayOffset: 8, hour: 13, durationMinutes: 150, notes: "Tankless conversion if quote approved; else bypass." },
];

// ---------------------------------------------------------------------------
// Seed logic
// ---------------------------------------------------------------------------

async function count(table: string): Promise<number> {
  const rows = await query(`SELECT count(*)::int AS n FROM ${table}`);
  return Number((rows[0] as { n: number }).n);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is not set — point it at your Neon database (or a local Postgres with USE_LOCAL_POSTGRES=1).",
    );
    process.exit(1);
  }

  // --- idempotency: wipe any previous demo business (CASCADE) ---------------
  const existing = await query("SELECT id FROM businesses WHERE name = $1", [BUSINESS.name]);
  if (existing.length > 0) {
    await query("DELETE FROM businesses WHERE name = $1", [BUSINESS.name]);
    console.log("Removed previous demo business (seed is idempotent).");
  }
  await query("DELETE FROM service_defaults");

  // --- business --------------------------------------------------------------
  const [biz] = (await query(
    `INSERT INTO businesses (name, phone, email, website, address_line1, city, state, postal_code, timezone, plan, trial_ends_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + make_interval(days => $11::int)) RETURNING id`,
    [BUSINESS.name, BUSINESS.phone, BUSINESS.email, BUSINESS.website, BUSINESS.addressLine1,
      BUSINESS.city, BUSINESS.state, BUSINESS.postalCode, BUSINESS.timezone, BUSINESS.plan,
      BUSINESS.trialEndsInDays],
  )) as unknown as Inserted[];
  const businessId = biz.id;

  // --- users (scrypt$ hashes of the shared demo password, verifiable under
  //     any runtime) ----------------------------------------------------------
  const passwordHash = await hashPassword("demo-password-1234");
  for (const u of USERS) {
    await query(
      `INSERT INTO users (business_id, email, full_name, role, password_hash, email_verified, last_login_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [businessId, u.email, u.fullName, u.role, passwordHash, true,
        u.role === "owner" ? at(0, -24) : null],
    );
  }

  // --- service defaults (global catalog) + business services -----------------
  const defaultIds: { name: string; id: string }[] = [];
  let sortOrder = 0;
  for (const d of SERVICE_DEFAULTS) {
    const [row] = (await query(
      `INSERT INTO service_defaults (name, description, sort_order) VALUES ($1,$2,$3) RETURNING id`,
      [d.name, d.description, sortOrder++],
    )) as unknown as Inserted[];
    defaultIds.push({ name: d.name, id: row.id });
  }
  const defaultByName = new Map(defaultIds.map((d) => [d.name, d.id]));

  const serviceIdByName = new Map<string, string>();
  for (const [name, d] of Object.entries(SERVICE_DEFAULTS).map(([, d]) => [d.name, d] as const)) {
    const [row] = (await query(
      `INSERT INTO services (business_id, name, description, base_price_cents, duration_minutes, is_default, default_service_id, sort_order)
       VALUES ($1,$2,$3,$4,$5,true,$6,$7) RETURNING id`,
      [businessId, d.name, d.description, d.basePriceCents, d.durationMinutes, defaultByName.get(d.name), serviceIdByName.size],
    )) as unknown as Inserted[];
    serviceIdByName.set(name, row.id);
  }
  for (const [i, c] of CUSTOM_SERVICES.entries()) {
    const [row] = (await query(
      `INSERT INTO services (business_id, name, description, base_price_cents, duration_minutes, is_default, sort_order)
       VALUES ($1,$2,$3,$4,$5,false,$6) RETURNING id`,
      [businessId, c.name, c.description, c.basePriceCents, c.durationMinutes, SERVICE_DEFAULTS.length + i],
    )) as unknown as Inserted[];
    serviceIdByName.set(c.name, row.id);
  }

  // --- service areas + business hours ----------------------------------------
  for (const a of SERVICE_AREAS) {
    await query(
      `INSERT INTO service_areas (business_id, kind, value, state) VALUES ($1,$2,$3,$4)`,
      [businessId, a.kind, a.value, a.state],
    );
  }
  for (const h of BUSINESS_HOURS) {
    await query(
      `INSERT INTO business_hours (business_id, day_of_week, is_open, opens_at, closes_at) VALUES ($1,$2,$3,$4,$5)`,
      [businessId, h.dayOfWeek, h.isOpen, h.opensAt, h.closesAt],
    );
  }

  // --- leads -------------------------------------------------------------------
  const leadIds: string[] = [];
  for (const l of LEADS) {
    const createdAt = at(-l.createdOffsetDays, 8 + (l.contactName.length % 9), (l.contactName.length * 7) % 60);
    const convertedAt = l.convertedAfterDays !== undefined
      ? new Date(createdAt.getTime() + l.convertedAfterDays * 86_400_000)
      : null;
    const [row] = (await query(
      `INSERT INTO leads (business_id, source, status, priority, service_need, urgency, contact_name, contact_phone,
         contact_email, contact_address, description, estimated_value_cents, notes, converted_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [businessId, l.source, l.status, l.priority, l.serviceNeed, l.urgency, l.contactName, l.contactPhone,
        l.contactEmail, l.contactAddress, l.description, l.estimatedValueCents, l.notes, convertedAt, createdAt],
    )) as unknown as Inserted[];
    leadIds.push(row.id);
  }

  // --- conversations + messages ------------------------------------------------
  const OUT = "outbound" as const;
  const IN = "inbound" as const;

  for (const c of CONVERSATIONS) {
    const lead = LEADS[c.lead];
    const leadId = leadIds[c.lead];
    const startedAt = at(-lead.createdOffsetDays, 8 + (c.lead % 8), (c.lead * 13) % 60);

    const messages: { direction: "inbound" | "outbound"; body: string }[] = [
      {
        direction: OUT,
        body: `Hi ${lead.contactName.split(" ")[0]}, this is Rapid Rooter Plumbing — sorry we missed your call! I'm the office assistant. What can we help you with today?`,
      },
      { direction: IN, body: lead.description ?? `Calling about ${lead.serviceNeed.toLowerCase()}.` },
      {
        direction: OUT,
        body: `Got it — ${lead.serviceNeed.toLowerCase()}. What's the service address, and how soon do you need someone out?`,
      },
      {
        direction: IN,
        body: lead.urgency === "emergency" || lead.urgency === "same_day"
          ? `${lead.contactAddress ?? "Same address as the call"} — as soon as you can today.`
          : `${lead.contactAddress ?? "Same address as the call"} — sometime this week works.`,
      },
      {
        direction: OUT,
        body: c.status === "booked"
          ? `You're booked — a tech will arrive within the window and call 30 minutes out. Reply here if anything changes.`
          : c.status === "closed"
            ? `Understood — we'll keep you in the system. Reach out any time and we'll get you on the schedule.`
            : `Thanks! I've passed this to our dispatcher — we'll confirm your appointment window shortly.`,
      },
    ];

    const [conv] = (await query(
      `INSERT INTO conversations (business_id, lead_id, customer_phone, status, summary, created_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [businessId, leadId, lead.contactPhone, c.status, c.summary, startedAt],
    )) as unknown as Inserted[];

    let cursor = startedAt.getTime();
    for (let i = 0; i < messages.length; i++) {
      // A gap of 0 (or missing) means the thread ends after the previous message.
      const gap = c.gaps[i];
      if (!gap) break;
      cursor += gap * 60_000;
      await query(
        `INSERT INTO messages (business_id, conversation_id, direction, body, status, sent_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [businessId, conv.id, messages[i].direction, messages[i].body,
          messages[i].direction === OUT ? "delivered" : "delivered",
          new Date(cursor), new Date(cursor)],
      );
    }
  }

  // --- appointments --------------------------------------------------------------
  for (const appt of APPOINTMENTS) {
    const lead = LEADS[appt.lead];
    const scheduledAt =
      appt.startOffsetMinutes !== undefined
        ? new Date(Date.now() + appt.startOffsetMinutes * 60_000)
        : at(appt.dayOffset, appt.hour);
    await query(
      `INSERT INTO appointments (business_id, lead_id, service_id, service_summary, technician_name,
         scheduled_at, duration_minutes, status, address, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [businessId, leadIds[appt.lead], serviceIdByName.get(appt.serviceName) ?? null, appt.serviceName,
        appt.technician, scheduledAt, appt.durationMinutes, appt.status,
        lead.contactAddress, appt.notes],
    );
  }

  // --- report ---------------------------------------------------------------------
  const tables = [
    "businesses", "users", "leads", "conversations", "messages", "appointments",
    "services", "service_defaults", "service_areas", "business_hours",
  ];
  console.log("\nSeed complete. Row counts:");
  for (const t of tables) {
    console.log(`  ${t.padEnd(16)} ${await count(t)}`);
  }
}

main().catch((err) => {
  console.error("Seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
