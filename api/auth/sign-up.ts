import { AUTH_BASE, getUpstreamCookiePair, getUpstreamMaxAge, setSessionCookie, upstreamHeaders } from "../_lib/authProxy.js";
import { json, err } from "../_lib/http.js";

// POST /api/auth/sign-up — proxies Neon Auth's sign-up/email so the
// browser only ever talks to our own origin. On success, sets a first-party
// session cookie (see _lib/authProxy.ts for why).
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return err(405, "Metode ikke understøttet");
    try {
      const body: any = await request.json().catch(() => null);
      const email = typeof body?.email === "string" ? body.email.trim() : "";
      const password = typeof body?.password === "string" ? body.password : "";
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!email || !email.includes("@")) return err(400, "Ugyldig e-mail");
      if (!name) return err(400, "Udfyld dit navn");
      if (password.length < 8) return err(400, "Adgangskoden skal være mindst 8 tegn");

      const upstream = await fetch(`${AUTH_BASE}/sign-up/email`, {
        method: "POST",
        headers: upstreamHeaders(),
        body: JSON.stringify({ email, password, name }),
      });
      const upstreamBody: any = await upstream.json().catch(() => null);

      if (!upstream.ok) {
        if (upstream.status === 422) return err(409, "Der findes allerede en bruger med denne e-mail");
        return err(400, upstreamBody?.message || "Kunne ikke oprette bruger");
      }

      const pair = getUpstreamCookiePair(upstream);
      if (!pair) return err(502, "Uventet svar fra login-tjenesten");

      const res = json({ ok: true, email: upstreamBody?.user?.email ?? email });
      setSessionCookie(res.headers, pair, getUpstreamMaxAge(upstream));
      return res;
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
