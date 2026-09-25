import { createFileRoute } from "@tanstack/react-router";
import { Nav } from "~/components/marketing/Nav";
import { Button } from "~/components/ui/Button";
import { SUPPORT_EMAIL } from "~/lib/contact";
import { TRIAL_DAYS } from "~/lib/pricing";

export const Route = createFileRoute("/contact")({
  component: ContactPage,
});

/**
 * P5-7 contact/support page.
 *
 * Everything here is real: the support email is the business's own inbox (the
 * same address already published on /privacy, /terms, and /sms-consent), the
 * response expectations are plain commitments (no invented SLA numbers), and
 * there are no fake addresses, testimonials, or team pages. Where something
 * does not exist yet, the page says so plainly.
 */
function ContactPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-white text-slate-900">
      <Nav />
      <main className="flex-1">
        <section className="bg-slate-50 py-16 sm:py-20">
          <div className="mx-auto max-w-3xl px-4 sm:px-6">
            <p className="text-sm font-semibold uppercase tracking-wide text-brand-600">
              Contact
            </p>
            <h1 className="mt-2 text-4xl font-extrabold tracking-tight sm:text-5xl">
              Questions? Talk to us.
            </h1>
            <p className="mt-4 text-lg text-slate-600">
              Whether you&apos;re sizing up MissedCall AI for your shop or you&apos;re
              already a customer with a problem, email is the fastest way to
              reach us.
            </p>
          </div>
        </section>

        <section className="py-14 sm:py-16">
          <div className="mx-auto max-w-3xl space-y-8 px-4 sm:px-6">
            {/* The channel — real, single address */}
            <div className="rounded-2xl border border-slate-200 bg-white p-6">
              <h2 className="text-lg font-semibold">Email support</h2>
              <p className="mt-3 text-slate-600">
                Write to{" "}
                <a
                  href={`mailto:${SUPPORT_EMAIL}`}
                  className="font-semibold text-brand-700 underline decoration-brand-300 underline-offset-2 hover:text-brand-800"
                >
                  {SUPPORT_EMAIL}
                </a>{" "}
                and we&apos;ll reply to the address you write from.
              </p>
              <div className="mt-4 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600 ring-1 ring-inset ring-slate-200">
                <p className="font-medium text-slate-800">Help us help you faster</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li>For account issues: the email you signed up with and your business name.</li>
                  <li>For billing: the date and amount of the charge in question.</li>
                  <li>For a technical problem: what you expected and what happened instead.</li>
                </ul>
              </div>
              <p className="mt-4 text-sm text-slate-600">
                What to expect: a reply from a real person on the team. We aim
                to answer within a business day or two; some issues take longer
                if we need to reproduce them. There is no phone support line —
                we&apos;d rather answer in writing where nothing gets lost.
              </p>
            </div>

            {/* Emergencies — the honest guardrail */}
            <div className="rounded-2xl border border-slate-200 bg-white p-6">
              <h2 className="text-lg font-semibold">
                If you have a plumbing emergency right now
              </h2>
              <p className="mt-3 text-slate-600">
                MissedCall AI captures and routes messages for the plumbing
                businesses that use it — it isn&apos;t a plumbing company and can&apos;t
                dispatch anyone. If water is going where it shouldn&apos;t, contact
                a local plumber directly, or your utility for gas or water
                supply hazards.
              </p>
            </div>

            {/* Trial / billing pointers — links to real surfaces */}
            <div className="rounded-2xl border border-slate-200 bg-white p-6">
              <h2 className="text-lg font-semibold">Common questions</h2>
              <dl className="mt-4 space-y-4 text-sm">
                <div>
                  <dt className="font-medium text-slate-800">How does the free trial work?</dt>
                  <dd className="mt-1 text-slate-600">
                    Every plan starts with a {TRIAL_DAYS}-day free trial, no credit
                    card to start. You can cancel anytime from Settings → Billing
                    — see the{" "}
                    <a href="/#pricing" className="text-brand-700 underline underline-offset-2">
                      pricing section
                    </a>{" "}
                    for what each plan includes.
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-800">How do you handle my data?</dt>
                  <dd className="mt-1 text-slate-600">
                    The short version: your business&apos;s data is yours, and
                    customer texts are used to run your service — not sold. The{" "}
                    <a href="/privacy" className="text-brand-700 underline underline-offset-2">
                      Privacy Policy
                    </a>{" "}
                    has the details, and the{" "}
                    <a href="/sms-consent" className="text-brand-700 underline underline-offset-2">
                      SMS consent
                    </a>{" "}
                    page explains how customer texting works and how to stop it.
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-800">Where are the terms?</dt>
                  <dd className="mt-1 text-slate-600">
                    <a href="/terms" className="text-brand-700 underline underline-offset-2">
                      Terms of Service
                    </a>{" "}
                    covers accounts, billing, and acceptable use.
                  </dd>
                </div>
              </dl>
            </div>

            <div className="text-center">
              <Button variant="primary" size="lg" href="/signup">
                Start Your Free Trial
              </Button>
              <p className="mt-3 text-sm text-slate-500">
                {TRIAL_DAYS}-day free trial · no credit card to start
              </p>
            </div>
          </div>
        </section>
      </main>
      <footer className="border-t border-slate-200 py-8 text-center text-sm text-slate-500">
        © {new Date().getFullYear()} MissedCall AI — Missed calls, turned into
        booked jobs.
      </footer>
    </div>
  );
}
