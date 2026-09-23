import { authenticate, requireUploader } from "../_lib/auth.js";
import { sql, callerRole } from "../_lib/db.js";
import { presignGet, headObject, getObjectBytes, putObject, deleteObject, MAX_UPLOAD_BYTES } from "../_lib/storage.js";
import { normalizeImage, NotAnImageError } from "../_lib/image.js";
import { json, err, isResponse } from "../_lib/http.js";

const PAGE_SIZE = 24;
const TYPE_BY_EXT: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
const KEY_PATTERN = /^photos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/;

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

      // POST /api/photos — any signed-in, non-blocked account. Body:
      // { object_key, caption? }. The uploaded object is fetched back,
      // normalized (see _lib/image.ts) and overwritten before it's recorded,
      // so what the gallery serves never depends on what the browser did.
      if (request.method === "POST") {
        const caller = await requireUploader(request);
        if (isResponse(caller)) return caller;

        const body: any = await request.json().catch(() => null);
        const objectKey = typeof body?.object_key === "string" ? body.object_key : "";
        const caption = typeof body?.caption === "string" ? body.caption.trim().slice(0, 500) : null;

        const keyMatch = KEY_PATTERN.exec(objectKey);
        if (!keyMatch) return err(400, "Ugyldig object_key");
        const contentType = TYPE_BY_EXT[keyMatch[1]];

        const existing = await sql`select 1 from photos where object_key = ${objectKey}`;
        if (existing.length > 0) return err(409, "Billedet er allerede registreret");

        const head = await headObject(objectKey);
        if (!head) return err(400, "Billedet blev ikke fundet — upload det først via /api/photos/presign");
        if (head.size > MAX_UPLOAD_BYTES) {
          await deleteObject(objectKey).catch((e) => console.error("storage delete failed", e));
          return err(400, "Billedet er for stort (max 20 MB)");
        }

        let normalized;
        try {
          normalized = await normalizeImage(await getObjectBytes(objectKey), contentType);
        } catch (e) {
          if (!(e instanceof NotAnImageError)) throw e;
          await deleteObject(objectKey).catch((e2) => console.error("storage delete failed", e2));
          return err(400, "Filen er ikke et gyldigt billede");
        }
        await putObject(objectKey, normalized.data, contentType);

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
        const caller = await authenticate(request);
        if (!caller) return err(401, "Log ind for at fortsætte");

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
