import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getMyRoleFn, getTeamCountFn } from "~/lib/server/sessionFns";
import { PagePlaceholder } from "~/components/app/AppShell";
import { Badge } from "~/components/ui/Badge";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const [role, setRole] = useState<string | null>(null);
  const [team, setTeam] = useState<number | null>(null);
  const [denied, setDenied] = useState<string | null>(null);

  useEffect(() => {
    void getMyRoleFn().then((r) => {
      if (r.ok) setRole(r.role);
    });
    void getTeamCountFn().then((r) => {
      if (r.ok) setTeam(r.count);
      else if (r.status === 403) setDenied("Your role has read-only access — team management is owner/manager only.");
    });
  }, []);

  return (
    <PagePlaceholder
      title="Settings"
      description="Business info, hours, services, and service areas — editable by owners and managers."
    >
      <div className="mt-4 space-y-2 text-sm">
        <p className="flex items-center justify-center gap-2">
          <span className="text-slate-500">Your role:</span> <Badge tone="brand">{role ?? "…"}</Badge>
        </p>
        {team !== null ? (
          <p className="text-slate-500">Team members: {team}</p>
        ) : (
          <p className="text-amber-700">{denied}</p>
        )}
      </div>
    </PagePlaceholder>
  );
}
