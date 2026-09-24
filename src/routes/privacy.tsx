import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Nav } from "~/components/marketing/Nav";

export const Route = createFileRoute("/privacy")({
  component: Privacy,
});

const SECTIONS: Array<{ title: string; body: ReactNode }> = [
  {
    title: "1. Information we collect",
    body: (
      <>
        <p className="font-medium text-slate-700">From Subscribers:</p>
        <p>
          business details (name, address, phone, email, website), account details
          (name, work email, password), role and team member information, billing
          interactions, and configuration choices (greeting text, transfer rules,
          business hours, service areas).
        </p>
        <p className="font-medium text-slate-700">
          From End Users (people who call a Subscriber):
        </p>
        <p>
          the phone number they called from, the content of text conversations with
          the Subscriber&apos;s AI assistant, and appointment details (such as
          requested service, preferred times, name, and address) that they choose to
          share in the conversation.
        </p>
        <p className="font-medium text-slate-700">Automatically:</p>
        <p>
          technical logs (IP address, timestamps, pages requested) needed to operate
          and secure the service.
        </p>
      </>
    ),
  },
  {
    title: "2. Text messages (SMS) — consent, frequency, and opt-out",
    body: (
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <span className="font-medium text-slate-700">Who gets texts:</span> we only
          send text messages to End Users who contacted the Subscriber first — for
          example, by calling the Subscriber&apos;s phone number. If the call goes
          unanswered, the Subscriber&apos;s MissedCall AI assistant sends a reply
          text to the same number, identifies the business, and offers help. We
          never send promotional or cold messages to people who have not contacted a
          Subscriber.
        </li>
        <li>
          <span className="font-medium text-slate-700">What the messages are:</span>{" "}
          replies to missed calls, answers to service questions, appointment
          scheduling, appointment confirmations and reminders, and service updates.
          Message frequency varies with the conversation — typically a handful of
          messages over a day or two.
        </li>
        <li>
          <span className="font-medium text-slate-700">Opt-out:</span> End Users can
          reply <span className="font-semibold text-slate-700">STOP</span> at any
          time to stop receiving messages from a business. Opt-out takes effect
          immediately and is honored per business. End Users can reply{" "}
          <span className="font-semibold text-slate-700">HELP</span> for help or
          contact us at the email below.
        </li>
        <li>
          <span className="font-medium text-slate-700">Carrier costs:</span> message
          and data rates may apply, depending on the End User&apos;s mobile plan.
        </li>
        <li>
          <span className="font-medium text-slate-700">
            Consent basis for Subscribers&apos; customers:
          </span>{" "}
          because messages are replies to an inbound call, consent is implied by the
          End User initiating contact. Appointment confirmations and reminders are
          sent only to End Users who booked a service.
        </li>
      </ul>
    ),
  },
  {
    title: "3. How we use information",
    body: (
      <ul className="list-disc space-y-2 pl-5">
        <li>
          To provide the service: detecting missed calls, running the AI
          assistant&apos;s conversations, creating leads and appointments, and
          sending notifications to Subscribers.
        </li>
        <li>
          To operate, secure, and improve the product (troubleshooting, analytics,
          abuse prevention).
        </li>
        <li>
          To communicate with Subscribers about their account, trial, billing, and
          service updates.
        </li>
        <li>To honor opt-outs and other End User choices.</li>
      </ul>
    ),
  },
  {
    title: "4. AI processing",
    body: (
      <p>
        Text conversations may be processed by automated systems, including
        third-party AI providers, to understand the request and draft replies on the
        Subscriber&apos;s behalf. Conversations are used only to operate the
        Subscriber&apos;s service and are not used to train models for other
        customers.
      </p>
    ),
  },
  {
    title: "5. Sharing",
    body: (
      <p>
        We share information only with: service providers that help us operate —
        hosting, telephony (including Twilio for voice and SMS delivery), AI
        providers, payment processing, and email delivery — each processing data on
        our instructions; the Subscriber whose customer is texting (all conversation
        content belongs to the Subscriber&apos;s workspace, visible to the
        Subscriber&apos;s team and designated administrators); and law enforcement
        or regulators where legally required.
      </p>
    ),
  },
  {
    title: "6. Data isolation and access",
    body: (
      <p>
        Each Subscriber&apos;s data is stored in its own workspace and is isolated
        from other Subscribers. Our personnel access Subscriber data only to provide
        support, prevent abuse, or comply with law — and administrative access is
        logged in an internal audit trail.
      </p>
    ),
  },
  {
    title: "7. Data retention and deletion",
    body: (
      <p>
        We keep information while a Subscriber&apos;s account is active. When a
        Subscriber deletes their business or closes their account, we delete the
        associated workspace data. End Users who want their information removed can
        reply STOP (no further messages) or contact the business they called, or
        email us at the address above. We may retain minimal records (for example,
        billing history) where required by law.
      </p>
    ),
  },
  {
    title: "8. Security",
    body: (
      <p>
        We use encryption in transit (TLS), hashed passwords, per-workspace access
        controls, and least-privilege administrative access. No method of
        transmission or storage is perfectly secure, but we work to protect data
        against unauthorized access.
      </p>
    ),
  },
  {
    title: "9. Your choices and rights",
    body: (
      <p>
        Depending on your location, you may have rights to access, correct, or
        delete personal information, or to object to certain processing. Contact us
        at <span className="font-medium text-slate-700">missedcall-ai-ab7414dd@ctomail.io</span>{" "}
        and we will respond within a reasonable time. End Users may also opt out of
        messages at any time by replying STOP.
      </p>
    ),
  },
  {
    title: "10. Children",
    body: (
      <p>
        The service is not directed to children under 13, and we do not knowingly
        collect their personal information.
      </p>
    ),
  },
  {
    title: "11. Changes to this policy",
    body: (
      <p>
        We may update this policy as the service evolves. We will post changes on
        this page with a new effective date.
      </p>
    ),
  },
];

function Privacy() {
  return (
    <div className="flex min-h-dvh flex-col">
      <Nav />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-16 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          Privacy Policy
        </h1>
        <p className="mt-2 text-sm text-slate-500">Effective date: September 24, 2026</p>
        <div className="mt-6 space-y-4 text-slate-600">
          <p>
            MissedCall AI (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;) provides software that helps
            service businesses — starting with plumbing companies — respond to
            missed phone calls by text message, answer customer questions with an AI
            assistant, and schedule appointments. This policy explains what
            information we collect, how we use it, and the choices you have. It
            applies to (a) businesses that subscribe to MissedCall AI
            (&quot;Subscribers&quot;) and (b) individuals who contact a Subscriber and
            receive text messages through the service (&quot;End Users&quot;).
          </p>
          <p>
            Questions or requests: contact us at{" "}
            <span className="font-medium text-slate-700">
              missedcall-ai-ab7414dd@ctomail.io
            </span>
            .
          </p>
        </div>
        <div className="mt-10 space-y-10">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h2 className="text-lg font-semibold text-slate-900">
                {section.title}
              </h2>
              <div className="mt-3 space-y-3 text-slate-600">{section.body}</div>
            </section>
          ))}
        </div>
        <div className="mt-12 border-t border-slate-200 pt-6 text-slate-600">
          <h2 className="text-lg font-semibold text-slate-900">12. Contact</h2>
          <p className="mt-3">
            MissedCall AI — missedcall-ai-ab7414dd@ctomail.io
          </p>
        </div>
      </main>
      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-2xl px-4 py-6 text-sm text-slate-500 sm:px-6">
          <a href="/terms" className="text-brand-600 hover:text-brand-700">
            Terms &amp; Conditions
          </a>
          <span className="mx-2">·</span>
          <a href="/sms-consent" className="text-brand-600 hover:text-brand-700">
            SMS Messaging
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
