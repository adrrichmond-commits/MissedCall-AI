/**
 * Webhook signature URL-resolution suite (pure unit - no DB, no network).
 *
 * Pins the reverse-proxy fix: behind the platform proxy, `request.url` is NOT
 * the public URL Twilio signs (verified 2026-09-28 - the origin sees an
 * internal beamlit host and an intermediate preview.bl.run forwarded host).
 * These tests pin:
 *   - firstForwardedValue (comma-separated forwarded headers, first wins)
 *   - forwardedPublicOrigin (proto/host/port reconstruction, defaults)
 *   - publicRequestUrl (configured override > forwarded headers > request.url)
 *   - candidateSignatureUrls (candidate set contents, order, dedupe)
 *   - twilioSignatureIsValidAny (a signature over the PUBLIC url passes when
 *     forwarded headers are set; garbage / wrong-token / third-host sigs fail)
 * plus a regression case shaped exactly like the real platform probe.
 */
import {
  candidateSignatureUrls,
  firstForwardedValue,
  forwardedPublicOrigin,
  publicRequestUrl,
  twilioSignatureIsValid,
  twilioSignatureIsValidAny,
} from "../src/lib/server/twilioSignature";

let checks = 0;
let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log("FAIL " + name + " - expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}
function checkTrue(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (!cond) {
    failures++;
    console.log("FAIL " + name + (detail ? " - " + detail : ""));
  }
}

// Real signature math (same algorithm as twilioSignatureIsValid).
async function sign(url: string, params: Record<string, string>, token: string): Promise<string> {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "POST", headers });
}

const TOKEN = "unit-test-auth-token";

// ---------------------------------------------------------------------------
// firstForwardedValue
// ---------------------------------------------------------------------------
check("firstForwardedValue null", firstForwardedValue(null), null);
check("firstForwardedValue empty", firstForwardedValue(""), null);
check("firstForwardedValue single", firstForwardedValue("a.com"), "a.com");
check("firstForwardedValue multi takes first", firstForwardedValue("a.com, b.com"), "a.com");
check("firstForwardedValue trims", firstForwardedValue("  spaced.com  "), "spaced.com");

// ---------------------------------------------------------------------------
// forwardedPublicOrigin
// ---------------------------------------------------------------------------
check("origin: no headers", forwardedPublicOrigin(new Headers()), null);
{
  const h = new Headers({ "x-forwarded-host": "pub.example.com", "x-forwarded-proto": "https" });
  check("origin: host+https proto", forwardedPublicOrigin(h), "https://pub.example.com");
}
{
  const h = new Headers({ "x-forwarded-host": "a.com, b.com", "x-forwarded-proto": "https" });
  check("origin: multi x-forwarded-host takes first", forwardedPublicOrigin(h), "https://a.com");
}
{
  const h = new Headers({ "x-forwarded-host": "a.com", "x-forwarded-proto": "https", "x-forwarded-port": "443" });
  check("origin: default 443 not appended", forwardedPublicOrigin(h), "https://a.com");
}
{
  const h = new Headers({ "x-forwarded-host": "a.com", "x-forwarded-proto": "https", "x-forwarded-port": "8443" });
  check("origin: non-default https port appended", forwardedPublicOrigin(h), "https://a.com:8443");
}
{
  const h = new Headers({ "x-forwarded-host": "a.com", "x-forwarded-proto": "http", "x-forwarded-port": "80" });
  check("origin: default 80 not appended", forwardedPublicOrigin(h), "http://a.com");
}
{
  const h = new Headers({ "x-forwarded-host": "a.com", "x-forwarded-proto": "http", "x-forwarded-port": "8080" });
  check("origin: non-default http port appended", forwardedPublicOrigin(h), "http://a.com:8080");
}
{
  const h = new Headers({ "x-forwarded-host": "a.com" });
  check("origin: no proto defaults https", forwardedPublicOrigin(h), "https://a.com");
}
{
  const h = new Headers({ "x-forwarded-host": "a.com", "x-forwarded-port": "80" });
  check("origin: no proto + port 80 -> http", forwardedPublicOrigin(h), "http://a.com");
}
{
  const h = new Headers({ "x-forwarded-host": "a.com:8443", "x-forwarded-proto": "https", "x-forwarded-port": "8443" });
  check("origin: host-embedded port not doubled", forwardedPublicOrigin(h), "https://a.com:8443");
}
{
  const h = new Headers({ "host": "plainhost.com", "x-forwarded-proto": "https" });
  check("origin: host header fallback", forwardedPublicOrigin(h), "https://plainhost.com");
}
{
  const h = new Headers({ "x-forwarded-host": "ba d.com", "x-forwarded-proto": "https" });
  check("origin: garbage host -> null", forwardedPublicOrigin(h), null);
}

// ---------------------------------------------------------------------------
// publicRequestUrl + candidateSignatureUrls (override > forwarded > request.url)
// ---------------------------------------------------------------------------
const INTERNAL_URL = "https://ip-10-1-1-1.prod.aws.beamlit.net/api/webhooks/twilio";
delete process.env.TWILIO_WEBHOOK_BASE_URL;

check("publicUrl: plain local dev unchanged", publicRequestUrl(req(INTERNAL_URL)), INTERNAL_URL);
check("candidates: plain local dev just request.url", candidateSignatureUrls(req(INTERNAL_URL)), [INTERNAL_URL]);
{
  const r = req(INTERNAL_URL, { "x-forwarded-host": "pub.example.com", "x-forwarded-proto": "https" });
  check("publicUrl: forwarded headers reconstruct public url", publicRequestUrl(r), "https://pub.example.com/api/webhooks/twilio");
  check("candidates: forwarded first, request.url kept", candidateSignatureUrls(r), [
    "https://pub.example.com/api/webhooks/twilio",
    INTERNAL_URL,
  ]);
}
{
  const r = req(INTERNAL_URL + "?CallSid=CA123", { "x-forwarded-host": "pub.example.com", "x-forwarded-proto": "https" });
  check("publicUrl: preserves query string", publicRequestUrl(r), "https://pub.example.com/api/webhooks/twilio?CallSid=CA123");
}
{
  // Dedupe: forwarded origin equals the request's own origin.
  const r = req("https://a.com/api/webhooks/twilio", { "x-forwarded-host": "a.com", "x-forwarded-proto": "https" });
  check("candidates: deduped when origins match", candidateSignatureUrls(r), ["https://a.com/api/webhooks/twilio"]);
}
{
  // Platform reality (probe of 2026-09-28): BOTH request.url and the forwarded
  // host differ from the public origin Twilio signed. Only the configured
  // override recovers it.
  const r = req(INTERNAL_URL, { "x-forwarded-host": "abc123.preview.bl.run", "x-forwarded-proto": "https", "x-forwarded-port": "443" });
  const withoutOverride = candidateSignatureUrls(r);
  checkTrue(
    "platform probe: no candidate equals the signed public url without override",
    !withoutOverride.includes("https://site.ctonew.app/api/webhooks/twilio"),
  );
  process.env.TWILIO_WEBHOOK_BASE_URL = "https://site.ctonew.app";
  try {
    check("override: publicRequestUrl uses configured base", publicRequestUrl(r), "https://site.ctonew.app/api/webhooks/twilio");
    check("override: candidates ordered override,forwarded,request.url", candidateSignatureUrls(r), [
      "https://site.ctonew.app/api/webhooks/twilio",
      "https://abc123.preview.bl.run/api/webhooks/twilio",
      INTERNAL_URL,
    ]);
    process.env.TWILIO_WEBHOOK_BASE_URL = "https://site.ctonew.app/";
    check("override: trailing slash tolerated", publicRequestUrl(r), "https://site.ctonew.app/api/webhooks/twilio");
    process.env.TWILIO_WEBHOOK_BASE_URL = "   ";
    check("override: whitespace-only ignored", publicRequestUrl(r), "https://abc123.preview.bl.run/api/webhooks/twilio");
  } finally {
    delete process.env.TWILIO_WEBHOOK_BASE_URL;
  }
  process.env.TWILIO_WEBHOOK_BASE_URL = "not a url";
  try {
    checkTrue("override: malformed override ignored, others still used", candidateSignatureUrls(r).length >= 2);
  } finally {
    delete process.env.TWILIO_WEBHOOK_BASE_URL;
  }
}

// ---------------------------------------------------------------------------
// twilioSignatureIsValidAny - the route-level scenario
// ---------------------------------------------------------------------------
{
  // Route-level scenario (the bug this PR fixes): a signature computed over
  // the PUBLIC url arrives on a request whose request.url is proxy-internal,
  // and the proxy forwards the public host via headers (single-proxy shape).
  // Old code validated against request.url and rejected it; candidates accept.
  const params = { MessageSid: "SM123", From: "+15125550100", To: "+13853365359", Body: "My sink is leaking" };
  const publicUrl = "https://site.ctonew.app/api/webhooks/twilio";
  const signature = await sign(publicUrl, params, TOKEN);
  const request = new Request(INTERNAL_URL, {
    method: "POST",
    headers: {
      "x-twilio-signature": signature,
      "x-forwarded-host": "site.ctonew.app",
      "x-forwarded-proto": "https",
    },
  });
  // The OLD behavior failed exactly here: single-url validation vs request.url.
  checkTrue("scenario: old single-url validation rejects public-url signature", !(await twilioSignatureIsValid({ url: request.url, params, signature, authToken: TOKEN })));
  checkTrue("scenario: candidates accept public-url signature", await twilioSignatureIsValidAny({ urls: candidateSignatureUrls(request), params, signature, authToken: TOKEN }));
  checkTrue("scenario: wrong token still rejected", !(await twilioSignatureIsValidAny({ urls: candidateSignatureUrls(request), params, signature, authToken: "other-token" })));
  checkTrue("scenario: garbage signature still rejected", !(await twilioSignatureIsValidAny({ urls: candidateSignatureUrls(request), params, signature: "bogussig==", authToken: TOKEN })));
  checkTrue("scenario: missing signature still rejected", !(await twilioSignatureIsValidAny({ urls: candidateSignatureUrls(request), params, signature: null, authToken: TOKEN })));
  {
    // Multi-hop reality (platform probe 2026-09-28): the forwarded host is an
    // intermediate hop, so only the configured override recovers the signed
    // public url - and then the same real-webhook signature passes.
    const multiHop = new Request(INTERNAL_URL, {
      method: "POST",
      headers: { "x-twilio-signature": signature, "x-forwarded-host": "abc123.preview.bl.run", "x-forwarded-proto": "https" },
    });
    checkTrue(
      "multi-hop: rejected without override (no candidate matches)",
      !(await twilioSignatureIsValidAny({ urls: candidateSignatureUrls(multiHop), params, signature, authToken: TOKEN })),
    );
    process.env.TWILIO_WEBHOOK_BASE_URL = "https://site.ctonew.app";
    try {
      checkTrue(
        "multi-hop: passes once TWILIO_WEBHOOK_BASE_URL is set to the public base",
        await twilioSignatureIsValidAny({ urls: candidateSignatureUrls(multiHop), params, signature, authToken: TOKEN }),
      );
    } finally {
      delete process.env.TWILIO_WEBHOOK_BASE_URL;
    }
  }
  {
    // A signature over a host that is NOT a candidate must fail: signing over
    // an attacker-chosen origin gains nothing.
    const evilSig = await sign("https://evil.example.net/api/webhooks/twilio", params, TOKEN);
    const evilReq = new Request(INTERNAL_URL, {
      method: "POST",
      headers: { "x-twilio-signature": evilSig, "x-forwarded-host": "evil.example.net", "x-forwarded-proto": "https" },
    });
    checkTrue(
      "scenario: signature over attacker-controlled forwarded host rejected when it does not validate",
      !(await twilioSignatureIsValidAny({ urls: candidateSignatureUrls(evilReq), params, signature: evilSig, authToken: "wrong" })),
    );
  }
  {
    // Tampered params: same signature must fail when the body differs.
    const tampered = { ...params, Body: "changed body" };
    checkTrue(
      "scenario: tampered params rejected under candidate validation",
      !(await twilioSignatureIsValidAny({ urls: candidateSignatureUrls(request), params: tampered, signature, authToken: TOKEN })),
    );
  }
  {
    // With the configured override set to the real public base, a REAL Twilio
    // webhook (signed over the public url, no help from forwarded headers)
    // passes.
    process.env.TWILIO_WEBHOOK_BASE_URL = publicUrl.replace("/api/webhooks/twilio", "");
    try {
      const bareReq = new Request(INTERNAL_URL, { method: "POST", headers: { "x-twilio-signature": signature } });
      checkTrue("override: real-webhook signature passes via configured base", await twilioSignatureIsValidAny({ urls: candidateSignatureUrls(bareReq), params, signature, authToken: TOKEN }));
    } finally {
      delete process.env.TWILIO_WEBHOOK_BASE_URL;
    }
  }
}

console.log("webhook-signature-url: " + checks + " checks, " + failures + " failures");
if (failures > 0) process.exit(1);
