import { authenticate, verifyToken } from "./_lib/auth.js";
import { AUTH_BASE, readSessionCookie, upstreamHeaders } from "./_lib/authProxy.js";
import { callerRole, sql } from "./_lib/db.js";
import { json, err } from "./_lib/http.js";
import { MAX_NAME_LENGTH, normalizeName } from "./_lib/accounts.js";

// Whose session the cookie is, asked of Neon Auth itself.
async function sessionUserId(pair: string): Promise<string | null> {
  const upstream = await fetch(`${AUTH_BASE}/token`, { headers: { ...upstreamHeaders(), Cookie: pair } });
  if (!upstream.ok) return null;
  const body: any = await upstream.json().catch(() => null);
  if (typeof body?.token !== "string") return null;
  return (await verifyToken(body.token))?.userId ?? null;
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method === "GET") {
        const caller = await authenticate(request);
        if (!caller) return json({ authenticated: false });
        const role = await callerRole(caller.userId);
        return json({ authenticated: true, userId: caller.userId, email: caller.email, name: caller.name, role });
      }

      // PATCH /api/me — body: { name }. Changes the signed-in account's own
      // name. Neon Auth owns the name (it's what goes into every token), so
      // it's changed there, through the session, like any other account
      // change; the members row's copy, which the admin list shows first,
      // is kept in step. The change goes through the session cookie while
      // the members row is picked by the token, so the two must be the
      // same person — a token cached from before someone else signed in
      // in the same browser would otherwise rename one account and write
      // the name onto another's row.
      if (request.method === "PATCH") {
        const caller = await authenticate(request);
        if (!caller) return err(401, "Log ind for at fortsætte");
        const pair = readSessionCookie(request);
        if (!pair) return err(401, "Log ind for at fortsætte");

        const body: any = await request.json().catch(() => null);
        const name = normalizeName(body?.name);
        if (!name) return err(400, "Skriv dit navn");
        if (name.length > MAX_NAME_LENGTH) return err(400, `Navnet må højst være ${MAX_NAME_LENGTH} tegn`);

        if ((await sessionUserId(pair)) !== caller.userId) return err(401, "Log ind for at fortsætte");

        const upstream = await fetch(`${AUTH_BASE}/update-user`, {
          method: "POST",
          headers: { ...upstreamHeaders(), Cookie: pair },
          body: JSON.stringify({ name }),
        });
        if (upstream.status === 401) return err(401, "Log ind for at fortsætte");
        if (!upstream.ok) return err(502, "Kunne ikke gemme navnet — prøv igen");

        await sql`update members set display_name = ${name} where user_id = ${caller.userId}`;
        return json({ ok: true, name });
      }

      return err(405, "Metode ikke understøttet");
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
