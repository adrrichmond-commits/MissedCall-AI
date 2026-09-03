import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { loginFn } from "~/lib/server/authFns";
import { getSessionFn } from "~/lib/server/sessionFns";
import { AuthCard, FormError } from "~/components/auth/AuthCard";
import { Field, TextInput } from "~/components/ui/Form";
import { Button } from "~/components/ui/Button";

// Seeded sample-data account (business: Rapid Rooter Plumbing). Used when the
// login page is opened with ?demo=1 (from the public /demo walkthrough).
const DEMO_EMAIL = "dana@rapidrooter.example.com";
const DEMO_HINT =
  "Demo mode — use password demo-password-1234 to explore with sample data.";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => {
    const out: { next?: string; demo?: boolean } = {};
    if (typeof search.next === "string") out.next = search.next;
    if (search.demo === "1") out.demo = true;
    return out;
  },
  beforeLoad: async () => {
    const session = await getSessionFn();
    if (session) throw redirect({ to: "/dashboard" });
  },
  component: Login,
});

function Login() {
  const { demo } = Route.useSearch();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(e.currentTarget);
    const res = await loginFn({
      data: {
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
      },
    });
    if (res.ok) {
      window.location.href = res.redirect;
      return;
    }
    setError(res.error);
    setPending(false);
  }

  return (
    <AuthCard
      title="Log in"
      subtitle="Welcome back. Log in to see your missed-call leads and booked jobs."
      footer={
        <>
          New to MissedCall AI?{" "}
          <a href="/signup" className="font-semibold text-brand-700 hover:text-brand-800">
            Create an account
          </a>
        </>
      }
    >
      {demo && (
        <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-inset ring-amber-600/20">
          {DEMO_HINT}
        </div>
      )}
      <form onSubmit={onSubmit} className="space-y-4">
        <FormError message={error} />
        <Field label="Work email" htmlFor="email">
          <TextInput
            id="email"
            name="email"
            type="email"
            placeholder="you@yourplumbingco.com"
            defaultValue={demo ? DEMO_EMAIL : undefined}
            autoComplete="email"
            required
            autoFocus
          />
        </Field>
        <Field label="Password" htmlFor="password">
          <TextInput id="password" name="password" type="password" autoComplete="current-password" required />
        </Field>
        <div className="flex justify-end">
          <a href="/forgot-password" className="text-sm font-medium text-brand-700 hover:text-brand-800">
            Forgot password?
          </a>
        </div>
        <Button type="submit" className="w-full" size="lg" disabled={pending}>
          {pending ? "Logging in…" : "Log in"}
        </Button>
      </form>
    </AuthCard>
  );
}
