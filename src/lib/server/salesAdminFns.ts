/**
 * salesAdminFns.ts — browser-initiated RPC wrappers for the admin Sales tab.
 * Every fn delegates to the gated plain functions in ./salesAdmin (one
 * source of truth; the route loader's SSR branch imports those directly —
 * the PR #27 pattern that keeps SSR off HTTP self-calls).
 */
import { createServerFn } from "@tanstack/react-start";
import {
  salesAddRep,
  salesAttribute,
  salesRecordPayout,
  salesSetRepActive,
  salesTabPage,
  salesUnattribute,
  salesUpdateRep,
  type SalesRepPayload,
} from "./salesAdmin";

export type { SalesTabView, SalesTabAccountView, SalesTabRepView } from "./salesAdmin";

export const salesTabFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<ReturnType<typeof salesTabPage>> => {
    return salesTabPage();
  },
);

export const salesAddRepFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as SalesRepPayload)
  .handler(async ({ data }): Promise<ReturnType<typeof salesAddRep>> => {
    return salesAddRep(data ?? {});
  });

export const salesUpdateRepFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as SalesRepPayload & { repId?: string })
  .handler(async ({ data }): Promise<ReturnType<typeof salesUpdateRep>> => {
    return salesUpdateRep(typeof data?.repId === "string" ? data.repId : "", data ?? {});
  });

export const salesSetRepActiveFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { repId?: string; active?: boolean })
  .handler(async ({ data }): Promise<ReturnType<typeof salesSetRepActive>> => {
    return salesSetRepActive(typeof data?.repId === "string" ? data.repId : "", data?.active === true);
  });

export const salesAttributeFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { businessId?: string; repId?: string })
  .handler(async ({ data }): Promise<ReturnType<typeof salesAttribute>> => {
    return salesAttribute(
      typeof data?.businessId === "string" ? data.businessId : "",
      typeof data?.repId === "string" ? data.repId : "",
    );
  });

export const salesUnattributeFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { businessId?: string })
  .handler(async ({ data }): Promise<ReturnType<typeof salesUnattribute>> => {
    return salesUnattribute(typeof data?.businessId === "string" ? data.businessId : "");
  });

export const salesRecordPayoutFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { repId?: string; amountCents?: unknown; note?: unknown })
  .handler(async ({ data }): Promise<ReturnType<typeof salesRecordPayout>> => {
    return salesRecordPayout(typeof data?.repId === "string" ? data.repId : "", data ?? {});
  });
