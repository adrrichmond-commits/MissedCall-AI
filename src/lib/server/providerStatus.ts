/**
 * Provider-status resolution (P4 audit — "no fake claims anywhere").
 *
 * One server-side resolver that mirrors the EXACT helpers the send paths use
 * (activeEmailTransport / readSmsConfig / isLlmConfigured), so any UI status
 * line can state what is actually wired in this environment and never claim a
 * provider that is not configured. Plain serializable view — safe to return
 * through RPC to client components.
 */
import { activeEmailTransport } from "~/lib/server/email";
import { readKnockConfig } from "~/lib/server/knock";
import { isLlmConfigured } from "~/lib/server/llm";
import { readSmsConfig } from "~/lib/server/sms";
import type { ProviderStatusView } from "~/lib/settingsTypes";

export function providerStatusView(): ProviderStatusView {
  const transport = activeEmailTransport();
  const sms = readSmsConfig();
  return {
    emailTransport: transport,
    emailWorkflowKey: transport === "knock" ? (readKnockConfig()?.workflowKey ?? null) : null,
    smsConfigured: sms !== null,
    smsNumber: sms?.fromNumber ?? null,
    llmConfigured: isLlmConfigured(),
  };
}
