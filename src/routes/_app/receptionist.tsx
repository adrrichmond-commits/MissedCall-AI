import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  getReceptionistConfigFn,
  saveReceptionistConfigFn,
  simulateReceptionistTurnFn,
  type SimState,
} from "~/lib/server/receptionistFns";
import { PageHeader, PageLoading, ErrorState } from "~/components/app/pageStates";
import { Badge } from "~/components/ui/Badge";
import { Field, TextInput } from "~/components/ui/Form";
import { Button } from "~/components/ui/Button";
import {
  NEUTRAL_CONFIRM_PROMPT,
  RECEPTIONIST_LIMITS,
  resolveReceptionistGreeting,
  validateReceptionistInput,
  type ReceptionistConfig,
  type ReceptionistFaq,
} from "~/lib/voice/receptionistConfig";
import { AI_TONE_OPTIONS, type AiTone } from "~/lib/aiTone";
import { PROMPTS } from "~/lib/voice/callFlow";
import type { ReceptionistStudioView } from "~/lib/server/receptionistReads";

/** Shared styling for raw <textarea> elements (matches settings.tsx inputCls). */
const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-slate-50 disabled:text-slate-400";

export const Route = createFileRoute("/_app/receptionist")({
  loader: async (): Promise<ReceptionistStudioView> => {
    // SSR: plain server read (createServerFn in a loader compiles to an SSR
    // RPC self-call through the hosting proxy that intermittently fails —
    // sessionReads/adminReads postmortem). Browser: the RPC wrapper.
    if (import.meta.env.SSR) {
      const { receptionistStudioView } = await import("~/lib/server/receptionistReads");
      const view = await receptionistStudioView();
      if (!view) throw new Error("Not signed in.");
      return view;
    }
    const res = await getReceptionistConfigFn();
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  pendingComponent: PageLoading,
  errorComponent: () => (
    <ErrorState
      message="The receptionist studio couldn't load. Check your connection and retry."
      onRetry={() => window.location.reload()}
    />
  ),
  component: ReceptionistStudioPage,
});

// ---------------------------------------------------------------------------
// Small shared bits (same shapes as settings.tsx)
// ---------------------------------------------------------------------------
type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; message: string }
  | { kind: "error"; message: string };

function SaveFeedback({ state }: { state: SaveState }) {
  if (state.kind === "saved") {
    return <p className="text-sm font-medium text-green-700" role="status">✓ {state.message}</p>;
  }
  if (state.kind === "error") {
    return <p className="text-sm font-medium text-red-700" role="alert">{state.message}</p>;
  }
  if (state.kind === "saving") {
    return <p className="text-sm text-slate-500" role="status">Saving…</p>;
  }
  return null;
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

let faqKeySeq = 0;
function newFaqId(): string {
  faqKeySeq += 1;
  return "faq_" + Date.now().toString(36) + "_" + faqKeySeq.toString(36);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
function ReceptionistStudioPage() {
  const view = Route.useLoaderData();
  const [draft, setDraft] = useState<ReceptionistConfig>(view.config);
  const [tone, setTone] = useState<AiTone>(view.aiTone);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const canEdit = view.canEdit;

  const patch = (p: Partial<ReceptionistConfig>) => setDraft((d) => ({ ...d, ...p }));

  const onSave = async () => {
    if (!canEdit) return;
    const validated = validateReceptionistInput(draft);
    if (!validated.ok) {
      setSave({ kind: "error", message: validated.issues.map((i) => i.message).join(" ") });
      return;
    }
    setSave({ kind: "saving" });
    const res = await saveReceptionistConfigFn({ data: { ...draft, aiTone: tone } });
    if (res.ok) {
      setDraft(res.data.config);
      setTone(res.data.aiTone as AiTone);
      setSave({ kind: "saved", message: res.data.message });
    } else {
      setSave({ kind: "error", message: res.error });
    }
  };

  return (
    <div>
      <PageHeader
        title="Receptionist studio"
        description="Shape how your AI receptionist answers the phone — editable by owners and managers."
        actions={canEdit ? undefined : <Badge tone="slate">Read-only access</Badge>}
      />
      {!canEdit ? (
        <p className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
          Your role ({view.role}) has read-only access. Ask an owner or manager to make changes.
        </p>
      ) : null}
      <p className="mb-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-700 ring-1 ring-inset ring-slate-200">
        Every word below is what callers actually hear: the greeting opens each call, the FAQ
        answers questions mid-call, and the policies ride along on captured leads so your team sees
        them. {view.savedAt ? `Last saved ${new Date(view.savedAt).toLocaleString()}.` : "Not customized yet — the defaults are live."}
      </p>
      <div className="space-y-6">
        <IdentitySection draft={draft} businessName={view.businessName} patch={patch} canEdit={canEdit} />
        <ToneSection tone={tone} setTone={setTone} canEdit={canEdit} aiToneSaved={view.aiToneSaved} />
        <PoliciesSection draft={draft} patch={patch} canEdit={canEdit} />
        <TransferSection draft={draft} patch={patch} canEdit={canEdit} businessPhone={view.businessPhone} />
        <FaqSection draft={draft} patch={patch} canEdit={canEdit} setDraft={setDraft} />
        <InstructionsSection draft={draft} patch={patch} canEdit={canEdit} />
        {canEdit ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <SaveFeedback state={save} />
            <Button type="button" onClick={onSave} disabled={save.kind === "saving"}>
              {save.kind === "saving" ? "Saving…" : "Save receptionist"}
            </Button>
          </div>
        ) : null}
        <TestCallSection draft={draft} businessName={view.businessName} smsProviderConfigured={view.smsProviderConfigured} llmConfigured={view.llmConfigured} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Identity — name + greeting with live preview
// ---------------------------------------------------------------------------
function IdentitySection({
  draft,
  businessName,
  patch,
  canEdit,
}: {
  draft: ReceptionistConfig;
  businessName: string;
  patch: (p: Partial<ReceptionistConfig>) => void;
  canEdit: boolean;
}) {
  const preview = resolveReceptionistGreeting(draft, businessName || null);
  return (
    <SectionCard
      title="Who answers"
      description="The receptionist's name and the first words a caller hears."
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Receptionist name" htmlFor="rc-name" hint="Used in the default greeting. Optional.">
            <TextInput
              id="rc-name"
              value={draft.name}
              placeholder="e.g. Sarah"
              disabled={!canEdit}
              onChange={(v) => patch({ name: v })}
            />
          </Field>
        </div>
        <Field
          label="Custom greeting"
          htmlFor="rc-greeting"
          hint={`Spoken word-for-word at the start of every call. Leave blank to use the default built from the name. Up to ${RECEPTIONIST_LIMITS.greeting} characters.`}
        >
          <textarea
            id="rc-greeting"
            className={inputCls + " min-h-20"}
            rows={3}
            maxLength={RECEPTIONIST_LIMITS.greeting}
            value={draft.greeting}
            placeholder="e.g. Thanks for calling Sunbelt Plumbing, this is Sarah. How can I help you today?"
            disabled={!canEdit}
            onChange={(e) => patch({ greeting: e.target.value })}
          />
        </Field>
        <div className="rounded-xl bg-brand-50 px-4 py-3 ring-1 ring-inset ring-brand-100">
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">What callers hear first</p>
          <p className="mt-1 text-sm text-slate-900">“{preview}”</p>
        </div>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 1b. AI tone (P5-3) — how the TEXTING assistant sounds; saved with the main
// save button. The voice flow's spoken lines are scripted, so tone steers the
// SMS AI (the settings page exposes the same control).
// ---------------------------------------------------------------------------
function ToneSection({
  tone,
  setTone,
  canEdit,
  aiToneSaved,
}: {
  tone: AiTone;
  setTone: (t: AiTone) => void;
  canEdit: boolean;
  aiToneSaved: boolean;
}) {
  return (
    <SectionCard
      title="AI tone"
      description="How your AI sounds when it texts customers about missed calls. Saves with the “Save receptionist” button below and applies to the very next AI reply."
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {AI_TONE_OPTIONS.map((option) => {
          const selected = tone === option.value;
          return (
            <label
              key={option.value}
              className={
                "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition " +
                (selected
                  ? "border-brand-500 bg-brand-50 ring-1 ring-inset ring-brand-200"
                  : "border-slate-200 bg-white hover:bg-slate-50")
              }
            >
              <input
                type="radio"
                name="studio-ai-tone"
                className="mt-0.5 h-4 w-4 border-slate-300 text-brand-600 focus:ring-brand-500"
                checked={selected}
                disabled={!canEdit}
                onChange={() => setTone(option.value)}
              />
              <span>
                <span className="block text-sm font-medium text-slate-900">{option.label}</span>
                <span className="block text-xs text-slate-500">{option.description}</span>
              </span>
            </label>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Tone changes phrasing only — the safety rules (emergency scripts, no prices, honest routing)
        always win. {!aiToneSaved ? "You have not customized it yet — Professional is in effect." : ""}
      </p>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 2. Policies — emergency handling, never-promise, escalation notes
// ---------------------------------------------------------------------------
function PoliciesSection({
  draft,
  patch,
  canEdit,
}: {
  draft: ReceptionistConfig;
  patch: (p: Partial<ReceptionistConfig>) => void;
  canEdit: boolean;
}) {
  return (
    <SectionCard
      title="Policies"
      description="Rules the receptionist and your team follow on every call."
    >
      <div className="space-y-4">
        <Field
          label="Emergency handling"
          htmlFor="rc-emg"
          hint={`Appended to emergency lead notes and the emergency notification so whoever responds sees your protocol. Up to ${RECEPTIONIST_LIMITS.policy} characters.`}
        >
          <textarea
            id="rc-emg"
            className={inputCls + " min-h-20"}
            rows={3}
            maxLength={RECEPTIONIST_LIMITS.policy}
            value={draft.emergencyHandling}
            placeholder="e.g. Ask for the address first. If gas is suspected, tell them to leave the building before anything else."
            disabled={!canEdit}
            onChange={(e) => patch({ emergencyHandling: e.target.value })}
          />
        </Field>
        <Field
          label="Never promise"
          htmlFor="rc-never"
          hint={`Commitments the AI must not make (pricing, arrival times, outcomes). While this is set, the AI also skips its default “someone will reach out shortly” line and uses neutral wording instead. Up to ${RECEPTIONIST_LIMITS.policy} characters.`}
        >
          <textarea
            id="rc-never"
            className={inputCls + " min-h-20"}
            rows={3}
            maxLength={RECEPTIONIST_LIMITS.policy}
            value={draft.neverPromise}
            placeholder="e.g. Never quote prices, never promise an arrival time, never say the job is booked."
            disabled={!canEdit}
            onChange={(e) => patch({ neverPromise: e.target.value })}
          />
        </Field>
        {draft.neverPromise.trim() ? (
          <div className="rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-inset ring-slate-200">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Confirm prompt in effect (replaces the default)
            </p>
            <p className="mt-1 text-sm text-slate-900">“{NEUTRAL_CONFIRM_PROMPT}”</p>
          </div>
        ) : null}
        <Field
          label="Escalation rules"
          htmlFor="rc-esc"
          hint={`When to get a human involved — appended to captured lead notes and emergency notifications. Up to ${RECEPTIONIST_LIMITS.policy} characters.`}
        >
          <textarea
            id="rc-esc"
            className={inputCls + " min-h-20"}
            rows={3}
            maxLength={RECEPTIONIST_LIMITS.policy}
            value={draft.escalationNotes}
            placeholder="e.g. Any commercial job or repeat customer goes straight to Mike."
            disabled={!canEdit}
            onChange={(e) => patch({ escalationNotes: e.target.value })}
          />
        </Field>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 3. Transfer target
// ---------------------------------------------------------------------------
function TransferSection({
  draft,
  patch,
  canEdit,
  businessPhone,
}: {
  draft: ReceptionistConfig;
  patch: (p: Partial<ReceptionistConfig>) => void;
  canEdit: boolean;
  businessPhone: string | null;
}) {
  return (
    <SectionCard
      title="Transfer number"
      description="Where the AI dials when a caller asks for a person, when it's an emergency, or after hours."
    >
      <Field
        label="Transfer to"
        htmlFor="rc-transfer"
        hint="10–11 digit phone number. Leave blank to fall back to your main line on file."
      >
        <TextInput
          id="rc-transfer"
          value={draft.transferNumber}
          placeholder={businessPhone ?? "e.g. +1 512 555 0134"}
          disabled={!canEdit}
          onChange={(v) => patch({ transferNumber: v })}
        />
      </Field>
      <p className="mt-3 text-sm text-slate-600">
        Falls back to your main line ({businessPhone || "not set yet — add one in Settings"}) and
        then to voicemail. A caller is never transferred to an unverifiable number.
      </p>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 4. FAQ editor — add / remove / reorder
// ---------------------------------------------------------------------------
function FaqSection({
  draft,
  patch,
  canEdit,
  setDraft,
}: {
  draft: ReceptionistConfig;
  patch: (p: Partial<ReceptionistConfig>) => void;
  canEdit: boolean;
  setDraft: (d: ReceptionistConfig) => void;
}) {
  const faqs = draft.faqs;
  const update = (i: number, p: Partial<ReceptionistFaq>) => {
    const next = faqs.map((f, j) => (j === i ? { ...f, ...p } : f));
    patch({ faqs: next });
  };
  const remove = (i: number) => patch({ faqs: faqs.filter((_, j) => j !== i) });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= faqs.length) return;
    const next = [...faqs];
    [next[i], next[j]] = [next[j], next[i]];
    setDraft({ ...draft, faqs: next });
  };
  const add = () => {
    if (faqs.length >= RECEPTIONIST_LIMITS.maxFaqs) return;
    patch({ faqs: [...faqs, { id: newFaqId(), question: "", answer: "" }] });
  };

  return (
    <SectionCard
      title="FAQ"
      description={`Answers the receptionist may give mid-call (up to ${RECEPTIONIST_LIMITS.maxFaqs}). It speaks the answer, then resumes the conversation. Questions it can't answer honestly are never improvised.`}
    >
      {faqs.length === 0 ? (
        <p className="text-sm text-slate-500">No FAQ entries yet. Add the questions callers ask most.</p>
      ) : (
        <ul className="space-y-3">
          {faqs.map((f, i) => (
            <li key={f.id} className="rounded-xl border border-slate-200 p-4">
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">FAQ {i + 1}</span>
                {canEdit ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Move FAQ ${i + 1} up`}
                      disabled={i === 0}
                      className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                      onClick={() => move(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move FAQ ${i + 1} down`}
                      disabled={i === faqs.length - 1}
                      className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-sm font-medium text-red-700 hover:bg-red-50"
                      onClick={() => remove(i)}
                    >
                      Remove
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="mt-2 space-y-3">
                <Field label="Question" htmlFor={`rc-faq-q-${f.id}`}>
                  <TextInput
                    id={`rc-faq-q-${f.id}`}
                    value={f.question}
                    placeholder="e.g. Do you install water heaters?"
                    disabled={!canEdit}
                    onChange={(v) => update(i, { question: v })}
                  />
                </Field>
                <Field label="Answer" htmlFor={`rc-faq-a-${f.id}`} hint={`Spoken verbatim, then the call resumes. Up to ${RECEPTIONIST_LIMITS.faqAnswer} characters.`}>
                  <textarea
                    id={`rc-faq-a-${f.id}`}
                    className={inputCls + " min-h-16"}
                    rows={2}
                    maxLength={RECEPTIONIST_LIMITS.faqAnswer}
                    value={f.answer}
                    placeholder="e.g. Yes, we install tank and tankless water heaters. I can have someone call you with details."
                    disabled={!canEdit}
                    onChange={(e) => update(i, { answer: e.target.value })}
                  />
                </Field>
              </div>
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="mt-4">
          <Button type="button" variant="secondary" onClick={add} disabled={faqs.length >= RECEPTIONIST_LIMITS.maxFaqs}>
            + Add FAQ
          </Button>
        </div>
      ) : null}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 5. Company instructions
// ---------------------------------------------------------------------------
function InstructionsSection({
  draft,
  patch,
  canEdit,
}: {
  draft: ReceptionistConfig;
  patch: (p: Partial<ReceptionistConfig>) => void;
  canEdit: boolean;
}) {
  return (
    <SectionCard
      title="Company instructions"
      description={`Steers the post-call AI summary your team reads (up to ${RECEPTIONIST_LIMITS.instructions} characters). It never weakens the honesty guardrails: no invented details, no prices, no promises.`}
    >
      <Field label="Instructions" htmlFor="rc-instructions" htmlFor-optional>
        <textarea
          id="rc-instructions"
          className={inputCls + " min-h-20"}
          rows={3}
          maxLength={RECEPTIONIST_LIMITS.instructions}
          value={draft.instructions}
          placeholder="e.g. Always note if the caller mentioned our name or a referral. Flag renters differently — we need landlord approval."
          disabled={!canEdit}
          onChange={(e) => patch({ instructions: e.target.value })}
        />
      </Field>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 6. Test call preview — SIMULATED, zero side effects
// ---------------------------------------------------------------------------
interface SimLine {
  role: "ai" | "caller" | "note";
  text: string;
}

function TestCallSection({
  draft,
  businessName,
  smsProviderConfigured,
  llmConfigured,
}: {
  draft: ReceptionistConfig;
  businessName: string;
  smsProviderConfigured: boolean;
  llmConfigured: boolean;
}) {
  const [lines, setLines] = useState<SimLine[]>([]);
  const [state, setState] = useState<SimState | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const greeting = resolveReceptionistGreeting(draft, businessName || null);

  const start = () => {
    setLines([{ role: "ai", text: greeting }]);
    setState(null);
    setErr(null);
  };

  const send = async (utterance: string) => {
    if (busy || !utterance.trim()) return;
    const current = lines.length > 0 ? state : null;
    if (lines.length === 0) start();
    setBusy(true);
    setErr(null);
    const nextLines: SimLine[] = [...(lines.length > 0 ? lines : [{ role: "ai" as const, text: greeting }]), { role: "caller", text: utterance }];
    setLines(nextLines);
    const res = await simulateReceptionistTurnFn({ data: { config: draft, state: current, utterance } });
    if (res.ok) {
      const d = res.data;
      const appended: SimLine[] = d.lines.map((text) => ({ role: "ai" as const, text }));
      if (d.emergency) {
        appended.push({ role: "note", text: "Emergency — the safety script is spoken verbatim from the knowledge base, then a transfer is offered." });
      }
      if (d.leadWouldCapture) {
        appended.push({ role: "note", text: "A live call would create a lead right here, with your policies attached to the notes." });
      }
      if (d.actionKind === "transfer") {
        appended.push(
          d.transferTarget
            ? { role: "note", text: `A live call would transfer to ${d.transferTarget}.` }
            : { role: "note", text: "No verified transfer number — a live call would offer voicemail instead of a fake transfer." },
        );
      }
      if (d.actionKind === "voicemail") {
        appended.push({ role: "note", text: "A live call would record a voicemail here." });
      }
      if (d.actionKind === "goodbye") {
        appended.push({ role: "note", text: "The call ends here." });
      }
      setLines([...nextLines, ...appended]);
      setState(d.state);
    } else {
      setErr(res.error);
    }
    setBusy(false);
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
  };

  const quick: string[] = [
    ...draft.faqs.filter((f) => f.question.trim()).slice(0, 3).map((f) => f.question),
    "My basement is flooding",
    "5125550123",
    "yes",
  ];

  const ended = state != null && (state.stage === "wrapup" || lines.some((l) => l.role === "note" && (l.text.startsWith("A live call would create") || l.text.startsWith("The call ends") || l.text.startsWith("A live call would record") || l.text.startsWith("A live call would transfer"))));

  return (
    <SectionCard
      title="Test call"
      description="Try your receptionist before a customer does. This runs the exact same conversation engine a live call uses."
    >
      <div className="rounded-xl bg-amber-50 px-4 py-3 ring-1 ring-inset ring-amber-200">
        <p className="text-sm font-semibold text-amber-900">Simulated — no real calls, no real texts.</p>
        <p className="mt-0.5 text-sm text-amber-800">
          {smsProviderConfigured
            ? "Your SMS provider is configured, but real customer messaging is gated on A2P campaign approval. This preview never places a call or sends a message."
            : "Your SMS provider is not connected yet. This preview never places a call or sends a message."}
          {!llmConfigured &&
            " AI language understanding is not configured — this preview runs on the rules tier only."}
        </p>
      </div>

      <div ref={scrollRef} className="mt-4 max-h-96 space-y-3 overflow-y-auto rounded-xl bg-slate-50 p-4" aria-live="polite">
        {lines.length === 0 ? (
          <p className="text-sm text-slate-500">Press “Start test call” to hear your greeting, then type what a caller might say.</p>
        ) : (
          lines.map((l, i) =>
            l.role === "note" ? (
              <p key={i} className="rounded-lg bg-slate-200/70 px-3 py-2 text-xs font-medium text-slate-600">{l.text}</p>
            ) : (
              <div key={i} className={l.role === "ai" ? "flex justify-start" : "flex justify-end"}>
                <div
                  className={
                    "max-w-[85%] rounded-2xl px-4 py-2.5 " +
                    (l.role === "ai" ? "rounded-bl-sm bg-white ring-1 ring-inset ring-slate-200" : "rounded-br-sm bg-brand-600")
                  }
                >
                  <p className={"text-sm " + (l.role === "ai" ? "text-slate-900" : "text-white")}>{l.text}</p>
                </div>
              </div>
            ),
          )
        )}
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          {quick.map((q) => (
            <button
              key={q}
              type="button"
              disabled={busy}
              className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              onClick={() => void send(q)}
            >
              {q}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const u = input;
            setInput("");
            void send(u);
          }}
        >
          <input
            className={inputCls}
            value={input}
            placeholder={lines.length === 0 ? "Start the call, then speak as a caller…" : "What the caller says…"}
            maxLength={500}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
          />
          <Button type="submit" disabled={busy || input.trim().length === 0}>
            {busy ? "…" : "Send"}
          </Button>
        </form>
        {err ? <p className="text-sm font-medium text-red-700" role="alert">{err}</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setLines([]);
              setState(null);
              setErr(null);
            }}
          >
            Reset call
          </Button>
          <p className="text-xs text-slate-500">
            Engine prompts, verbatim: “{PROMPTS.need}” · “{PROMPTS.callbackNumber}”
            {ended ? " — this simulated call has reached its outcome." : ""}
          </p>
        </div>
      </div>
    </SectionCard>
  );
}
