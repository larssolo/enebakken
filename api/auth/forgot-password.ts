import { AUTH_BASE, SITE_ORIGIN, upstreamHeaders } from "../_lib/authProxy.js";
import { json, err } from "../_lib/http.js";

// POST /api/auth/forgot-password — asks Neon Auth to email a reset link.
// redirectTo is fixed here, never taken from the client, so this route
// can't mint links that land anywhere but this site. Neon Auth answers
// identically whether or not the account exists, and so do we.
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return err(405, "Metode ikke understøttet");
    try {
      const body: any = await request.json().catch(() => null);
      const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!email || !email.includes("@")) return err(400, "Ugyldig e-mail");

      const upstream = await fetch(`${AUTH_BASE}/request-password-reset`, {
        method: "POST",
        headers: upstreamHeaders(),
        body: JSON.stringify({ email, redirectTo: `${SITE_ORIGIN}/?reset=1` }),
      });
      if (upstream.status === 429) return err(429, "For mange forsøg — vent et par minutter og prøv igen");
      if (!upstream.ok) return err(502, "Kunne ikke sende mailen lige nu — prøv igen senere");

      return json({ ok: true });
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
