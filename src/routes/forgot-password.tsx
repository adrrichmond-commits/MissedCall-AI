import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { forgotPasswordFn } from "~/lib/server/authFns";
import { AuthCard, FormSuccess } from "~/components/auth/AuthCard";
import { DeliveryPendingNotice } from "~/components/auth/AuthCard";
import { Field, TextInput } from "~/components/ui/Form";
import { Button } from "~/components/ui/Button";

export const Route = createFileRoute("/forgot-password")({
  component: ForgotPassword,
});

function ForgotPassword() {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(e.currentTarget);
    const res = await forgotPasswordFn({ data: { email: String(form.get("email") ?? "") } });
    setPending(false);
    if (res.ok) {
      setDone(true);
      return;
    }
    setError(res.error ?? "Something went wrong.");
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle="Enter your work email and we'll generate a secure reset link."
      footer={
        <>
          Remembered it?{" "}
          <a href="/login" className="font-semibold text-brand-700 hover:text-brand-800">
            Back to log in
          </a>
        </>
      }
    >
      {done ? (
        <div className="space-y-4">
          <FormSuccess message="If an account exists for that email, a password reset link has been generated." />
          <DeliveryPendingNotice context="Your reset link was generated on the server, but it has not been emailed anywhere." />
          <p className="text-sm text-slate-600">
            For now, ask the team lead (or check the server logs) for your reset link, then open it
            to choose a new password. This page gives the identical response whether or not the
            email exists, so account emails are never revealed.
          </p>
          <Button variant="secondary" href="/login" className="w-full">
            Back to log in
          </Button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
              {error}
            </div>
          ) : null}
          <Field label="Work email" htmlFor="email">
            <TextInput
              id="email"
              name="email"
              type="email"
              placeholder="you@yourplumbingco.com"
              autoComplete="email"
              required
              autoFocus
            />
          </Field>
          <Button type="submit" className="w-full" size="lg" disabled={pending}>
            {pending ? "Generating reset link…" : "Send reset link"}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
