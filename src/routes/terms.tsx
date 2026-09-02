import { createFileRoute } from "@tanstack/react-router";
import { Nav } from "~/components/marketing/Nav";

export const Route = createFileRoute("/terms")({
  component: Terms,
});

function Terms() {
  return (
    <div className="flex min-h-dvh flex-col">
      <Nav />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-16 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          Terms of Service
        </h1>
        <div className="mt-6 space-y-4 text-slate-600">
          <p className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Placeholder — this page will be replaced with attorney-reviewed Terms of
            Service before launch.
          </p>
          <p>
            Welcome to MissedCall AI. By using our service, you agree to the terms
            described here once final terms are published.
          </p>
          <p>
            MissedCall AI provides tools to help plumbing businesses follow up with
            customers after missed calls. Service availability and features are
            described on our website and may change as the product develops.
          </p>
          <p>
            This placeholder does not create legal obligations and is not a complete
            set of terms. A complete Terms of Service will be provided prior to any
            paid use of the product.
          </p>
        </div>
      </main>
      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-2xl px-4 py-6 text-sm text-slate-500 sm:px-6">
          <a href="/" className="text-brand-600 hover:text-brand-700">
            ← Back to MissedCall AI
          </a>
        </div>
      </footer>
    </div>
  );
}
