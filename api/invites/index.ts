import { requireOwner } from "../_lib/auth.js";
import { sql } from "../_lib/db.js";
import { json, err, isResponse } from "../_lib/http.js";
import { randomBytes, createHash } from "node:crypto";

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
      // Returns the raw link; the owner shares it themselves.
      if (request.method === "POST") {
        const body: any = await request.json().catch(() => null);
        const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
        if (!email || !email.includes("@")) return err(400, "Ugyldig e-mail");

        const rawToken = randomBytes(32).toString("base64url");
        const tokenHash = createHash("sha256").update(rawToken).digest("hex");
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        await sql.begin(async (tx) => {
          const updated = await tx`
            update invites
            set token_hash = ${tokenHash}, invited_by = ${caller.userId},
                expires_at = ${expiresAt}, created_at = now()
            where email = ${email} and accepted_at is null`;
          if (updated.count === 0) {
            await tx`insert into invites (email, token_hash, invited_by, expires_at)
                      values (${email}, ${tokenHash}, ${caller.userId}, ${expiresAt})`;
          }
        });

        const link = `https://www.enebakken.info/?invite=${rawToken}`;
        return json({ ok: true, email, link, expires_at: expiresAt.toISOString() });
      }

      // DELETE /api/invites — owner only. Body: { id }. Cancels a pending
      // invite (or just cleans up an old accepted one — either way, this
      // table row is a separate record from the members row it may have
      // produced, so deleting it never touches anyone's actual access).
      if (request.method === "DELETE") {
        const body: any = await request.json().catch(() => null);
        const id = typeof body?.id === "number" || typeof body?.id === "string" ? String(body.id) : "";
        if (!id) return err(400, "Mangler id");
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
