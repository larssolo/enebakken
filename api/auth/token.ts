import { AUTH_BASE, DEFAULT_MAX_AGE, readSessionCookie, setSessionCookie, upstreamHeaders } from "../_lib/authProxy.js";
import { json, err } from "../_lib/http.js";

// GET /api/auth/token — mints a fresh short-lived JWT for the current
// session cookie. The frontend calls this right before most authenticated
// requests; only the checklist sync, which polls, keeps one in memory until
// a minute before it expires. That means this is hit at least once every
// time someone opens the site, and every few minutes while they're active
// on it — which is what makes it the right place to keep them signed in:
// every successful check slides our own eb_session cookie's expiry another
// DEFAULT_MAX_AGE into the future, the same way Neon Auth's own session
// keeps sliding forward with use. Without this, the cookie's Max-Age was
// fixed at sign-in and never renewed, so anyone would be signed out exactly
// a week after they last *logged in* — even someone who opened the site
// every single day in between.
//
// A real 401 from Neon Auth (the session itself is gone or expired) is the
// only thing that counts as "signed out". Anything else failing here —
// no network, a timeout, Neon Auth returning a 5xx — says nothing about
// whether the session is still good, so it comes back as a distinct error
// instead of a false "log in again": the frontend leaves the signed-in
// state alone and just retries.
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") return err(405, "Metode ikke understøttet");
    try {
      const pair = readSessionCookie(request);
      if (!pair) return err(401, "Ikke logget ind");

      let upstream: Response;
      try {
        upstream = await fetch(`${AUTH_BASE}/token`, {
          headers: { ...upstreamHeaders(), Cookie: pair },
        });
      } catch (e) {
        return err(503, "Kunne ikke tjekke login lige nu — prøv igen");
      }
      if (upstream.status === 401) return err(401, "Ikke logget ind");
      if (!upstream.ok) return err(503, "Kunne ikke tjekke login lige nu — prøv igen");

      const body: any = await upstream.json().catch(() => null);
      if (typeof body?.token !== "string") return err(502, "Uventet svar fra login-tjenesten");

      const res = json({ token: body.token });
      setSessionCookie(res.headers, pair, DEFAULT_MAX_AGE);
      return res;
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
