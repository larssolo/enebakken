import { requireOwner } from "./_lib/auth.js";
import { sql } from "./_lib/db.js";
import { json, err, isResponse } from "./_lib/http.js";
import { deleteAuthAccount } from "./_lib/accounts.js";

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

      // PATCH /api/members — administrator only. Body: { userId, blocked }
      // to block/unblock, or { userId, owner } to promote/demote an
      // administrator — exactly one of the two. Blocking stops new
      // uploads and checklist ticks; the account can still sign in and view
      // the site. Any administrator can promote or demote any other,
      // including the one making the call (self-demotion is fine as long
      // as at least one administrator is left afterward).
      if (request.method === "PATCH") {
        const body: any = await request.json().catch(() => null);
        const userId = typeof body?.userId === "string" ? body.userId : "";
        const hasBlocked = typeof body?.blocked === "boolean";
        const hasOwner = typeof body?.owner === "boolean";
        if (!userId || hasBlocked === hasOwner) {
          return err(400, "Mangler userId og præcis ét af blocked eller owner");
        }

        const found = await sql`
          select u.name, u.email, m.role from neon_auth.user u left join members m on m.user_id = u.id::text
          where u.id::text = ${userId}`;
        if (found.length === 0) return err(404, "Findes ikke");
        const currentRole = found[0].role as string | null;

        if (hasBlocked) {
          if (currentRole === "owner") return err(400, "En administrator kan ikke blokeres");
          if (body.blocked) {
            await sql`
              insert into members (user_id, role) values (${userId}, 'blocked')
              on conflict (user_id) do update set role = 'blocked' where members.role <> 'owner'`;
          } else {
            await sql`delete from members where user_id = ${userId} and role = 'blocked'`;
          }
        } else if (body.owner) {
          if (currentRole === "blocked") {
            return err(400, "Kontoen skal afblokeres, før den kan gøres til administrator");
          }
          const displayName = (found[0].name as string | null)?.trim() || (found[0].email as string);
          await sql`
            insert into members (user_id, role, display_name) values (${userId}, 'owner', ${displayName})
            on conflict (user_id) do update set role = 'owner'`;
        } else {
          if (currentRole !== "owner") return err(400, "Kontoen er ikke administrator");
          // Locks every owner row before counting, so two administrators
          // demoted at the same moment can't both slip past this check and
          // leave the site with none.
          const demoted = await sql.begin(async (tx) => {
            const owners = await tx`select user_id from members where role = 'owner' for update`;
            if (owners.length <= 1) return false;
            await tx`delete from members where user_id = ${userId} and role = 'owner'`;
            return true;
          });
          if (!demoted) return err(400, "Der skal altid være mindst én administrator");
        }
        return json({ ok: true });
      }

      // DELETE /api/members — administrator only. Body: { userId }. Removes
      // the account entirely — it can never sign in again. An administrator
      // has to be demoted first (same rule as blocking): this keeps deletion
      // from ever being the path that empties the site of administrators,
      // since demoting already guards that on its own.
      //
      // Photos they uploaded are deliberately left as they are: uploaded_by
      // was never a foreign key, and the gallery never displays it as a
      // name, only uses it for "may I delete this" — an orphaned id just
      // means nobody but an administrator can remove that photo, which
      // already held for a blocked account too.
      if (request.method === "DELETE") {
        const body: any = await request.json().catch(() => null);
        const userId = typeof body?.userId === "string" ? body.userId : "";
        if (!userId) return err(400, "Mangler userId");

        const found = await sql`
          select u.email, m.role from neon_auth.user u left join members m on m.user_id = u.id::text
          where u.id::text = ${userId}`;
        if (found.length === 0) return err(404, "Findes ikke");
        if (found[0].role === "owner") {
          return err(400, "En administrator kan ikke slettes — fjern administrator-status først");
        }
        const email = found[0].email as string;

        await deleteAuthAccount(userId, email);
        return json({ ok: true });
      }

      return err(405, "Metode ikke understøttet");
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
