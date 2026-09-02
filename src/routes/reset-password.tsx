import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { resetPasswordFn } from "~/lib/server/authFns";
import { AuthCard, FormError, FormSuccess } from "~/components/auth/AuthCard";
import { Field, TextInput } from "~/components/ui/Form";
import { Button } from "~/components/ui/Button";

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  component: ResetPassword,
});

function ResetPassword() {
  const search = Route.useSearch();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  const tokenMissing = !search.token;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(e.currentTarget);
    const res = await resetPasswordFn({
      data: {
        token: search.token,
        password: String(form.get("password") ?? ""),
      },
    });
    setPending(false);
    if (res.ok) {
      setDone(true);
      return;
    }
    setError(res.error ?? "Something went wrong.");
  }

  return (
    <AuthCard
      title="Choose a new password"
      subtitle="Pick something at least 8 characters long. Resetting signs you out everywhere."
      footer={
        <a href="/login" className="font-semibold text-brand-700 hover:text-brand-800">
          Back to log in
        </a>
      }
    >
      {tokenMissing ? (
        <div className="space-y-4">
          <FormError message="This page needs a valid reset link. Open the link from your reset email, or request a new one." />
          <Button variant="secondary" href="/forgot-password" className="w-full">
            Request a new link
          </Button>
        </div>
      ) : done ? (
        <div className="space-y-4">
          <FormSuccess message="Password updated. All previous sessions were signed out." />
          <Button href="/login" className="w-full">
            Log in with your new password
          </Button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <FormError message={error} />
          <input type="hidden" name="token" value={search.token} />
          <Field label="New password" htmlFor="password" hint="At least 8 characters.">
            <TextInput
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              autoFocus
            />
          </Field>
          <Button type="submit" className="w-full" size="lg" disabled={pending}>
            {pending ? "Updating password…" : "Update password"}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
