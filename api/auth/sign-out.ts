import { AUTH_BASE, clearSessionCookie, readSessionCookie, upstreamHeaders } from "../_lib/authProxy.js";
import { json, err } from "../_lib/http.js";

// POST /api/auth/sign-out — best-effort upstream sign-out, then always
// clears our own cookie regardless of the upstream result (the browser
// should never end up "stuck" signed in locally).
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return err(405, "Metode ikke understøttet");
    try {
      const pair = readSessionCookie(request);
      if (pair) {
        await fetch(`${AUTH_BASE}/sign-out`, {
          method: "POST",
          headers: { ...upstreamHeaders(), Cookie: pair },
          body: "{}",
        }).catch(() => null);
      }
      const res = json({ ok: true });
      clearSessionCookie(res.headers);
      return res;
    } catch (e) {
      console.error(e);
      const res = json({ ok: true });
      clearSessionCookie(res.headers);
      return res;
    }
  },
};
