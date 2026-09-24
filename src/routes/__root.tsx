import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { NotFoundState, RouteError } from "~/components/app/pageStates";
import { CHUNK_RECOVERY_SCRIPT } from "~/lib/chunkRecovery";
import appCss from "~/styles/app.css?url";
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "MissedCall AI | Turn Missed Calls Into Booked Plumbing Jobs" },
      {
        name: "description",
        content:
          "MissedCall AI helps plumbing companies turn missed phone calls into booked jobs. When you can't answer, it follows up with the customer, qualifies the opportunity, and helps schedule the work.",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
    // P3-H stale-deploy recovery: runs inline BEFORE any bundled module, so it
    // catches pre-mount script-tag failures too (the exact owner-reported
    // "Importing a module script failed" dead page after a deploy). See
    // src/lib/chunkRecovery.ts for the guard/loop-prevention design.
    scripts: [{ tag: "script", children: CHUNK_RECOVERY_SCRIPT }],
  }),
  notFoundComponent: NotFoundState,
  errorComponent: RouteError,
  component: RootComponent,
});
function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}
function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="font-sans">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
