/**
 * Emergency taxonomy for the shared plumbing knowledge base (P3-A).
 *
 * Code-resident data only. Every entry carries the immediate customer-safety
 * script the AI relays VERBATIM before anything else — pricing, booking, or
 * qualification NEVER precede the safety script for a matching emergency.
 *
 * Patterns match text normalized like the classifier does (lowercase,
 * apostrophes stripped, non-alnum collapsed to single spaces) and are
 * deliberately typo-tolerant via prefix stems (\bflood, \bsewag, \bgurgl) —
 * realistic customer texts include "floodig", "sewer backed up", "gurgling".
 */

import type { EmergencyKbEntry } from "./types";

export const EMERGENCIES: readonly EmergencyKbEntry[] = [
  {
    key: "gas_odor",
    name: "Gas odor / possible gas leak",
    severity: "critical",
    // Conjunctive signal (gas + leak/smell word) built as ONE self-sufficient
    // regex with both word orders + the rotten-egg tell. A bare "gas" or a
    // bare "leak" alone must NOT match.
    patterns: [
      /\bgas\b.{0,20}\b(smell|smells|smelling|smelled|smelt|smel|odor|odour|scent|fumes?|leak|leaking|leek|leeking)\b|\b(smell|smells|smelling|smelled|smelt|smel|odor|odour|scent|fumes?|leak|leaking|leek|leeking)\b.{0,20}\bgas\b|\brotten egg\b/,
    ],
    afterHoursEscalation: true,
    customerScript: [
      "If you smell gas, leave the building right away — take everyone and pets with you.",
      "Do not flip switches, light anything, or use your phone inside.",
      "From outside, call 911 and your gas utility's emergency line.",
      "Once the utility says it is safe, message us back and we will get a plumber to you.",
    ],
    safetyNotes: [
      "Never diagnose, price, or schedule before the safety script is delivered.",
      "Never advise locating or operating any gas valve — licensed-only work.",
    ],
  },
  {
    key: "active_flooding",
    name: "Active flooding / uncontrolled water",
    severity: "critical",
    // One self-sufficient regex per independent signal (any hit = match).
    patterns: [
      /\bflood/,
      /\bwater (everywhere|all over|every ware)\b|\bwater all over\b/,
      /\b(ankle|knee|foot|waist)[ -]?deep\b/,
      /\b(basement|house|kitchen|bathroom) (is )?(full of water|filling (with|up)|taking on water)\b/,
      /\bwater (pouring|gushing|spewing|spraying|shooting|pourng|gusehd)\b/,
      /\bwont stop (leaking|leakin|pouring|gushing|spraying)\b/,
      /\b(cant|cannot|wont) (get|find|shut|turn) (it|the water|water)? ?(off|shut)\b/,
    ],
    afterHoursEscalation: true,
    customerScript: [
      "First, shut off the main water valve to stop the water.",
      "It is usually where the line enters the house — garage, basement, or outside wall — or near the water meter.",
      "If you cannot close it or cannot find it, tell me and I will walk you through the next step.",
      "Move valuables out of the water and keep everyone away from wet electrical areas.",
      "Stay on the line — I am getting a plumber out to you as fast as possible.",
    ],
    safetyNotes: [
      "Water near electricity: never advise touching panels or appliances in standing water.",
      "Escalate to the owner immediately, day or night, when after-hours.",
    ],
  },
  {
    key: "sewage_backup",
    name: "Sewage backup",
    severity: "critical",
    patterns: [
      /\bsewag/,
      /\bsewer [a-z ]{0,20}(backed? ?up|backing ?up|backup|overflow)/,
      /\bsept(ic|ick|ik)\b/,
      /\b(waste ?water|raw sewage|black ?water)\b/,
      /\b(bathroom|basement) (smells? like )?(sewer|sewage|feces)/,
      /\bgurgl/,
    ],
    afterHoursEscalation: true,
    customerScript: [
      "Keep everyone and pets away from the affected drains and any standing water.",
      "Do not run any water, the dishwasher, or laundry — nothing down the drains.",
      "Do not enter standing sewage water — it is a serious health hazard.",
      "We will get a technician out as soon as possible; avoid the area until then.",
    ],
    safetyNotes: [
      "Sewage exposure is a health hazard — keep cleanup advice at keep-away level, never how-to.",
      "Multiple fixtures backing up simultaneously means the main line — no fixture-level DIY coaching.",
    ],
  },
  {
    key: "burst_pipe",
    name: "Burst / ruptured pipe",
    severity: "critical",
    patterns: [
      /\b(burst|busted|bustid|ruptured|exploded|blew|blewn) (pipe|pipes|piping|line|lines|water (line|main))/,
      /\bpipe (burst|busted|ruptured|exploded|blew|blewn|expolded)\b/,
      /\bpipes? (burst|busted|ruptured)/,
      /\bcracked (open|pipe|supply line)\b/,
    ],
    afterHoursEscalation: true,
    customerScript: [
      "Shut off the main water valve right now — it stops the flooding at the source.",
      "It is usually where the line enters the house — garage, basement, or outside wall — or near the water meter.",
      "Open a low faucet (a bathtub tap) after the main is closed to drain pressure left in the pipes.",
      "Keep everyone away from wet electrical areas, then stay on the line — I am getting a plumber to you.",
    ],
    safetyNotes: [
      "Never advise cutting into walls or ceilings to reach the pipe.",
      "If water is near electrical, treat as electrical hazard and keep clear.",
    ],
  },
  {
    key: "whole_house_no_water",
    name: "Whole-house no water",
    severity: "severe",
    patterns: [
      /\bno water\b(?! pressure)/,
      /\b(dont|do ?not|havent) (have|got) (any )?water\b/,
      /\bout of water\b/,
      /\bwater (stopped|shut) (coming|off|working)\b/,
      /\bwater (shut|turned) off (by|from|at) the (street|meter|utility)\b/,
    ],
    afterHoursEscalation: true,
    customerScript: [
      "Check whether the main valve was accidentally closed — a quarter-turn ball valve is open when its handle lines up with the pipe.",
      "Ask a neighbor or check with your water utility — a street-side shut-off or a main break affects the whole street.",
      "If neighbors have water and the main valve is open, we treat it as a possible private-line failure and come out.",
    ],
    safetyNotes: [
      "No water plus a spinning meter or a wet yard points to a hidden break — flag for leak detection.",
    ],
  },
  {
    key: "water_heater_leaking",
    name: "Water heater leaking",
    severity: "severe",
    // Heater word + leak verb, both orders — adjacency window keeps "replace
    // my water heater" (no leak language) from matching.
    patterns: [
      /\bwater (heater|heatter|heate|heate?r?s?)\b.{0,30}\b(leak|leaking|leeking|leek|gush|pour|spray|spew|flood)/,
      /\b(leak|leaking|leeking|leek|gush|pour|spray|spew|flood)\b.{0,30}\bwater (heater|heatter|heaters?)\b/,
      /\bheater (is |was )?(leaking|pouring|spraying|gushing)\b/,
      /\btank (is )?(leaking|pouring|spraying|gushing)/,
    ],
    afterHoursEscalation: true,
    customerScript: [
      "Shut off the cold-water valve on top of the heater — turn it clockwise.",
      "If it is electric and the panel is dry and safely reachable, switch off its breaker.",
      "If it is gas, do not touch the gas valve — leave that for the technician.",
      "Contain or drain the leaking water and keep it away from the furnace and electrical.",
    ],
    safetyNotes: [
      "A rapidly leaking heater is the flooding path — main shut-off first if the top valve is unreachable.",
      "Never include gas-valve DIY guidance for gas units.",
    ],
  },
];
