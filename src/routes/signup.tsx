import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { signupFn } from "~/lib/server/authFns";
import { getSessionFn } from "~/lib/server/sessionFns";
import { AuthCard, FormError } from "~/components/auth/AuthCard";
import { Field, TextInput } from "~/components/ui/Form";
import { Button } from "~/components/ui/Button";

export const Route = createFileRoute("/signup")({
  beforeLoad: async () => {
    const session = await getSessionFn();
    if (session) throw redirect({ to: "/dashboard" });
  },
  component: Signup,
});

function Signup() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(e.currentTarget);
    const res = await signupFn({
      data: {
        businessName: String(form.get("businessName") ?? ""),
        fullName: String(form.get("fullName") ?? ""),
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
      },
    });
    if (res.ok) {
      window.location.href = "/dashboard";
      return;
    }
    setError(res.error);
    setPending(false);
  }

  return (
    <AuthCard
      title="Create your account"
      subtitle="Set up your plumbing company in under a minute. You'll be the owner — you can invite managers and employees later."
      footer={
        <>
          Already have an account?{" "}
          <a href="/login" className="font-semibold text-brand-700 hover:text-brand-800">
            Log in
          </a>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <FormError message={error} />
        <Field label="Business name" htmlFor="businessName">
          <TextInput id="businessName" name="businessName" placeholder="Rapid Rooter Plumbing" required autoFocus />
        </Field>
        <Field label="Your name" htmlFor="fullName">
          <TextInput id="fullName" name="fullName" placeholder="Dana Whitfield" autoComplete="name" required />
        </Field>
        <Field label="Work email" htmlFor="email">
          <TextInput
            id="email"
            name="email"
            type="email"
            placeholder="you@yourplumbingco.com"
            autoComplete="email"
            required
          />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 8 characters.">
          <TextInput
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </Field>
        <Button type="submit" className="w-full" size="lg" disabled={pending}>
          {pending ? "Creating your account…" : "Create account"}
        </Button>
        <p className="text-xs leading-relaxed text-slate-500">
          By creating an account you agree to our{" "}
          <a href="/terms" className="underline hover:text-slate-700">
            Terms
          </a>{" "}
          and{" "}
          <a href="/privacy" className="underline hover:text-slate-700">
            Privacy Policy
          </a>
          .
        </p>
      </form>
    </AuthCard>
  );
}
