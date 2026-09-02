import { useState } from "react";
import { resendVerificationFn } from "~/lib/server/authFns";

/**
 * Demo-friendly email-verification gate: unverified users are NOT blocked;
 * they see this banner with an honest note that delivery is pending the
 * email provider setup.
 */
export function VerifyEmailBanner() {
  const [state, setState] = useState<"idle" | "resent">("idle");
  return (
    <div className="mx-4 mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 sm:mx-6 lg:mx-8 lg:mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-amber-900">
          <strong className="font-semibold">Verify your email.</strong>{" "}
          {state === "resent"
            ? "A fresh verification link was generated on the server — delivery is pending our email provider setup."
            : "Confirm your address to keep your account recoverable. Delivery is pending our email provider setup, so no email is sent yet."}
        </p>
        <button
          type="button"
          onClick={() => void resendVerificationFn().then(() => setState("resent"))}
          className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100"
        >
          {state === "resent" ? "Link generated ✓" : "Generate new link"}
        </button>
      </div>
    </div>
  );
}
