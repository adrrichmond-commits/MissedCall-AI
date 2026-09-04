#!/usr/bin/env bun
/**
 * Unit-style tests for the pure SMS pieces (Phase 2 build #4).
 * Run: bun scripts/test-sms.ts — no DB, no env, no network required.
 * Covers STOP/START/HELP parsing, phone normalization, template rendering,
 * and Twilio signature validation.
 */
import { parseSmsCommand, normalizePhone, phoneKey } from "../src/lib/smsCommands";
import { SMS_TEMPLATES, renderSmsTemplate } from "../src/lib/smsTemplates";
import { twilioSignatureIsValid } from "../src/lib/server/twilioSignature";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log("FAIL " + name + " — expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  } else {
    console.log("ok   " + name);
  }
}

// --- STOP/START/HELP parsing -------------------------------------------------
check("STOP upper", parseSmsCommand("STOP"), "stop");
check("stop lowercase", parseSmsCommand("stop"), "stop");
check("stop with punctuation", parseSmsCommand("  Stop!! "), "stop");
check("STOPALL", parseSmsCommand("STOPALL"), "stop");
check("UNSUBSCRIBE", parseSmsCommand("unsubscribe"), "stop");
check("CANCEL", parseSmsCommand("CANCEL"), "stop");
check("END", parseSmsCommand("end"), "stop");
check("QUIT", parseSmsCommand("quit"), "stop");
check("STOP with trailing words", parseSmsCommand("STOP please"), "stop");
check("START", parseSmsCommand("start"), "start");
check("UNSTOP", parseSmsCommand("UNSTOP"), "start");
check("HELP", parseSmsCommand("help"), "help");
check("INFO", parseSmsCommand("info"), "help");
// Sentences are NOT commands — only a leading keyword counts.
check("'please stop' is not a command", parseSmsCommand("please stop"), null);
check("normal message", parseSmsCommand("My kitchen sink is leaking"), null);
check("empty", parseSmsCommand(""), null);
check("null", parseSmsCommand(null), null);
check("punctuated to nothing", parseSmsCommand("!!!"), null);
// "YES" deliberately does NOT resubscribe (it's normal conversation).
check("YES is not a command", parseSmsCommand("YES"), null);

// --- Phone normalization ------------------------------------------------------
check("normalize +1 formatted", normalizePhone("+1 (512) 555-0134"), "+15125550134");
check("normalize 10-digit", normalizePhone("512-555-0134"), "+15125550134");
check("normalize 11-digit US", normalizePhone("1-512-555-0134"), "+15125550134");
check("normalize already E164", normalizePhone("+15125550134"), "+15125550134");
check("normalize garbage", normalizePhone("call me"), null);
check("normalize empty", normalizePhone(""), null);
check("phoneKey formatted", phoneKey("+1 (512) 555-0134"), "5125550134");
check("phoneKey E164", phoneKey("+15125550134"), "5125550134");

// --- Templates ----------------------------------------------------------------
check("template render", renderSmsTemplate(SMS_TEMPLATES.textBack, "Rapid Rooter Plumbing").includes("Rapid Rooter Plumbing"), true);
check("template keeps STOP instruction", renderSmsTemplate(SMS_TEMPLATES.textBack, "Acme").includes("Reply STOP"), true);
check("template empty-name fallback", !renderSmsTemplate(SMS_TEMPLATES.help, "").includes("{businessName}"), true);
check("stop confirm mentions opt-out", renderSmsTemplate(SMS_TEMPLATES.stopConfirm, "Acme").includes("opted out"), true);
check("start confirm mentions resubscribe", renderSmsTemplate(SMS_TEMPLATES.startConfirm, "Acme").includes("resubscribed"), true);

// --- Twilio signature validation ---------------------------------------------
{
  const url = "https://example.com/api/webhooks/twilio";
  const params: Record<string, string> = { From: "+15125550134", To: "+15125550100", Body: "STOP", MessageSid: "SM123" };
  const authToken = "test-auth-token";
  const data = url + Object.keys(params).sort().map((k) => k + params[k]!).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const good = btoa(String.fromCharCode(...new Uint8Array(mac)));
  check("valid signature accepted", await twilioSignatureIsValid({ url, params, signature: good, authToken }), true);
  check("tampered signature rejected", await twilioSignatureIsValid({ url, params, signature: good.slice(0, -2) + "xx", authToken }), false);
  check("missing signature rejected", await twilioSignatureIsValid({ url, params, signature: null, authToken }), false);
  check("wrong token rejected", await twilioSignatureIsValid({ url, params, signature: good, authToken: "other" }), false);
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : "\n" + failures + " TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
