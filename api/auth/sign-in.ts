import { AUTH_BASE, getUpstreamCookiePair, getUpstreamMaxAge, setSessionCookie, upstreamHeaders } from "../_lib/authProxy.js";
import { json, err } from "../_lib/http.js";

// POST /api/auth/sign-in — proxies Neon Auth's sign-in/email, same
// cookie-relay pattern as sign-up.
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return err(405, "Metode ikke understøttet");
    try {
      const body: any = await request.json().catch(() => null);
      const email = typeof body?.email === "string" ? body.email.trim() : "";
      const password = typeof body?.password === "string" ? body.password : "";
      if (!email || !password) return err(400, "Udfyld e-mail og adgangskode");

      const upstream = await fetch(`${AUTH_BASE}/sign-in/email`, {
        method: "POST",
        headers: upstreamHeaders(),
        body: JSON.stringify({ email, password }),
      });

      if (!upstream.ok) {
        if (upstream.status === 401) return err(401, "Forkert e-mail eller adgangskode");
        return err(400, "Kunne ikke logge ind");
      }
      const upstreamBody: any = await upstream.json().catch(() => null);

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
