import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Nav } from "~/components/marketing/Nav";
import { Button } from "~/components/ui/Button";
import { Badge } from "~/components/ui/Badge";

export const Route = createFileRoute("/demo")({
  component: DemoPage,
});

/* ------------------------------------------------------------------ */
/* Static, clearly-labeled example content. No backend calls anywhere */
/* on this page — every screen below is an illustration, not the app. */
/* ------------------------------------------------------------------ */

type Stage = {
  n: string;
  title: string;
  blurb: string;
  children: ReactNode;
};

const stages: Stage[] = [
  {
    n: "1",
    title: "Missed call",
    blurb:
      "A homeowner has a leaking water heater. She calls your shop — but you're under a sink on another job and can't pick up.",
    children: (
      <BubbleGroup label="Phone log — example">
        <Bubble side="customer">
          <span className="flex items-center gap-2 font-semibold">
            <span aria-hidden="true">📞</span> Missed call
          </span>
          <span className="mt-1 block text-[13px] leading-relaxed opacity-90">
            Incoming call · (555) 014-8821 · 11:42 AM
            <br />
            No answer — 2 rings, 18 seconds, voicemail full.
          </span>
        </Bubble>
      </BubbleGroup>
    ),
  },
  {
    n: "2",
    title: "Instant text-back",
    blurb:
      "Seconds later, MissedCall AI texts the caller automatically — so the lead is engaged before they dial a competitor.",
    children: (
      <BubbleGroup label="Example conversation">
        <Bubble side="ai">
          Hi! This is Rapid Rooter Plumbing — we missed your call just now but
          we'd love to help. What's going on at your place?
        </Bubble>
      </BubbleGroup>
    ),
  },
  {
    n: "3",
    title: "AI conversation",
    blurb:
      "The AI texts back and forth like a good dispatcher: it captures the name, address, the problem, and how urgent it is — no apps to install, the customer just replies.",
    children: (
      <BubbleGroup label="Example conversation">
        <Bubble side="customer">
          Hi yes! My water heater is leaking in the garage. There's water
          pooling on the floor 😟
        </Bubble>
        <Bubble side="ai">
          I'm sorry to hear that! Let's get someone out to you quickly. Can I
          get your name and the address for the service call?
        </Bubble>
        <Bubble side="customer">Maria Gonzalez — 4823 Juniper Lane.</Bubble>
        <Bubble side="ai">
          Thanks, Maria. Is the water still actively leaking, and is the heater
          shut off? This helps us prioritize 🔧
        </Bubble>
        <Bubble side="customer">
          Still dripping from the valve. I turned off the water supply but it's
          still leaking a bit. Can someone come today?
        </Bubble>
      </BubbleGroup>
    ),
  },
  {
    n: "4",
    title: "Lead captured",
    blurb:
      "The conversation becomes a qualified lead in your dashboard — name, service, urgency, and full transcript summary — waiting for you to confirm the job.",
    children: (
      <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-base"
            >
              💧
            </span>
            <div>
              <p className="font-semibold text-slate-900">Maria Gonzalez</p>
              <p className="text-[13px] text-slate-500">
                (555) 014-8821 · 4823 Juniper Lane
              </p>
            </div>
          </div>
          <Badge tone="brand">Status: NEW</Badge>
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Service
            </dt>
            <dd className="mt-0.5 font-medium text-slate-900">
              Water heater leaking — repair
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Priority
            </dt>
            <dd className="mt-0.5 font-medium text-slate-900">
              🔴 High — active leak, same-day request
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Source
            </dt>
            <dd className="mt-0.5 font-medium text-slate-900">
              Missed call → text-back at 11:43 AM
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Next step
            </dt>
            <dd className="mt-0.5 font-medium text-slate-900">
              Call back to confirm the appointment
            </dd>
          </div>
        </dl>
        <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-[13px] text-slate-600">
          <span className="font-semibold">AI summary:</span> Caller's water
          heater is leaking; water supply shut off, still dripping. Requesting
          same-day service. Contact details verified by text.
        </p>
      </div>
    ),
  },
];

function BubbleGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function Bubble({
  side,
  children,
}: {
  side: "ai" | "customer";
  children: ReactNode;
}) {
  const fromAi = side === "ai";
  return (
    <div className={fromAi ? "flex" : "flex justify-end"}>
      <div
        className={
          "max-w-[85%] rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed shadow-sm " +
          (fromAi
            ? "rounded-bl-md bg-slate-800 text-slate-50"
            : "rounded-br-md bg-brand-600 text-white")
        }
      >
        {children}
      </div>
    </div>
  );
}

function DemoPage() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      <Nav />

      {/* Hero */}
      <section className="bg-slate-50 py-16 sm:py-20">
        <div className="mx-auto max-w-4xl px-4 text-center sm:px-6">
          <Badge tone="amber" className="text-xs">
            Sample data — the screens below use example content
          </Badge>
          <h1 className="mt-5 text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">
            See a missed call turn into a booked job
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-slate-600">
            This is a scripted walkthrough of how MissedCall AI works, using
            example content. When you're ready, step into the real product with
            sample data — the actual dashboard, leads, and inbox the software
            ships with.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button variant="primary" size="lg" href="/login?demo=1">
              Explore the live product with sample data
            </Button>
            <Button variant="secondary" size="lg" href="/signup">
              Start free trial
            </Button>
          </div>
        </div>
      </section>

      {/* Scripted walkthrough */}
      <section className="py-16 sm:py-24">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <ol className="space-y-12">
            {stages.map((stage) => (
              <li key={stage.n}>
                <div className="flex items-start gap-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-600 text-base font-bold text-white">
                    {stage.n}
                  </span>
                  <div>
                    <h2 className="text-2xl font-bold tracking-tight text-slate-900">
                      {stage.title}
                    </h2>
                    <p className="mt-1.5 text-[15px] leading-relaxed text-slate-600">
                      {stage.blurb}
                    </p>
                  </div>
                </div>
                <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-5">
                  {stage.children}
                </div>
              </li>
            ))}
          </ol>

          <p className="mt-12 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-inset ring-amber-600/20">
            All names, conversations, and numbers on this page are examples for
            illustration only. The live product you're about to open uses seeded
            sample data — no real customers, calls, or messages.
          </p>
        </div>
      </section>

      {/* Final CTA */}
      <section className="bg-slate-50 py-14">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">
            Every missed call is a job you never knew about.
          </h2>
          <p className="mt-2 text-slate-600">
            Open the live product with sample data, or start your free trial.
          </p>
          <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button variant="primary" size="lg" href="/login?demo=1">
              Explore the live product with sample data
            </Button>
            <Button variant="ghost" size="lg" href="/#top">
              Back to homepage
            </Button>
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-200 py-8 text-center text-sm text-slate-500">
        © {new Date().getFullYear()} MissedCall AI — Missed calls, turned into
        booked jobs.
      </footer>
    </div>
  );
}
