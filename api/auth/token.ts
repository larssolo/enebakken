import { AUTH_BASE, readSessionCookie, upstreamHeaders } from "../_lib/authProxy.js";
import { json, err } from "../_lib/http.js";

// GET /api/auth/token — mints a fresh short-lived JWT for the current
// session cookie. The frontend calls this right before most authenticated
// requests; only the checklist sync, which polls, keeps one in memory until
// a minute before it expires.
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") return err(405, "Metode ikke understøttet");
    try {
      const pair = readSessionCookie(request);
      if (!pair) return err(401, "Ikke logget ind");

      const upstream = await fetch(`${AUTH_BASE}/token`, {
        headers: { ...upstreamHeaders(), Cookie: pair },
      });
      if (!upstream.ok) return err(401, "Ikke logget ind");

      const body: any = await upstream.json().catch(() => null);
      if (typeof body?.token !== "string") return err(502, "Uventet svar fra login-tjenesten");

      return json({ token: body.token });
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
