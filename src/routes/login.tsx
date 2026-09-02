import { createFileRoute } from "@tanstack/react-router";
import { Nav } from "~/components/marketing/Nav";
import { Button } from "~/components/ui/Button";

export const Route = createFileRoute("/login")({
  component: Login,
});

function Login() {
  return (
    <div className="flex min-h-dvh flex-col">
      <Nav />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-16 sm:px-6">
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Log in
          </h1>
          <p className="mt-3 text-sm text-slate-600">
            Sign-in is coming soon. We&apos;re building the secure login experience
            for plumbing teams.
          </p>
          <div className="mt-6">
            <Button variant="secondary" href="/">
              ← Back to home
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
