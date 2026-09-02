import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { resendVerificationFn, verifyEmailFn } from "~/lib/server/authFns";
import { getSessionFn } from "~/lib/server/sessionFns";
import { AuthCard, DeliveryPendingNotice, FormError, FormSuccess } from "~/components/auth/AuthCard";
import { Button } from "~/components/ui/Button";
import { Badge } from "~/components/ui/Badge";

export const Route = createFileRoute("/verify-email")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  component: VerifyEmail,
});

function VerifyEmail() {
  const search = Route.useSearch();
  const [state, setState] = useState<"working" | "ok" | "error">("working");
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!search.token) {
        setState("error");
        setError("This page needs a verification link. Open the link generated for your account.");
        return;
      }
      const res = await verifyEmailFn({ data: { token: search.token } });
      if (cancelled) return;
      if (res.ok) {
        setState("ok");
      } else {
        setState("error");
        setError(res.error ?? "Verification failed.");
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [search.token]);

  useEffect(() => {
    void getSessionFn().then((s) => {
      if (s) setSignedIn(true);
    });
  }, []);

  async function resend() {
    const res = await resendVerificationFn();
    if (res.ok) setResent(true);
    else setError(res.error ?? "Could not generate a new link.");
  }

  return (
    <AuthCard
      title="Verify your email"
      subtitle="Confirming your email keeps your account recoverable and secure."
      footer={
        signedIn ? (
          <a href="/dashboard" className="font-semibold text-brand-700 hover:text-brand-800">
            Go to dashboard
          </a>
        ) : (
          <a href="/login" className="font-semibold text-brand-700 hover:text-brand-800">
            Back to log in
          </a>
        )
      }
    >
      <div className="space-y-4">
        {state === "working" ? <p className="text-sm text-slate-600">Verifying your email…</p> : null}
        {state === "ok" ? (
          <>
            <FormSuccess message="Email verified. You're all set." />
            <Button href="/dashboard" className="w-full">
              Go to dashboard
            </Button>
          </>
        ) : null}
        {state === "error" ? (
          <>
            <FormError message={error} />
            {signedIn ? (
              resent ? (
                <FormSuccess message="A fresh verification link was generated on the server." />
              ) : (
                <Button variant="secondary" className="w-full" onClick={() => void resend()}>
                  Generate a new verification link
                </Button>
              )
            ) : (
              <Button variant="secondary" href="/login" className="w-full">
                Log in and retry from the banner
              </Button>
            )}
          </>
        ) : null}
        <DeliveryPendingNotice context="Verification links are generated server-side and logged for manual delivery." />
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Badge tone="amber">Phase 1</Badge>
          <span>Automated email sending arrives with the email provider integration.</span>
        </div>
      </div>
    </AuthCard>
  );
}
