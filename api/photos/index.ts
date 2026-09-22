import { requireMember } from "../_lib/auth.js";
import { sql } from "../_lib/db.js";
import { presignGet, objectExists } from "../_lib/storage.js";
import { json, err, isResponse } from "../_lib/http.js";

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      // GET /api/photos — public. Newest first, each with a short-lived
      // presigned view URL (the bucket is private).
      if (request.method === "GET") {
        const rows = await sql`
          select id, caption, uploaded_by, created_at, object_key
          from photos order by created_at desc limit 100`;
        const items = await Promise.all(
          rows.map(async (r) => ({
            id: r.id,
            caption: r.caption,
            uploaded_by: r.uploaded_by,
            created_at: r.created_at,
            url: await presignGet(r.object_key as string),
          })),
        );
        return json({ items });
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

      return err(405, "Metode ikke understøttet");
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
