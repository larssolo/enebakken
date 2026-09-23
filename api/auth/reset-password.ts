import { AUTH_BASE, upstreamHeaders } from "../_lib/authProxy.js";
import { json, err } from "../_lib/http.js";

// POST /api/auth/reset-password — completes a reset with the token from
// the emailed link. Neon Auth makes each token single-use.
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return err(405, "Metode ikke understøttet");
    try {
      const body: any = await request.json().catch(() => null);
      const token = typeof body?.token === "string" ? body.token : "";
      const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
      if (!token) return err(400, "Linket er ugyldigt — bed om et nyt");
      if (newPassword.length < 8) return err(400, "Adgangskoden skal være mindst 8 tegn");

      const upstream = await fetch(`${AUTH_BASE}/reset-password`, {
        method: "POST",
        headers: upstreamHeaders(),
        body: JSON.stringify({ newPassword, token }),
      });
      if (upstream.ok) return json({ ok: true });

      const upstreamBody: any = await upstream.json().catch(() => null);
      if (upstreamBody?.code === "INVALID_TOKEN") return err(400, "Linket er ugyldigt eller udløbet — bed om et nyt");
      if (upstreamBody?.code === "PASSWORD_TOO_SHORT") return err(400, "Adgangskoden skal være mindst 8 tegn");
      if (upstream.status === 429) return err(429, "For mange forsøg — vent et par minutter og prøv igen");
      return err(400, "Kunne ikke ændre adgangskoden");
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
