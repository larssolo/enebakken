import { requireMember } from "../_lib/auth.js";
import { sql, callerRole } from "../_lib/db.js";
import { presignGet, objectExists, deleteObject } from "../_lib/storage.js";
import { json, err, isResponse } from "../_lib/http.js";

const PAGE_SIZE = 24;

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      // GET /api/photos[?before=<id>] — public. Newest first, one page at a
      // time, each with a presigned view URL (the bucket is private). Pages
      // by id rather than created_at: ids come from an identity sequence, so
      // they follow upload order and make a stable, unique cursor.
      if (request.method === "GET") {
        const before = new URL(request.url).searchParams.get("before");
        if (before !== null && !/^\d{1,18}$/.test(before)) return err(400, "Ugyldig side");

        const rows = before
          ? await sql`
              select id, caption, uploaded_by, created_at, object_key
              from photos where id < ${before} order by id desc limit ${PAGE_SIZE + 1}`
          : await sql`
              select id, caption, uploaded_by, created_at, object_key
              from photos order by id desc limit ${PAGE_SIZE + 1}`;
        const page = rows.slice(0, PAGE_SIZE);
        const items = await Promise.all(
          page.map(async (r) => ({
            id: r.id,
            caption: r.caption,
            uploaded_by: r.uploaded_by,
            created_at: r.created_at,
            url: await presignGet(r.object_key as string),
          })),
        );
        const nextCursor = rows.length > PAGE_SIZE ? String(page[page.length - 1].id) : null;
        return json({ items, nextCursor });
      }

      // POST /api/photos — member only. Body: { object_key, caption? }.
      // Confirms the object was actually uploaded (via the presigned URL
      // from /api/photos/presign) before recording it.
      if (request.method === "POST") {
        const caller = await requireMember(request);
        if (isResponse(caller)) return caller;

        const body: any = await request.json().catch(() => null);
        const objectKey = typeof body?.object_key === "string" ? body.object_key : "";
        const caption = typeof body?.caption === "string" ? body.caption.trim().slice(0, 500) : null;

        if (!objectKey.startsWith("photos/")) return err(400, "Ugyldig object_key");
        if (!(await objectExists(objectKey))) {
          return err(400, "Billedet blev ikke fundet — upload det først via /api/photos/presign");
        }

        const rows = await sql`
          insert into photos (object_key, caption, uploaded_by)
          values (${objectKey}, ${caption}, ${caller.userId})
          on conflict (object_key) do nothing
          returning id`;
        if (rows.length === 0) return err(409, "Billedet er allerede registreret");

        return json({ ok: true, id: rows[0].id });
      }

      // DELETE /api/photos — the uploader, or the owner, can remove a
      // photo. Body: { id }. Deletes the DB row first: if the storage
      // delete below then fails, the object is just an invisible orphan
      // rather than a row pointing at a 404'ing image for everyone.
      if (request.method === "DELETE") {
        const caller = await requireMember(request);
        if (isResponse(caller)) return caller;

        const body: any = await request.json().catch(() => null);
        const id = typeof body?.id === "number" || typeof body?.id === "string" ? String(body.id) : "";
        if (!id) return err(400, "Mangler id");

        const rows = await sql`select object_key, uploaded_by from photos where id = ${id}`;
        const photo = rows[0];
        if (!photo) return err(404, "Billedet findes ikke");

        const role = await callerRole(caller.userId);
        if (photo.uploaded_by !== caller.userId && role !== "owner") {
          return err(403, "Du kan kun slette dine egne billeder");
        }

        await sql`delete from photos where id = ${id}`;
        await deleteObject(photo.object_key as string).catch((e) => console.error("storage delete failed", e));

        return json({ ok: true });
      }

      return err(405, "Metode ikke understøttet");
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
