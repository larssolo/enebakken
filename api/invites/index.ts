import { requireOwner } from "../_lib/auth.js";
import { sql } from "../_lib/db.js";
import { json, err, isResponse } from "../_lib/http.js";
import { deleteAuthAccount } from "../_lib/accounts.js";
import { AUTH_BASE, getUpstreamCookiePair, upstreamHeaders } from "../_lib/authProxy.js";
import { randomBytes, createHash } from "node:crypto";

// A friendly placeholder shown until the account has a real name — the
// invitee never types one, since they never fill in a sign-up form.
function inviteeName(email: string): string {
  const local = email.split("@")[0];
  const words = local.split(/[._+-]+/).filter(Boolean);
  if (words.length === 0) return email;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const caller = await requireOwner(request);
      if (isResponse(caller)) return caller;

      // GET /api/invites — owner only. Pending (unredeemed) invites.
      if (request.method === "GET") {
        const rows = await sql`
          select id, email, created_at, expires_at
          from invites
          where accepted_at is null
          order by created_at desc`;
        return json({ items: rows });
      }

      // POST /api/invites — owner only. Body: { email }.
      // Returns the raw link; the owner shares it themselves. Clicking the
      // link logs the invitee straight in — see the auto-provisioning
      // below and /invites/redeem — so they never have to think up a
      // password themselves; they can always set their own afterwards.
      if (request.method === "POST") {
        const body: any = await request.json().catch(() => null);
        const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
        if (!email || !email.includes("@")) return err(400, "Ugyldig e-mail");

        const priorRows = await sql`
          select provisioned_user_id from invites where email = ${email} and accepted_at is null`;
        const priorProvisionedUserId = priorRows[0]?.provisioned_user_id as string | null | undefined;

        const existingRows = await sql`select id::text as user_id from neon_auth.user where lower(email) = ${email}`;
        const existingUserId = existingRows[0]?.user_id as string | undefined;

        // A still-pending invite we auto-provisioned ourselves, never
        // redeemed: safe to restart with a fresh password and session, so
        // it matches the new 7-day window this resend is about to set
        // instead of quietly expiring before the invite claims to.
        const ownsStaleAccount = !!existingUserId && !!priorProvisionedUserId && existingUserId === priorProvisionedUserId;
        if (ownsStaleAccount) {
          await deleteAuthAccount(existingUserId!, email);
        }

        let provisionedUserId: string | null = null;
        let sessionCookie: string | null = null;

        if (!existingUserId || ownsStaleAccount) {
          const tempPassword = randomBytes(24).toString("base64url");
          const upstream = await fetch(`${AUTH_BASE}/sign-up/email`, {
            method: "POST",
            headers: upstreamHeaders(),
            body: JSON.stringify({ email, password: tempPassword, name: inviteeName(email) }),
          });
          if (upstream.ok) {
            const upstreamBody: any = await upstream.json().catch(() => null);
            const pair = getUpstreamCookiePair(upstream);
            if (pair && typeof upstreamBody?.user?.id === "string") {
              provisionedUserId = upstreamBody.user.id;
              sessionCookie = pair;
            }
          }
          // Any other failure here is silently absorbed: the invite is
          // still created below, and the invitee falls back to signing
          // themselves up with the same link.
        }

        const rawToken = randomBytes(32).toString("base64url");
        const tokenHash = createHash("sha256").update(rawToken).digest("hex");
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        await sql.begin(async (tx) => {
          const updated = await tx`
            update invites
            set token_hash = ${tokenHash}, invited_by = ${caller.userId},
                expires_at = ${expiresAt}, created_at = now(),
                provisioned_user_id = ${provisionedUserId}, session_cookie = ${sessionCookie}
            where email = ${email} and accepted_at is null`;
          if (updated.count === 0) {
            await tx`insert into invites (email, token_hash, invited_by, expires_at, provisioned_user_id, session_cookie)
                      values (${email}, ${tokenHash}, ${caller.userId}, ${expiresAt}, ${provisionedUserId}, ${sessionCookie})`;
          }
        });

        const link = `https://www.enebakken.info/?invite=${rawToken}`;
        return json({ ok: true, email, link, expires_at: expiresAt.toISOString() });
      }

      // DELETE /api/invites — owner only. Body: { id }. Cancels a pending
      // invite (or just cleans up an old accepted one). If it auto-provisioned
      // an account that was never redeemed, that account is deleted too —
      // otherwise cancelling would leave a real, unused account behind with
      // a password nobody knows. An already-accepted invite's account is
      // never touched here: that row is a separate record from the members
      // row it produced, so deleting it never touches anyone's actual access.
      if (request.method === "DELETE") {
        const body: any = await request.json().catch(() => null);
        const id = typeof body?.id === "number" || typeof body?.id === "string" ? String(body.id) : "";
        if (!id) return err(400, "Mangler id");

        const rows = await sql`select email, provisioned_user_id, accepted_at from invites where id = ${id}`;
        const invite = rows[0];
        if (invite && invite.accepted_at === null && invite.provisioned_user_id) {
          await deleteAuthAccount(invite.provisioned_user_id as string, invite.email as string);
        }
        await sql`delete from invites where id = ${id}`;
        return json({ ok: true });
      }

      return err(405, "Metode ikke understøttet");
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
