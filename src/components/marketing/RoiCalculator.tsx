import { useState } from "react";
import { Badge } from "~/components/ui/Badge";
import { Button } from "~/components/ui/Button";
import {
  computeRoiCalculator,
  formatCentsAsDollars,
  ROI_CALCULATOR_DEFAULTS,
  ROI_CALCULATOR_ASSUMPTIONS,
} from "~/lib/roiCalculator";
import { PLANS } from "~/lib/pricing";

/**
 * P5-7 public ROI calculator — sits on the landing page, no login required.
 *
 * HONESTY CONTRACT (pinned by scripts/test-p57-acquisition.ts):
 *   - Every number shown is either the VISITOR'S OWN INPUT, an ILLUSTRATIVE
 *     default (labeled as such), or a clearly chipped ESTIMATE computed by
 *     src/lib/roiCalculator.ts from conservative assumptions.
 *   - Plan prices render from src/lib/pricing.ts (PLANS) — never literals.
 *   - No claim about results real customers achieved appears anywhere.
 */

/** The estimate chip — mirrors the in-app ROI panel's labeling contract. */
function EstimateChip() {
  return (
    <Badge tone="amber" className="ml-2 align-middle">
      Estimate
    </Badge>
  );
}

export function RoiCalculator() {
  // Inputs start on the ILLUSTRATIVE defaults, labeled as examples below.
  const [calls, setCalls] = useState(String(ROI_CALCULATOR_DEFAULTS.missedCallsPerWeek));
  const [jobValue, setJobValue] = useState(String(ROI_CALCULATOR_DEFAULTS.averageJobValueCents / 100));

  const result = computeRoiCalculator({
    missedCallsPerWeek: Number(calls),
    averageJobValueCents: Math.round(Number(jobValue) * 100),
  });

  const starter = result.plans.find((p) => p.planId === "starter");
  const pro = result.plans.find((p) => p.planId === "pro");

  return (
    <section id="roi-calculator" className="scroll-mt-24 bg-white py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-600">
            ROI Calculator
          </p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            What are your missed calls worth?
          </h2>
          <p className="mt-4 text-lg text-slate-600">
            Enter your shop&apos;s numbers and see an estimated monthly revenue
            recovery compared with the plan price. It&apos;s a planning estimate —
            not a promise.
          </p>
        </div>

        <div className="mx-auto mt-10 grid max-w-4xl gap-6 lg:grid-cols-2">
          {/* Inputs — the visitor's own numbers */}
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6">
            <h3 className="text-base font-semibold text-slate-900">Your numbers</h3>
            <div className="mt-5 space-y-5">
              <div>
                <label htmlFor="roi-calls" className="block text-sm font-medium text-slate-700">
                  Missed calls per week
                </label>
                <input
                  id="roi-calls"
                  type="number"
                  min={0}
                  max={500}
                  step={1}
                  inputMode="numeric"
                  value={calls}
                  onChange={(e) => setCalls(e.target.value)}
                  className="mt-2 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
                <p className="mt-1.5 text-xs text-slate-500">
                  Calls you couldn&apos;t answer — on jobs, driving, after hours.
                </p>
              </div>
              <div>
                <label htmlFor="roi-value" className="block text-sm font-medium text-slate-700">
                  Average job value ($)
                </label>
                <div className="relative mt-2">
                  <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-slate-500">
                    $
                  </span>
                  <input
                    id="roi-value"
                    type="number"
                    min={0}
                    max={1000000}
                    step={1}
                    inputMode="numeric"
                    value={jobValue}
                    onChange={(e) => setJobValue(e.target.value)}
                    className="block w-full rounded-lg border border-slate-300 bg-white py-2 pl-7 pr-3 text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                </div>
                <p className="mt-1.5 text-xs text-slate-500">
                  Example default for a small residential plumbing job — edit it
                  to match your typical ticket.
                </p>
              </div>
            </div>
          </div>

          {/* Results — every figure chipped as an estimate */}
          <div className="rounded-2xl border border-brand-200 bg-brand-50/50 p-6">
            <div className="flex items-center">
              <h3 className="text-base font-semibold text-slate-900">
                Estimated monthly revenue recovered
              </h3>
              <EstimateChip />
            </div>
            <p className="mt-2 text-4xl font-extrabold tracking-tight text-slate-900">
              {formatCentsAsDollars(result.estimatedRevenueCents)}
              <span className="ml-1 text-base font-medium text-slate-500">/month</span>
            </p>
            <p className="mt-1 text-sm text-slate-600">
              ≈ {result.estimatedJobsPerMonth} jobs and {result.estimatedLeadsPerMonth} recovered
              leads per month from about {result.monthlyMissedCalls} missed calls
              <EstimateChip />
            </p>

            <ul className="mt-5 space-y-2.5 text-sm">
              {PLANS.map((plan) => {
                const p = plan.id === "starter" ? starter : pro;
                if (!p) return null;
                return (
                  <li
                    key={plan.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5"
                  >
                    <span className="font-medium text-slate-700">
                      {plan.name} ({formatCentsAsDollars(p.priceCents)}/mo)
                    </span>
                    <span className="text-right text-slate-900">
                      {formatCentsAsDollars(p.netCents)} net/mo
                      <span className="block text-xs text-slate-500">
                        ≈ {p.roiMultiple}× the plan price
                        <EstimateChip />
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>

            <div className="mt-6">
              <Button variant="primary" size="lg" href="/signup" className="w-full">
                Start Your Free Trial
              </Button>
            </div>
          </div>
        </div>

        {/* The assumptions, stated plainly */}
        <p className="mx-auto mt-8 max-w-3xl rounded-lg bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-500 ring-1 ring-inset ring-slate-200">
          How this estimate is made: monthly missed calls ({ROI_CALCULATOR_ASSUMPTIONS.weeksPerMonth.toFixed(2)} weeks/month)
          × {ROI_CALCULATOR_ASSUMPTIONS.replyRate * 100}% who engage with the text-back
          × {ROI_CALCULATOR_ASSUMPTIONS.replyToLeadRate * 100}% of replies that become a qualified lead
          × {ROI_CALCULATOR_ASSUMPTIONS.leadToJobRate * 100}% of leads that become a won job,
          at your average job value. These are fixed, deliberately conservative
          planning assumptions — not measured averages. Your in-app dashboard
          replaces them with your shop&apos;s real numbers. The starting values
          above are illustrative examples, not market data.
        </p>
      </div>
    </section>
  );
}
