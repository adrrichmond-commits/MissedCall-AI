import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { loginFn } from "~/lib/server/authFns";
import { getSessionFn } from "~/lib/server/sessionFns";
import { AuthCard, FormError } from "~/components/auth/AuthCard";
import { Field, TextInput } from "~/components/ui/Form";
import { Button } from "~/components/ui/Button";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    next: typeof search.next === "string" ? search.next : undefined,
  }),
  beforeLoad: async () => {
    const session = await getSessionFn();
    if (session) throw redirect({ to: "/dashboard" });
  },
  component: Login,
});

function Login() {
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
      <form onSubmit={onSubmit} className="space-y-4">
        <FormError message={error} />
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
