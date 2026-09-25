import { authenticate } from "../_lib/auth.js";
import { sql } from "../_lib/db.js";
import { json, err } from "../_lib/http.js";
import { setSessionCookie, DEFAULT_MAX_AGE } from "../_lib/authProxy.js";
import { createHash } from "node:crypto";

// POST /api/invites/redeem — body: { token }.
//
// Two paths, depending on whether the invite carries a pre-provisioned
// session (see POST /api/invites): with one, the caller doesn't need to be
// signed in yet at all — the stored session becomes theirs right here, no
// password ever typed. Without one (the invited email already had an
// account when the invite was sent, or provisioning failed at the time),
// this falls back to the original flow: the caller must already be signed
// in under the matching email.
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return err(405, "Metode ikke understøttet");
    try {
      const body: any = await request.json().catch(() => null);
      const rawToken = typeof body?.token === "string" ? body.token : "";
      if (!rawToken) return err(400, "Mangler invitations-token");
      const tokenHash = createHash("sha256").update(rawToken).digest("hex");

      const rows = await sql`
        select id, email, provisioned_user_id, session_cookie
        from invites
        where token_hash = ${tokenHash} and accepted_at is null and expires_at > now()`;
      const invite = rows[0];
      if (!invite) return err(400, "Invitationen er ugyldig eller udløbet");

      if (invite.session_cookie) {
        const userId = invite.provisioned_user_id as string;
        await sql.begin(async (tx) => {
          await tx`update invites set accepted_at = now(), accepted_by = ${userId}, session_cookie = null where id = ${invite.id}`;
          await tx`insert into members (user_id, role, display_name)
                    select ${userId}, 'member', coalesce(u.name, u.email) from neon_auth.user u where u.id::text = ${userId}
                    on conflict (user_id) do nothing`;
        });
        const res = json({ ok: true, autoLoggedIn: true });
        setSessionCookie(res.headers, invite.session_cookie as string, DEFAULT_MAX_AGE);
        return res;
      }

      // Fallback: the invited email already had an account (or provisioning
      // failed) — the caller must already be signed in as that account.
      const caller = await authenticate(request);
      if (!caller) return err(401, "Log ind eller opret en konto først");
      if ((invite.email as string).toLowerCase() !== caller.email.toLowerCase()) {
        return err(403, "Denne invitation er ikke til den konto, du er logget ind med");
      }
      await sql.begin(async (tx) => {
        await tx`update invites set accepted_at = now(), accepted_by = ${caller.userId} where id = ${invite.id}`;
        await tx`insert into members (user_id, role, display_name)
                  values (${caller.userId}, 'member', ${caller.name?.trim() || caller.email})
                  on conflict (user_id) do nothing`;
      });
      return json({ ok: true });
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
