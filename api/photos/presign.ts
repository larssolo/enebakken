import { requireUploader } from "../_lib/auth.js";
import { presignPut, MAX_UPLOAD_BYTES } from "../_lib/storage.js";
import { json, err, isResponse } from "../_lib/http.js";
import { randomUUID } from "node:crypto";

const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

// POST /api/photos/presign — any signed-in, non-blocked account. Body:
// { contentType, size } where size is the exact byte count about to be
// uploaded. Returns a short-lived presigned PUT URL; the browser uploads the
// bytes directly to storage (never through this function), then calls
// POST /api/photos with the returned object_key to record it.
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return err(405, "Metode ikke understøttet");
    try {
      const caller = await requireUploader(request);
      if (isResponse(caller)) return caller;

      const body: any = await request.json().catch(() => null);
      const contentType = typeof body?.contentType === "string" ? body.contentType : "";
      const ext = ALLOWED_TYPES[contentType];
      if (!ext) return err(400, "Kun JPEG, PNG, WEBP eller GIF billeder er tilladt");
      const size = body?.size;
      if (!Number.isInteger(size) || size <= 0) return err(400, "Mangler billedets størrelse");
      if (size > MAX_UPLOAD_BYTES) return err(400, "Billedet er for stort (max 20 MB)");

      const objectKey = `photos/${randomUUID()}.${ext}`;
      const uploadUrl = await presignPut(objectKey, contentType, size);

      return json({ ok: true, object_key: objectKey, upload_url: uploadUrl, expires_in: 300 });
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
