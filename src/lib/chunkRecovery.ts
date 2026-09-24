/**
 * Stale-deploy chunk-load auto-recovery (P3-H).
 *
 * The failure it fixes: a browser holds cached HTML from an older deploy. That
 * HTML references hashed /assets/* files that no longer exist after the next
 * deploy, so the page dies with "Importing a module script failed" (Safari) or
 * "Failed to fetch dynamically imported module" (Chrome) and nothing renders.
 *
 * How it works, three layers:
 *   1. CHUNK_RECOVERY_SCRIPT is rendered INLINE in <head> on every SSR page, so
 *      it runs before any bundled code. It listens for module-script load
 *      failures and dynamic-import rejections. On the first failure for a given
 *      build id it reloads the page once (the fresh HTML, which the server now
 *      sends no-store, references the new chunks and works). If it fails again
 *      for the SAME build id, the localStorage guard blocks the reload and a
 *      friendly full-page error with a manual Reload button is shown instead —
 *      no reload loops, ever.
 *   2. Router-level errors (TanStack Router catches lazy route chunk failures
 *      internally, so no window rejection fires) call
 *      window.__MCA_recoverFromChunkError() from the shared RouteError
 *      component — same guard, same friendly fallback.
 *   3. serve.ts sends Cache-Control: no-store on HTML and immutable on hashed
 *      assets, so the reload actually revalidates the document.
 *
 * The build id is baked in at build time via the __MCA_BUILD_ID__ vite define
 * (vite.config.ts): every build gets a fresh id, so "once per deploy" is
 * literal — a genuinely new deploy earns exactly one more auto-reload.
 */

declare const __MCA_BUILD_ID__: string;

/** Error signatures browsers emit for failed module/dynamic-import loads. */
const CHUNK_ERROR_RE =
  /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Failed to load module script|dynamically imported module/i;

/** True when an error looks like a stale/missing hashed-chunk failure. */
export function isChunkLoadError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return typeof err === "string" && CHUNK_ERROR_RE.test(err);
  const msg = err instanceof Error ? err.message : String((err as { message?: unknown }).message ?? err);
  return CHUNK_ERROR_RE.test(msg);
}

/**
 * The inline <head> script. Plain ES5-ish string on purpose: it must run
 * before React, before the module graph, and survive being embedded in SSR
 * HTML verbatim. The build id is interpolated server-side from the vite
 * define. Idempotent (guards on window.__MCA_CHUNK_RECOVERY__).
 */
export const CHUNK_RECOVERY_SCRIPT: string = `
(function () {
  if (window.__MCA_CHUNK_RECOVERY__) return;
  var BUILD_ID = ${JSON.stringify(__MCA_BUILD_ID__)};
  var KEY = "mca:chunkReloadGuard";
  var REASONS = ${CHUNK_ERROR_RE.toString()};
  window.__MCA_CHUNK_RECOVERY__ = { buildId: BUILD_ID };
  function guardAllowsReload() {
    try {
      if (window.localStorage.getItem(KEY) === BUILD_ID) return false;
      window.localStorage.setItem(KEY, BUILD_ID);
      return true;
    } catch (e) { return false; }
  }
  function showStaleError() {
    if (document.getElementById("mca-stale-error")) return;
    var el = document.createElement("div");
    el.id = "mca-stale-error";
    el.setAttribute("role", "alert");
    el.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:#f8fafc;font-family:system-ui,-apple-system,sans-serif;padding:24px;";
    el.innerHTML = '<div style="max-width:26rem;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px;text-align:center;box-shadow:0 8px 24px rgba(15,23,42,.08)">'
      + '<p style="margin:0;font-size:15px;font-weight:700;color:#0f172a">We\\'ve updated MissedCall AI</p>'
      + '<p style="margin:8px 0 0;font-size:14px;line-height:1.5;color:#475569">This page was opened from an older saved copy and could not load the latest version. Reload to continue — your data is safe.</p>'
      + '<button type="button" id="mca-stale-reload" style="margin-top:18px;background:#0e7490;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer">Reload MissedCall AI</button>'
      + "</div>";
    document.body ? document.body.appendChild(el) : document.documentElement.appendChild(el);
    var btn = document.getElementById("mca-stale-reload");
    if (btn) btn.addEventListener("click", function () { window.location.reload(); });
  }
  function recover(detail) {
    if (window.__MCA_RECOVERING__) return;
    window.__MCA_RECOVERING__ = true;
    try { console.error("[MissedCall AI] app files changed on the server; refreshing", detail); } catch (e) {}
    if (guardAllowsReload()) { window.location.reload(); return; }
    showStaleError();
  }
  window.__MCA_recoverFromChunkError = recover;
  function isChunkFailure(msg, target) {
    if (target && target.tagName === "SCRIPT" && typeof target.src === "string" && target.src.indexOf("/assets/") !== -1) return true;
    return typeof msg === "string" && REASONS.test(msg);
  }
  window.addEventListener("error", function (e) {
    if (isChunkFailure(e && e.message, e && e.target)) recover((e && e.message) || "script load failed");
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    var msg = r && (r.message || String(r));
    if (isChunkFailure(msg, null)) recover(msg);
  });
})();
`;

/**
 * Client-side trigger for the router-level path: if the thrown route error is
 * a chunk failure, hand it to the inline recovery (guard + reload / friendly
 * fallback). Returns true when recovery took over so the caller can skip its
 * own error UI. Safe to call during SSR (returns false, no window).
 */
export function recoverFromChunkErrorIfStale(err: unknown): boolean {
  if (typeof window === "undefined") return false;
  const recover = (window as { __MCA_recoverFromChunkError?: (d: unknown) => void }).__MCA_recoverFromChunkError;
  if (isChunkLoadError(err) && typeof recover === "function") {
    recover(err instanceof Error ? err.message : String(err));
    return true;
  }
  return false;
}
