import { createFileRoute } from "@tanstack/react-router";
import { Nav } from "~/components/marketing/Nav";

export const Route = createFileRoute("/sms-consent")({
  component: SmsConsent,
});

function SmsConsent() {
  return (
    <div className="flex min-h-dvh flex-col">
      <Nav />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-16 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          SMS Messaging Disclosure
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          How text messaging works between you and businesses using MissedCall AI
        </p>
        <div className="mt-8 space-y-10 text-slate-600">
          <section>
            <h2 className="text-lg font-semibold text-slate-900">
              How you opt in
            </h2>
            <div className="mt-3 space-y-3">
              <p>
                MissedCall AI sends text messages on behalf of the service business
                whose number you contacted — never from a number you haven&apos;t
                contacted first. There are two ways a messaging conversation with a
                business begins:
              </p>
              <ol className="list-decimal space-y-3 pl-5">
                <li>
                  <span className="font-medium text-slate-700">
                    You call the business.
                  </span>{" "}
                  When you call a business phone number served by MissedCall AI —
                  for this registration, <span className="font-semibold text-slate-700">+1 (385) 336-5359</span> —
                  and the call goes unanswered, you receive a reply text from that
                  same number identifying the business and offering help. Your
                  inbound call is what starts the conversation.
                </li>
                <li>
                  <span className="font-medium text-slate-700">
                    You text the business.
                  </span>{" "}
                  You can opt in explicitly at any time by texting{" "}
                  <span className="font-semibold text-slate-700">START</span> to the
                  business&apos;s number — for this registration:{" "}
                  <span className="font-semibold text-slate-700">
                    Text START to +1 (385) 336-5359
                  </span>{" "}
                  — and you will receive a confirmation text.
                </li>
              </ol>
              <p>
                The business phone number is published on the business&apos;s own
                website and customer materials, and this disclosure is publicly
                linked in this website&apos;s footer.
              </p>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900">
              What messages you&apos;ll receive
            </h2>
            <p className="mt-3">
              Replies to missed calls, answers to your service questions,
              appointment scheduling, appointment confirmations and reminders, and
              service updates from the business you contacted. Message frequency
              varies with the conversation — typically a few messages over a day or
              two. <span className="font-medium text-slate-700">Message and data rates may apply</span> depending
              on your mobile plan.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900">
              Opting out and getting help
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                Reply <span className="font-semibold text-slate-700">STOP</span> at
                any time to stop receiving texts from a business. Opt-out is
                immediate and honored permanently unless you text START again.
              </li>
              <li>
                Reply <span className="font-semibold text-slate-700">HELP</span> for
                help, or contact the business directly.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900">
              Your privacy
            </h2>
            <p className="mt-3">
              See our{" "}
              <a href="/privacy" className="text-brand-600 hover:text-brand-700">
                Privacy Policy
              </a>{" "}
              and{" "}
              <a href="/terms" className="text-brand-600 hover:text-brand-700">
                Terms &amp; Conditions
              </a>
              . Questions? Contact{" "}
              <span className="font-medium text-slate-700">
                missedcall-ai-ab7414dd@ctomail.io
              </span>
              .
            </p>
          </section>
        </div>
      </main>
      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-2xl px-4 py-6 text-sm text-slate-500 sm:px-6">
          <a href="/privacy" className="text-brand-600 hover:text-brand-700">
            Privacy Policy
          </a>
          <span className="mx-2">·</span>
          <a href="/terms" className="text-brand-600 hover:text-brand-700">
            Terms &amp; Conditions
          </a>
          <span className="mx-2">·</span>
          <a href="/" className="text-brand-600 hover:text-brand-700">
            ← Back to MissedCall AI
          </a>
        </div>
      </footer>
    </div>
  );
}
