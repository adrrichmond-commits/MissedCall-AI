/**
 * App-level rate limiting (P4-I, owner requirement 18).
 *
 * ONE config module (RATE_LIMITS below) + one in-memory fixed-window
 * counter per (bucket, identity). Deliberately simple: single-process,
 * no external dependency. The platform serves the app from one Node/Bun
 * process per environment, so in-memory is honest here; if the app ever
 * scales to multiple instances, swap the counter store for Postgres or
 * Redis behind the same `checkRateLimit` signature.
 *
 * Buckets are generous BY DESIGN so the E2E smoke suite and normal human
 * use never trip them: the limiter exists to blunt credential-stuffing
 * and webhook floods, not to police legitimate traffic. Every limit can
 * be overridden per-environment with env vars (see each entry) and the
 * whole layer can be disabled with RATE_LIMIT_DISABLED=1 (CI + tests).
 *
 * When a limit trips: auth server fns throw a typed AuthError (honest
 * 429-shaped message to the user); webhook routes answer 429 JSON so the
 * provider's own retry schedule takes over.
 */
import { log } from "./logger";
export interface RateLimitDecision {
  allowed: boolean;
  /** Requests still allowed in the current window (0 when blocked). */
  remaining: number;
  /** Seconds until the window resets (meaningful when blocked). */
  retryAfterSec: number;
}
interface BucketConfig {
  /** Max requests per window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
  /** Env var that overrides `limit` (per-environment tuning via Secrets). */
  envVar: string;
  description: string;
}
/**
 * THE config. Limits are per identity (client IP for webhooks, client IP
 * for auth server fns) per fixed window. Generous defaults documented in
 * docs/operations/environments.md; tests use RATE_LIMIT_DISABLED=1.
 */
export const RATE_LIMITS = {
  auth_login: { limit: 60, windowSec: 60, envVar: "RATE_LIMIT_LOGIN_PER_MIN", description: "loginFn attempts per client IP" },
  auth_signup: { limit: 30, windowSec: 60, envVar: "RATE_LIMIT_SIGNUP_PER_MIN", description: "signupFn attempts per client IP" },
  auth_password_reset: { limit: 20, windowSec: 60, envVar: "RATE_LIMIT_PWRESET_PER_MIN", description: "forgotPasswordFn attempts per client IP" },
  twilio_webhook: { limit: 600, windowSec: 60, envVar: "RATE_LIMIT_TWILIO_PER_MIN", description: "Twilio inbound webhook posts per source IP" },
  stripe_webhook: { limit: 600, windowSec: 60, envVar: "RATE_LIMIT_STRIPE_PER_MIN", description: "Stripe webhook posts per source IP" },
  // Cron sweeps are one caller (the external scheduler) pinging periodically;
  // 120/hour permits a per-30s scheduler while still blunting abuse.
  sms_workflow_cron: { limit: 120, windowSec: 3600, envVar: "RATE_LIMIT_SMS_CRON_PER_HOUR", description: "SMS workflow cron sweep pings per source IP" },
} as const satisfies Record<string, BucketConfig>;
export type RateLimitBucket = keyof typeof RATE_LIMITS;
interface WindowState {
  count: number;
  windowStartedAt: number;
}
const store = new Map<string, WindowState>();
/** True when the limiter is globally disabled (tests / CI / explicit ops choice). */
export function rateLimitingDisabled(): boolean {
  return process.env.RATE_LIMIT_DISABLED === "1";
}
function limitFor(bucket: RateLimitBucket): number {
  const cfg = RATE_LIMITS[bucket] as BucketConfig;
  const raw = Number(process.env[cfg.envVar]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : cfg.limit;
}
/**
 * Consume one request against `bucket` for `identity`. Returns the typed
 * decision; never throws. Fixed window: first request in a window starts it.
 */
export function checkRateLimit(bucket: RateLimitBucket, identity: string): RateLimitDecision {
  if (rateLimitingDisabled()) {
    return { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterSec: 0 };
  }
  const cfg = RATE_LIMITS[bucket] as BucketConfig;
  const limit = limitFor(bucket);
  const windowMs = cfg.windowSec * 1000;
  const now = Date.now();
  const key = bucket + ":" + identity;
  const state = store.get(key);
  if (!state || now - state.windowStartedAt >= windowMs) {
    store.set(key, { count: 1, windowStartedAt: now });
    pruneExpired(now, windowMs);
    return { allowed: true, remaining: limit - 1, retryAfterSec: 0 };
  }
  if (state.count >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((state.windowStartedAt + windowMs - now) / 1000));
    log.warn("rate limit tripped", { bucket, identity, limit, retryAfterSec });
    return { allowed: false, remaining: 0, retryAfterSec };
  }
  state.count += 1;
  return { allowed: true, remaining: limit - state.count, retryAfterSec: 0 };
}
/** Cheap periodic pruning: drop windows that can no longer matter. */
function pruneExpired(now: number, windowMs: number): void {
  if (store.size < 512) return;
  for (const [key, state] of store) {
    if (now - state.windowStartedAt >= windowMs * 2) store.delete(key);
  }
}
/** Test/CI seam — clears all counters. NEVER call from request paths. */
export function resetRateLimits(): void {
  store.clear();
}
/**
 * Best-effort client identity from proxy headers. The platform terminates
 * TLS at a proxy, so x-forwarded-for's FIRST hop is the real client;
 * fall back through x-real-ip and finally a stable placeholder so the
 * limiter still functions (one shared bucket) when headers are absent —
 * e.g. inside unit tests with no request context.
 */
export function clientIpFromHeaders(headers: Headers | Record<string, string>): string {
  const get = (name: string): string | undefined =>
    headers instanceof Headers ? (headers.get(name) ?? undefined) : headers[name];
  const xff = get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = get("x-real-ip");
  if (real) return real.trim();
  return "unknown-client";
}
