/**
 * Service catalog for the shared plumbing knowledge base (P3-A).
 *
 * Code-resident data only — never reads the DB. The DB `service_defaults`
 * table (migrations/001_init.sql) remains the customer-facing catalog;
 * P3-C can reconcile per-business pricing against these default ranges.
 *
 * Conventions for every entry:
 *  - aliases are non-global RegExp (stateless .test) over text normalized the
 *    same way the classifier does (lowercase, apostrophes stripped, non-alnum
 *    collapsed to single spaces).
 *  - typicalValue is a TYPICAL range for a small residential job, honest and
 *    deliberately wide — it seeds P3-C estimated job value, never a quote.
 *  - qualifyingQuestions are asked before any price/booking commitment.
 */

import type { ServiceKbEntry } from "./types";

export const SERVICES: readonly ServiceKbEntry[] = [
  {
    slug: "drain-cleaning",
    name: "Drain Cleaning",
    description: "Clearing clogged sinks, tubs, showers, and branch-line drains.",
    aliases: [
      /\bclog/,
      /\bblock(ed|age|ages)?\b/,
      /\bstoppage|stopped ?up|stoped ?up|plugg?ed?\b/,
      /\bbacked ?up|backing ?up|backup\b/,
      /\b(drain|drains)\b.{0,20}\b(cant (get|clear)|wont drain|doesnt drain|not draining)\b/,
      /\bslow(ly)? [a-z ]{0,12}?(drain|drains|draining)\b/,
      /\b(hair|grease|food) (clog|in the (drain|sink))\b/,
    ],
    defaultUrgency: "same_day",
    typicalValue: { currency: "USD", low: 100, high: 350 },
    qualifyingQuestions: [
      "Which drain is affected (kitchen, bathroom, tub, or laundry)?",
      "Is more than one drain backing up at the same time?",
      "How long has it been draining slowly, and is there standing water?",
      "Have you tried any drain products on it already?",
    ],
    safetyNotes: [
      "If multiple fixtures back up at once, suspect the main line — treat as sewer-main scope.",
      "Ask whether chemical drain cleaner was used; mixing chemicals or snaking after them can splash caustic residue.",
    ],
  },
  {
    slug: "sewer-main",
    name: "Sewer Main Service",
    description: "Main sewer line blockages, camera inspection, and repair or replacement.",
    aliases: [
      /\b(main ?line|mainline|main drain|main sewer|sewer line|sewer lateral|septic)\b/,
      /\bsewer/,
      /\b(every|all) (drain|fixture|sink|toilet) (in the house|is backing|backing)\b/,
      /\bgurgl/,
    ],
    defaultUrgency: "same_day",
    typicalValue: { currency: "USD", low: 200, high: 3000 },
    qualifyingQuestions: [
      "Are multiple drains backing up at once, or just one fixture?",
      "Any gurgling sounds or sewage odors at floor drains?",
      "Any recent digging, tree roots, or heavy vehicles over the yard?",
      "Have you had the line camera-inspected before?",
    ],
    safetyNotes: [
      "Sewage exposure is a health hazard — advise keeping people and pets away from affected areas.",
      "No chemical drain openers on a mainline blockage — they rarely reach it and make cleanup hazardous.",
    ],
  },
  {
    slug: "hydro-jetting",
    name: "Hydro Jetting",
    description: "High-pressure water jetting to scour grease, roots, and buildup from lines.",
    aliases: [
      /\bhydro ?jet|\bjetting\b|\bjet ?line/,
      /\b(high|power) ?pressure (clean|wash|blast)/,
      /\bscour/,
    ],
    defaultUrgency: "within_week",
    typicalValue: { currency: "USD", low: 350, high: 1000 },
    qualifyingQuestions: [
      "Is this a recurring clog or a first-time blockage?",
      "Was grease, roots, or heavy buildup found on a previous visit?",
      "Do you know the pipe material and age (older fragile lines need care)?",
    ],
    safetyNotes: [
      "Confirm pipe condition first — jetting fragile or deteriorated lines can cause damage.",
    ],
  },
  {
    slug: "leak-detection",
    name: "Leak Detection",
    description: "Locating hidden leaks in walls, slabs, yards, and supply lines.",
    aliases: [
      /\bleak/,
      /\bwater bill (spiked|went up|higher|doubled|jumped)/,
      /\b(hissing|sound of running) water\b/,
      /\b(wet|damp|soft) (spot|spots|wall|walls|ceiling|floor|carpet|drywall|yard)\b/,
      /\b(meter) (spinning|moving|running) (when|with|even)\b/,
    ],
    defaultUrgency: "same_day",
    typicalValue: { currency: "USD", low: 150, high: 600 },
    qualifyingQuestions: [
      "Where do you see or hear signs of water, and for how long?",
      "Is the water meter moving with everything shut off?",
      "Is the water actively running, or just staining/dampness?",
    ],
    safetyNotes: [
      "Water near electrical panels, outlets, or appliances: treat as potential electrical hazard, keep clear.",
      "Active uncontained leaking escalates to emergency guidance (shut-off first).",
    ],
  },
  {
    slug: "pipe-repair",
    name: "Pipe Leak Repair",
    description: "Repairing accessible leaking or damaged supply and drain pipes.",
    aliases: [
      /\bpipe (burst|broke|busted|cracked|split|leak)/,
      /\b(burst|busted|ruptured) pipe/,
      /\bpinhole/,
      /\b(copper|pex|galvanized)\b.{0,40}\b(leak|leaking|repair)/,
      /\bfix (a )?(leaking|burst) pipe\b/,
    ],
    defaultUrgency: "same_day",
    typicalValue: { currency: "USD", low: 150, high: 800 },
    qualifyingQuestions: [
      "Where is the leak (under sink, in a wall, basement, ceiling, yard)?",
      "Is water still flowing, and can you shut it off at a valve?",
      "Do you know the pipe material (copper, PEX, galvanized, PVC)?",
    ],
    safetyNotes: [
      "Burst/ruptured piping with uncontrolled water = emergency path (main shut-off script first).",
      "Never advise DIY repairs inside walls or on gas-adjacent lines.",
    ],
  },
  {
    slug: "repiping",
    name: "Repiping",
    description: "Replacing whole-home supply or drain piping (PEX, copper, PVC).",
    aliases: [
      /\bre ?pip(e|ing|ed)\b/,
      /\breplace (all|the|our|my) (pipes?|plumbing|supply lines?|galvanized)/,
      /\bgalvanized\b.{0,30}\b(replace|repip|upgrade)\b|\b(replace|repip|upgrade)\b.{0,30}\bgalvanized\b/,
      /\bwhole[- ]?house (repipe|repiping|re-plumb|re plumbed)\b/,
      /\brepiping the (house|home)\b/,
    ],
    defaultUrgency: "within_week",
    typicalValue: { currency: "USD", low: 4000, high: 15000 },
    qualifyingQuestions: [
      "Is this the whole house or one section?",
      "What triggered it (repeated leaks, rust-colored water, low pressure)?",
      "Is the home occupied during work, and how many bathrooms?",
    ],
    safetyNotes: [
      "Major construction scope — always booked after an on-site diagnosis, never priced remotely.",
    ],
  },
  {
    slug: "water-heater-repair",
    name: "Water Heater Repair",
    description: "Repairing tank and tankless water heaters (elements, thermostats, valves).",
    aliases: [
      /\bwater heater\b|\bwater ?heater|\bhot water (heater|tank)\b/,
      /\btankless\b/,
      /\bno hot (water|watter|wator|wahter)\b/,
      /\bhot water (is |was |has )?(cold|lukewarm|not (hot|working|heating))\b/,
      /\bpilot (light )?(out|went out|wont (stay|light))/,
      /\bthermocouple/,
      /\bwater heatter\b/,
    ],
    defaultUrgency: "same_day",
    typicalValue: { currency: "USD", low: 150, high: 700 },
    qualifyingQuestions: [
      "Gas or electric, and tank or tankless?",
      "Any water leaking from the unit itself?",
      "Is the pilot light out, or a breaker tripped?",
      "How old is the unit (roughly)?",
    ],
    safetyNotes: [
      "Leaking tank with active water = emergency path (shut-off + gas/electric safety).",
      "Never guide customers through gas-valve, gas-line, or burner-assembly DIY work.",
    ],
  },
  {
    slug: "water-heater-replacement",
    name: "Water Heater Replacement",
    description: "Replacing tank and tankless water heaters, including code-required parts.",
    aliases: [
      /\bwater heater (replace|install|new|swap|upgrade)/,
      /\b(replace|installation|new) (of )?(a |the )?water heater\b/,
      /\bnew (water )?heater\b/,
      /\bwater heater (is )?(15|16|17|18|20|[0-9]{1,2}) (years?|yrs?)( old)?\b/,
    ],
    defaultUrgency: "within_week",
    typicalValue: { currency: "USD", low: 1200, high: 3500 },
    qualifyingQuestions: [
      "Repair or replace — has a technician already diagnosed the unit?",
      "Gas or electric, tank or tankless, and what capacity?",
      "Any space, venting, or code considerations known?",
    ],
    safetyNotes: [
      "Gas appliance replacement requires licensed gas work — never DIY guidance.",
      "Expansion tank / permits handled by the installing plumber per local code.",
    ],
  },
  {
    slug: "toilet-repair",
    name: "Toilet Repair & Install",
    description: "Running, clogged, leaking, or rocking toilets; wax rings; new installs.",
    aliases: [
      /\btoilet\b/,
      /\btoilets?\b|\bcommode\b/,
      /\b(wax ring|waxring)\b/,
      /\b(running|runnin|wont stop running|jiggles?)\b.{0,25}\b(handle|flapper|toilet)\b/,
      /\b(handle|flapper)\b.{0,25}\b(running|runnin|wont stop)\b/,
      /\brock(ing|s)?\b.{0,20}\btoilet\b|\btoilet\b.{0,20}\brock(ing|s)?\b/,
      /\btoilit\b/,
    ],
    defaultUrgency: "same_day",
    typicalValue: { currency: "USD", low: 100, high: 400 },
    qualifyingQuestions: [
      "Running, clogged, leaking at the base, or won't flush?",
      "Is water actively overflowing onto the floor?",
      "Repair or replace — do you have the toilet already?",
    ],
    safetyNotes: [
      "Actively overflowing onto the floor is emergency-adjacent — shut-off valve behind the toilet first.",
    ],
  },
  {
    slug: "fixture-repair",
    name: "Faucet & Fixture Repair/Install",
    description: "Faucets, showerheads, tub spouts, hose bibs, and trim repair or install.",
    aliases: [
      /\b(faucet|faucet?ts|tap|taps|spigot|spikit)\b/,
      /\bshower ?head|\btub spout\b/,
      /\b(hose bib|sill ?cock|outdoor spigot|garden hose connection)\b/,
      /\b(dripping|dripy|drip) (faucet|tap|shower)/,
      /\bcartridge|\bvalve stem\b/,
      /\b(vanity|kitchen|bath|shower) (faucet|fixture|trim)\b/,
    ],
    defaultUrgency: "within_week",
    typicalValue: { currency: "USD", low: 100, high: 450 },
    qualifyingQuestions: [
      "Which fixture, and is it leaking, dripping, or being replaced?",
      "Do you have the new fixture, or need one supplied?",
      "Any shutoff valve issues under the sink?",
    ],
    safetyNotes: [
      "A dripping faucet alone is routine; flooding language redirects to the emergency path.",
    ],
  },
  {
    slug: "garbage-disposal",
    name: "Garbage Disposal",
    description: "Disposal jam repair, reset, replacement, and new installs.",
    aliases: [
      /\bgarbage disposal|\bgarburator|\bdisposal\b/,
      /\bdisposul|\bdisposal? ?(hum|jammed|stuck|not (working|turning))\b/,
      /\bsink (grinder|macerator)/,
    ],
    defaultUrgency: "within_week",
    typicalValue: { currency: "USD", low: 100, high: 500 },
    qualifyingQuestions: [
      "Is it humming, completely dead, or leaking from the bottom?",
      "Have you tried the reset button, and is the breaker on?",
      "Repair or replace?",
    ],
    safetyNotes: [
      "Never advise reaching into the disposal chamber; keep hands out, cut power first if anyone attempts the reset.",
      "Leaking from below usually means replacement — do not coach DIY.",
    ],
  },
  {
    slug: "sump-pump",
    name: "Sump Pump",
    description: "Sump pump repair, replacement, battery backups, and pit service.",
    aliases: [
      /\bsump( ?pump)?\b/,
      /\bbattery backup\b.*\b(pump|sump)\b/,
      /\b(crocks?|pit) (pump|overflow)/,
      /\bbasement (taking on water|seepage) (through|from) the floor\b/,
    ],
    defaultUrgency: "same_day",
    typicalValue: { currency: "USD", low: 200, high: 1200 },
    qualifyingQuestions: [
      "Is the pump running at all, running constantly, or dead?",
      "Any water in the pit right now, and rising?",
      "Repair, replace, or add a battery backup?",
    ],
    safetyNotes: [
      "Dead pump with rising water during rain = flooding-adjacent emergency.",
      "Pump runs on mains power — never advise opening the unit.",
    ],
  },
  {
    slug: "gas-line-work",
    name: "Gas Line Work",
    description: "Gas line runs, appliance hookups, and gas leak diagnosis (licensed work).",
    aliases: [
      /\bgas (line|pipe|piping|hook ?up|run|stove|range|fire ?pit|fireplace|dryer|log)/,
      /\bblack (pipe|iron)\b.*\bgas\b/,
      /\bcsst\b/,
      /\bconnect (a |the )?(gas |stove|range|dryer|grill)/,
    ],
    defaultUrgency: "same_day",
    typicalValue: { currency: "USD", low: 200, high: 1500 },
    qualifyingQuestions: [
      "Is this new gas service, a re-route, or an appliance hookup?",
      "Which appliance and where is the nearest existing gas line?",
      "Any current gas odor anywhere? (If yes — emergency script first.)",
    ],
    safetyNotes: [
      "ANY current gas odor overrides this entry and triggers the gas-odor emergency script.",
      "All gas work is licensed-only; zero DIY guidance, zero remote pricing before diagnosis.",
    ],
  },
  {
    slug: "water-quality",
    name: "Water Quality & Filtration",
    description: "Water testing, softeners, whole-home filtration, and RO systems.",
    aliases: [
      /\bwater (softener|softner|conditioner|filter|filtration|treatment|test|testing)\b/,
      /\bhard water|\brust(y| stains?)? water\b|\bsulfur (smell|odor)|rotten egg/,
      /\breverse osmosis|\bro system\b/,
      /\b(pressure tank|whole house filter)\b/,
    ],
    defaultUrgency: "within_week",
    typicalValue: { currency: "USD", low: 200, high: 3000 },
    qualifyingQuestions: [
      "What are you noticing — taste, smell, staining, hardness?",
      "City water or well?",
      "Any recent lab test results?",
    ],
    safetyNotes: [
      "Rotten-egg smell ONLY at hot taps points to the water heater anode — not the gas system; confirm scope carefully so a gas concern is never missed.",
    ],
  },
  {
    slug: "shut-off-valve-service",
    name: "Shut-off Valve & Pressure Service",
    description: "Main shutoff valves, pressure-reducing valves, and pressure issues.",
    aliases: [
      /\b(shut ?off|shutoff|stop ?cock|main|water|ball|gate|angle) (valve|valves|shutoff)\b/,
      /\bpressure (reducing|regulator|relief) valve|\bprv\b/,
      /\bwater pressure [a-z ]{0,10}(too high|insane|excessive|dangerous)\b|\bwater pressure (too high|over [0-9]+ psi|regulator)\b/,
      /\bvalve (wont|doesnt|not) (close|shut|turn|close fully)\b/,
      /\b(valve|valves) (wont|doesnt|not) (close|shut|turn)\b/,
    ],
    defaultUrgency: "same_day",
    typicalValue: { currency: "USD", low: 150,  high: 600 },
    qualifyingQuestions: [
      "Which valve — at the fixture, or the main for the house?",
      "Does the valve turn at all, or is it stuck?",
      "Is the pressure issue high, low, or fluctuating?",
    ],
    safetyNotes: [
      "A stuck main valve during an active leak = emergency path (utility curb-stop guidance).",
    ],
  },
  {
    slug: "slab-leak",
    name: "Slab Leak",
    description: "Under-slab supply leak location and repair or reroute.",
    aliases: [
      /\bslab (leak|leaking)/,
      /\b(hot spot|warm spot)s? (on the )?(floor|slab)\b/,
      /\b(water|wet) (coming up|seeping) (through|from) (the )?(floor|slab|foundation)\b/,
      /\bfoundation (leak|water)\b/,
    ],
    defaultUrgency: "same_day",
    typicalValue: { currency: "USD", low: 500, high: 4000 },
    qualifyingQuestions: [
      "Any warm spots on the floor or a suddenly high water bill?",
      "Sound of running water with everything off?",
      "Has the floor or foundation shown cracks or heaving?",
    ],
    safetyNotes: [
      "Foundation movement or widening cracks: flag for the owner before any structural-sounding advice.",
      "Under-slab work is diagnosis-first; never estimate remotely.",
    ],
  },
  {
    slug: "outdoor-yard-line",
    name: "Outdoor & Yard Line Work",
    description: "Yard service lines, outdoor faucets, irrigation tie-ins, and curb stops.",
    aliases: [
      /\b(yard|underground|buried) (line|pipe|leak|water)/,
      /\bcurb ?(stop|valve)\b/,
      /\bwater (pooling|puddle|puddling|standing) (in the|on the) (yard|lawn)\b/,
      /\birrigation|sprinkler (line|leak|main)/,
    ],
    defaultUrgency: "same_day",
    typicalValue: { currency: "USD", low: 200, high: 2500 },
    qualifyingQuestions: [
      "Where is the water surfacing, and how long has it been there?",
      "Is the meter moving with the house shut off?",
      "Any digging planned nearby (utility locate first)?",
    ],
    safetyNotes: [
      "ANY digging requires the customer to have called 811 (utility locate) first — non-negotiable.",
    ],
  },
  {
    slug: "recirculation-pump",
    name: "Hot Water Recirculation Pump",
    description: "Instant-hot-water recirc pumps: repair, install, timers, and sensors.",
    aliases: [
      /\brecirc(ulation|ulating)? (pump|system|line)/,
      /\bhot water (takes|takes too long|instant|on demand|wait)\b/,
      /\bgrundfos|laing|\btaco (pump|valve)/,
    ],
    defaultUrgency: "within_week",
    typicalValue: { currency: "USD", low: 200, high: 900 },
    qualifyingQuestions: [
      "Is the wait for hot water new, or has it always been that way?",
      "Is there an existing recirc pump, and is it running?",
      "Is the unit under the sink, at the heater, or in the wall?",
    ],
    safetyNotes: [
      "Long hot-water waits can also signal a failing heater — confirm heater health first.",
    ],
  },
];
