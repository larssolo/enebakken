import { requireOwner } from "./_lib/auth.js";
import { sql } from "./_lib/db.js";
import { json, err, isResponse } from "./_lib/http.js";

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const caller = await requireOwner(request);
      if (isResponse(caller)) return caller;

      // GET /api/members — owner only. Everyone with access.
      if (request.method === "GET") {
        const rows = await sql`
          select user_id, display_name, role, created_at
          from members
          order by created_at`;
        return json({ items: rows });
      }

      // DELETE /api/members — owner only. Body: { userId }. Revokes access
      // by removing the membership row only — the underlying Neon Auth
      // identity is untouched, so if they sign back in they're just an
      // authenticated visitor with no role again, same as before they
      // were ever invited.
      //
      // Never allow removing an owner row through this endpoint: doing so
      // could leave the site with no owner at all, and bootstrap-owner
      // only re-arms once the members table is completely empty — with
      // other member rows still present, nobody could ever reclaim it.
      if (request.method === "DELETE") {
        const body: any = await request.json().catch(() => null);
        const userId = typeof body?.userId === "string" ? body.userId : "";
        if (!userId) return err(400, "Mangler userId");

        const rows = await sql`select role from members where user_id = ${userId}`;
        if (rows.length === 0) return err(404, "Findes ikke");
        if (rows[0].role === "owner") return err(400, "Kan ikke fjerne ejeren");

        await sql`delete from members where user_id = ${userId}`;
        return json({ ok: true });
      }

      return err(405, "Metode ikke understøttet");
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
