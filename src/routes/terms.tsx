import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Nav } from "~/components/marketing/Nav";

export const Route = createFileRoute("/terms")({
  component: Terms,
});

const SECTIONS: Array<{ title: string; body: ReactNode }> = [
  {
    title: "1. The Service",
    body: (
      <p>
        MissedCall AI detects missed calls to your business phone number, texts the
        caller, runs an automated AI conversation to capture their service need and
        contact details, and delivers the resulting lead, appointment request, and
        notifications to you. An optional AI voice receptionist can answer incoming
        calls. Features evolve as the product improves.
      </p>
    ),
  },
  {
    title: "2. Accounts and eligibility",
    body: (
      <ul className="list-disc space-y-2 pl-5">
        <li>
          You must be at least 18 years old and provide accurate business and
          contact information.
        </li>
        <li>
          You are responsible for your account credentials and for activity under
          your account.
        </li>
        <li>
          You must have the right to use the phone number(s) you connect to the
          Service and to contact the customers who call it.
        </li>
      </ul>
    ),
  },
  {
    title: "3. Free trial, billing, and cancellation",
    body: (
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <span className="font-medium text-slate-700">Free trial:</span> new
          accounts include a 14-day free trial. Trial terms are shown at signup.
        </li>
        <li>
          <span className="font-medium text-slate-700">Plans:</span> Starter at
          $149/month and Pro at $249/month. Current pricing is shown at checkout and
          on the pricing page.
        </li>
        <li>
          <span className="font-medium text-slate-700">Billing:</span> paid plans
          renew automatically each month through our payment processor (Stripe)
          until cancelled. You authorize recurring charges to your payment method.
        </li>
        <li>
          <span className="font-medium text-slate-700">Cancellation:</span> you can
          cancel at any time from your account or by contacting us. Cancellation
          stops future billing; access continues to the end of the paid period. Fees
          already paid are non-refundable except where required by law.
        </li>
        <li>
          <span className="font-medium text-slate-700">Changes:</span> if we change
          prices, we will notify you in advance, and changes apply at your next
          renewal.
        </li>
      </ul>
    ),
  },
  {
    title: "4. Acceptable use",
    body: (
      <>
        <p>You agree not to:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Use the Service to send messages to people who have not contacted your
            business first (no cold outreach, purchased lists, or scraped numbers);
          </li>
          <li>Use the Service for unlawful, fraudulent, harassing, or deceptive purposes;</li>
          <li>
            Send emergency-service requests through automated messages — the Service
            is not an emergency line, and callers with emergencies should be
            directed to call 911 or your on-call line;
          </li>
          <li>Interfere with the Service, probe its security, or access other customers&apos; data;</li>
          <li>Resell or provide the Service to third parties without our written agreement.</li>
        </ul>
        <p>
          You are responsible for the content of the messages your business
          configures and the customers you contact through the Service, and for
          complying with applicable communications laws (including TCPA and carrier
          messaging rules).
        </p>
      </>
    ),
  },
  {
    title: "5. Text messages (SMS) and phone",
    body: (
      <ul className="list-disc space-y-2 pl-5">
        <li>
          Messages sent through the Service are replies to inbound calls or related
          to bookings your customers made. Message and data rates may apply to
          recipients; recipients can reply STOP to opt out at any time.
        </li>
        <li>Message delivery depends on carriers and is not guaranteed.</li>
        <li>
          Call handling (forwarding, the AI voice receptionist, and voicemail)
          depends on your telephony provider&apos;s capabilities and configuration.
        </li>
      </ul>
    ),
  },
  {
    title: "6. AI-generated content",
    body: (
      <p>
        Replies drafted by the AI assistant are automated and may occasionally be
        inaccurate or incomplete. You are responsible for reviewing conversations
        and for the appointments and commitments made through the Service on your
        behalf. AI output is not professional advice (legal, financial, or
        technical), and the Service does not replace your judgment on which jobs to
        accept.
      </p>
    ),
  },
  {
    title: "7. Your data",
    body: (
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <span className="font-medium text-slate-700">You own your data:</span>{" "}
          your business information, customer conversations, leads, and appointments
          belong to you.
        </li>
        <li>
          <span className="font-medium text-slate-700">End Users&apos; data:</span>{" "}
          you are responsible for your customers&apos; information that flows
          through the Service; we process it on your behalf to provide the Service.
          See our{" "}
          <a href="/privacy" className="text-brand-600 hover:text-brand-700">
            Privacy Policy
          </a>{" "}
          for how we collect, use, and protect information.
        </li>
        <li>
          <span className="font-medium text-slate-700">Backups and deletion:</span>{" "}
          we perform routine database maintenance and backups for reliability; if
          you delete your business or close your account, we delete the associated
          workspace data as described in the Privacy Policy.
        </li>
      </ul>
    ),
  },
  {
    title: "8. Third-party services",
    body: (
      <p>
        The Service relies on third parties — including hosting, telephony
        (Twilio), AI providers, payment processing (Stripe), and email delivery —
        whose availability and terms are outside our control. Your use of those
        services may be subject to their own terms.
      </p>
    ),
  },
  {
    title: "9. Availability",
    body: (
      <p>
        We work to keep the Service reliable, but we do not guarantee uninterrupted
        or error-free operation. Planned maintenance and third-party outages can
        affect availability. We will make reasonable efforts to communicate
        significant service disruptions.
      </p>
    ),
  },
  {
    title: "10. Termination",
    body: (
      <ul className="list-disc space-y-2 pl-5">
        <li>You may stop using the Service and cancel your subscription at any time.</li>
        <li>
          We may suspend or terminate accounts that violate these Terms (including
          the Acceptable Use rules) or that we are legally required to restrict,
          with notice where practicable.
        </li>
        <li>
          On termination, your right to use the Service ends and your data is
          handled per Section 7 and the Privacy Policy.
        </li>
      </ul>
    ),
  },
  {
    title: "11. Disclaimers",
    body: (
      <p>
        THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; WITHOUT
        WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY,
        FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT
        THAT THE SERVICE WILL BE UNINTERRUPTED, SECURE, OR ERROR-FREE, OR THAT
        LEADS OR APPOINTMENTS WILL RESULT FROM ITS USE.
      </p>
    ),
  },
  {
    title: "12. Limitation of liability",
    body: (
      <p>
        To the maximum extent permitted by law, our total liability arising from or
        relating to the Service is limited to the fees you paid us in the twelve
        (12) months before the event giving rise to the claim. We are not liable
        for indirect, incidental, special, consequential, or punitive damages, or
        for lost profits, revenue, or goodwill, even if advised of the possibility.
        Some jurisdictions do not allow certain limitations; in that case these
        limits apply to the fullest extent permitted.
      </p>
    ),
  },
  {
    title: "13. Indemnification",
    body: (
      <p>
        You agree to indemnify and hold us harmless from claims, damages, and
        expenses (including reasonable legal fees) arising from your use of the
        Service, your messages to your customers, or your violation of these Terms
        or applicable law.
      </p>
    ),
  },
  {
    title: "14. Governing law",
    body: (
      <p>
        These Terms are governed by the laws of the State of Texas, without regard
        to its conflict-of-law rules. The parties will attempt in good faith to
        resolve any dispute informally before pursuing formal action.
      </p>
    ),
  },
  {
    title: "15. Changes to these Terms",
    body: (
      <p>
        We may update these Terms as the Service evolves. We will post the updated
        version on this page with a new effective date, and notify account holders
        of material changes by email or in the product.
      </p>
    ),
  },
];

function Terms() {
  return (
    <div className="flex min-h-dvh flex-col">
      <Nav />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-16 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          Terms &amp; Conditions
        </h1>
        <p className="mt-2 text-sm text-slate-500">Effective date: September 24, 2026</p>
        <div className="mt-6 space-y-4 text-slate-600">
          <p>
            These Terms &amp; Conditions (&quot;Terms&quot;) govern your use of the
            MissedCall AI service — software that helps service businesses respond
            to missed phone calls by text message, answer customer questions with an
            AI assistant, and schedule appointments (the &quot;Service&quot;). By
            creating an account or using the Service, you agree to these Terms. If
            you use the Service on behalf of a company, you represent that you have
            authority to bind that company.
          </p>
          <p>
            Questions: contact us at{" "}
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
          <h2 className="text-lg font-semibold text-slate-900">16. Contact</h2>
          <p className="mt-3">MissedCall AI — missedcall-ai-ab7414dd@ctomail.io</p>
        </div>
      </main>
      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-2xl px-4 py-6 text-sm text-slate-500 sm:px-6">
          <a href="/privacy" className="text-brand-600 hover:text-brand-700">
            Privacy Policy
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
