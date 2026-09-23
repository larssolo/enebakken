import { authenticate } from "../_lib/auth.js";
import { sql } from "../_lib/db.js";
import { json, err } from "../_lib/http.js";
import { createHash } from "node:crypto";

// POST /api/invites/redeem — any authenticated caller. Body: { token }.
// The invite's email must match the signed-in account's email: possession
// of the link is not enough on its own, so forwarding it doesn't work.
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return err(405, "Metode ikke understøttet");
    try {
      const caller = await authenticate(request);
      if (!caller) return err(401, "Log ind eller opret en konto først");

      const body: any = await request.json().catch(() => null);
      const rawToken = typeof body?.token === "string" ? body.token : "";
      if (!rawToken) return err(400, "Mangler invitations-token");

      const tokenHash = createHash("sha256").update(rawToken).digest("hex");

      const result = await sql.begin(async (tx) => {
        const rows = await tx`
          select id, email from invites
          where token_hash = ${tokenHash} and accepted_at is null and expires_at > now()`;
        const invite = rows[0];
        if (!invite) {
          return { ok: false as const, status: 400, message: "Invitationen er ugyldig eller udløbet" };
        }
        if ((invite.email as string).toLowerCase() !== caller.email.toLowerCase()) {
          return {
            ok: false as const,
            status: 403,
            message: "Denne invitation er ikke til den konto, du er logget ind med",
          };
        }
        await tx`update invites set accepted_at = now(), accepted_by = ${caller.userId} where id = ${invite.id}`;
        await tx`insert into members (user_id, role, display_name)
                  values (${caller.userId}, 'member', ${caller.name?.trim() || caller.email})
                  on conflict (user_id) do nothing`;
        return { ok: true as const };
      });

      if (!result.ok) return err(result.status, result.message);
      return json({ ok: true });
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
