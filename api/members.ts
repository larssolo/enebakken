import { requireOwner } from "./_lib/auth.js";
import { sql } from "./_lib/db.js";
import { json, err, isResponse } from "./_lib/http.js";

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const caller = await requireOwner(request);
      if (isResponse(caller)) return caller;

      // GET /api/members — owner only. Every account that exists, not just
      // invited ones: anyone can sign up and upload, so the owner needs to
      // see (and be able to block) accounts they never invited.
      if (request.method === "GET") {
        const rows = await sql`
          select u.id::text as user_id,
                 coalesce(m.display_name, u.name) as display_name,
                 u.email,
                 coalesce(m.role, 'user') as role,
                 u."createdAt" as created_at,
                 (select count(*)::int from photos p where p.uploaded_by = u.id::text) as photos
          from neon_auth.user u
          left join members m on m.user_id = u.id::text
          order by (m.role = 'owner') desc nulls last, u."createdAt"`;
        return json({ items: rows });
      }

      // PATCH /api/members — owner only. Body: { userId, blocked }. Blocking
      // stops new uploads; the account can still sign in and view the site.
      if (request.method === "PATCH") {
        const body: any = await request.json().catch(() => null);
        const userId = typeof body?.userId === "string" ? body.userId : "";
        if (!userId || typeof body?.blocked !== "boolean") return err(400, "Mangler userId eller blocked");

        const found = await sql`
          select m.role from neon_auth.user u left join members m on m.user_id = u.id::text
          where u.id::text = ${userId}`;
        if (found.length === 0) return err(404, "Findes ikke");
        if (found[0].role === "owner") return err(400, "Ejeren kan ikke blokeres");

        if (body.blocked) {
          await sql`
            insert into members (user_id, role) values (${userId}, 'blocked')
            on conflict (user_id) do update set role = 'blocked' where members.role <> 'owner'`;
        } else {
          await sql`delete from members where user_id = ${userId} and role = 'blocked'`;
        }
        return json({ ok: true });
      }

      return err(405, "Metode ikke understøttet");
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
