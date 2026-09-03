import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "~/components/ui/Badge";
import { Button } from "~/components/ui/Button";
import { Nav } from "~/components/marketing/Nav";
import { DashboardMockup } from "~/components/marketing/DashboardMockup";
import { Icon, type IconName } from "~/components/marketing/icons";

export const Route = createFileRoute("/")({
  component: Home,
});

/* ---------- content ---------- */

const problemReasons: { icon: IconName; text: string }[] = [
  { icon: "hard-hat", text: "On a job site with both hands full" },
  { icon: "truck", text: "Driving between jobs" },
  { icon: "clock", text: "Helping another customer" },
  { icon: "moon", text: "After hours and weekends" },
  { icon: "alert-triangle", text: "Handling an emergency call" },
  { icon: "phone-off", text: "Unable to reach the phone in time" },
];

const solutionSteps: { n: string; title: string; body: string }[] = [
  {
    n: "1",
    title: "Customer Calls",
    body: "A homeowner needs a plumber and calls your business.",
  },
  {
    n: "2",
    title: "You Miss the Call",
    body: "You're on a job, driving, or after hours — and can't pick up.",
  },
  {
    n: "3",
    title: "MissedCall AI Follows Up",
    body: "The customer automatically gets a text and the conversation begins.",
  },
  {
    n: "4",
    title: "Lead Gets Recovered",
    body: "The conversation qualifies the customer and helps schedule the job.",
  },
];

const features: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "message-square",
    title: "Automatic Missed-Call Follow-Up",
    body: "Automatically engage customers after missed calls.",
  },
  {
    icon: "sparkles",
    title: "AI Lead Qualification",
    body: "Collect important information about the customer's plumbing problem.",
  },
  {
    icon: "calendar-check",
    title: "Appointment Booking",
    body: "Help turn qualified leads into scheduled jobs.",
  },
  {
    icon: "layout-dashboard",
    title: "Lead Dashboard",
    body: "See every recovered lead in one place.",
  },
  {
    icon: "inbox",
    title: "Conversation Inbox",
    body: "View customer conversations and take over manually when necessary.",
  },
  {
    icon: "trending-up",
    title: "Revenue Tracking",
    body: "Estimate how much revenue recovered leads could represent.",
  },
];

const tiers = [
  {
    name: "Starter",
    price: "$79",
    cadence: "/month",
    highlight: false,
    features: [
      "1 phone number",
      "250 AI conversations/month",
      "Missed-call follow-up",
      "Lead management",
      "SMS conversations",
      "Basic analytics",
    ],
  },
  {
    name: "Growth",
    price: "$149",
    cadence: "/month",
    highlight: true,
    features: [
      "2 phone numbers",
      "750 AI conversations/month",
      "Everything in Starter",
      "Appointment booking",
      "Advanced analytics",
      "Team members",
    ],
  },
  {
    name: "Pro",
    price: "$299",
    cadence: "/month",
    highlight: false,
    features: [
      "5 phone numbers",
      "2,000 AI conversations/month",
      "Everything in Growth",
      "Multiple locations",
      "Advanced reporting",
      "Custom AI instructions",
      "More team members",
    ],
  },
];

const faqs: { q: string; a: string }[] = [
  {
    q: "What happens when I miss a call?",
    a: "MissedCall AI can automatically follow up with the caller by text and begin collecting information about their request.",
  },
  {
    q: "Does MissedCall AI replace my phone?",
    a: "No. It is designed to work alongside your existing business phone workflow.",
  },
  {
    q: "Can I take over the conversation?",
    a: "Yes. Businesses will be able to switch from AI mode to human mode.",
  },
  {
    q: "Can it book appointments?",
    a: "Yes. The full product will support appointment scheduling based on the availability configured by the business.",
  },
  {
    q: "Can I customize the AI?",
    a: "Yes. Businesses will be able to customize their services, business information, and AI instructions.",
  },
  {
    q: "Is there a free trial?",
    a: "Yes. The application should support a free trial architecture.",
  },
];

/* ---------- sections ---------- */

function SectionHeading({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body?: string;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-sm font-semibold uppercase tracking-wide text-brand-600">
        {eyebrow}
      </p>
      <h2 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
        {title}
      </h2>
      {body && <p className="mt-4 text-lg text-slate-600">{body}</p>}
    </div>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden bg-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(37,99,235,0.08),transparent)]" aria-hidden />
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:py-24">
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">
            Turn Missed Calls Into{" "}
            <span className="text-brand-600">Booked Plumbing Jobs</span>
          </h1>
          <p className="mt-5 text-lg text-slate-600">
            When you can&apos;t answer the phone, MissedCall AI follows up with the
            customer, qualifies the opportunity, and helps turn missed calls into
            real jobs.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button variant="primary" size="lg" href="#pricing">
              Start Free Trial
            </Button>
            <Button variant="secondary" size="lg" href="#how-it-works">
              See How It Works
            </Button>
          </div>
          <p className="mt-4 text-sm text-slate-500">
            Built for busy plumbing companies. No credit card to start.
          </p>
        </div>

        <div id="demo" className="scroll-mt-24">
          <DashboardMockup />
          <div className="mt-6 flex justify-center">
            <Button variant="primary" size="lg" href="/demo">
              Open the interactive demo
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Problem() {
  return (
    <section className="bg-slate-50 py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="The Problem"
          title="Every missed call could be a lost customer."
        />
        <p className="mx-auto mt-4 max-w-2xl text-center text-lg text-slate-600">
          Plumbers miss calls because they&apos;re working on another customer&apos;s
          home, driving, on a job site, after hours, handling an emergency, or
          unable to reach the phone — and customers often call the next plumbing
          company when nobody answers.
        </p>
        <ul className="mx-auto mt-12 grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {problemReasons.map((r) => (
            <li
              key={r.text}
              className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-4"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-aqua-50 text-aqua-700">
                <Icon name={r.icon} className="h-5 w-5" />
              </span>
              <span className="text-sm font-medium text-slate-700">{r.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Solution() {
  return (
    <section id="how-it-works" className="scroll-mt-24 bg-white py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="The Solution"
          title="Your missed calls shouldn't disappear."
        />
        <ol className="mx-auto mt-12 grid max-w-5xl grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {solutionSteps.map((s, i) => (
            <li key={s.n} className="relative">
              <div className="flex h-full flex-col rounded-xl border border-slate-200 bg-white p-6">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white">
                    {s.n}
                  </span>
                  {i < solutionSteps.length - 1 && (
                    <span className="hidden h-px flex-1 bg-slate-200 lg:block" aria-hidden />
                  )}
                </div>
                <h3 className="mt-4 text-base font-semibold text-slate-900">
                  {s.title}
                </h3>
                <p className="mt-2 text-sm text-slate-600">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="features" className="scroll-mt-24 bg-slate-50 py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading eyebrow="Features" title="Built for the job" />
        <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.title}
              className="rounded-xl border border-slate-200 bg-white p-6 transition-shadow hover:shadow-md"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                <Icon name={f.icon} className="h-6 w-6" />
              </span>
              <h3 className="mt-4 text-base font-semibold text-slate-900">
                {f.title}
              </h3>
              <p className="mt-2 text-sm text-slate-600">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SocialProof() {
  return (
    <section className="bg-white py-16 sm:py-24">
      <div className="mx-auto max-w-4xl px-4 sm:px-6">
        <SectionHeading eyebrow="Customers" title="Trusted by plumbing teams" />
        <div className="mt-12 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
          <p className="text-lg font-medium text-slate-500">
            Customer testimonial will appear here.
          </p>
          <p className="mt-2 text-sm text-slate-400">
            Placeholder — replace with a real customer quote once available.
          </p>
        </div>
      </div>
    </section>
  );
}

function Pricing() {
  return (
    <section id="pricing" className="scroll-mt-24 bg-slate-50 py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="Pricing"
          title="Simple pricing that pays for itself"
          body="Every plan includes a free trial. Start free and upgrade when you're ready."
        />
        <div className="mt-12 grid grid-cols-1 gap-6 lg:grid-cols-3">
          {tiers.map((t) => (
            <div
              key={t.name}
              className={`relative flex flex-col rounded-2xl border bg-white p-6 ${
                t.highlight
                  ? "border-brand-600 shadow-lg ring-1 ring-brand-600"
                  : "border-slate-200"
              }`}
            >
              {t.highlight && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <Badge tone="brand">Most Popular</Badge>
                </div>
              )}
              <h3 className="text-lg font-semibold text-slate-900">{t.name}</h3>
              <div className="mt-3 flex items-baseline gap-1">
                <span className="text-4xl font-extrabold tracking-tight text-slate-900">
                  {t.price}
                </span>
                <span className="text-sm text-slate-500">{t.cadence}</span>
              </div>
              <ul className="mt-6 flex-1 space-y-3">
                {t.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-slate-600">
                    <Icon name="check-circle" className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-8">
                <Button
                  variant={t.highlight ? "primary" : "secondary"}
                  size="lg"
                  href="#pricing"
                  className="w-full"
                >
                  Start Free Trial
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Faq() {
  return (
    <section id="faq" className="scroll-mt-24 bg-white py-16 sm:py-24">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <SectionHeading eyebrow="FAQ" title="Frequently asked questions" />
        <div className="mt-12 space-y-3">
          {faqs.map((f) => (
            <details
              key={f.q}
              className="group rounded-lg border border-slate-200 bg-white open:shadow-sm"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-left font-medium text-slate-900 hover:bg-slate-50">
                {f.q}
                <span className="text-slate-400 transition-transform group-open:rotate-45">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-5 w-5" aria-hidden="true">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </span>
              </summary>
              <p className="px-5 pb-4 text-sm text-slate-600">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-slate-50">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="flex flex-col items-start justify-between gap-8 md:flex-row md:items-center">
          <div>
            <a href="/" className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
                MC
              </span>
              <span className="text-base font-bold tracking-tight text-slate-900">
                MissedCall <span className="text-brand-600">AI</span>
              </span>
            </a>
            <p className="mt-2 text-sm text-slate-600">
              Turn missed calls into booked plumbing jobs.
            </p>
          </div>
          <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <a href="/terms" className="text-slate-600 hover:text-slate-900">
              Terms of Service
            </a>
            <a href="/privacy" className="text-slate-600 hover:text-slate-900">
              Privacy Policy
            </a>
            <a href="/login" className="text-slate-600 hover:text-slate-900">
              Log in
            </a>
            <Button variant="primary" size="sm" href="#pricing">
              Start Free Trial
            </Button>
          </nav>
        </div>
        <p className="mt-8 text-xs text-slate-400">
          © {new Date().getFullYear()} MissedCall AI. All rights reserved.
        </p>
      </div>
    </footer>
  );
}

/* ---------- page ---------- */

function Home() {
  return (
    <div className="flex min-h-dvh flex-col">
      <Nav />
      <main className="flex-1">
        <Hero />
        <Problem />
        <Solution />
        <Features />
        <SocialProof />
        <Pricing />
        <Faq />
      </main>
      <Footer />
    </div>
  );
}
