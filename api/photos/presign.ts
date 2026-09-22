import { requireMember } from "../_lib/auth.js";
import { presignPut } from "../_lib/storage.js";
import { json, err, isResponse } from "../_lib/http.js";
import { randomUUID } from "node:crypto";

const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

// POST /api/photos/presign — member only. Body: { contentType }.
// Returns a short-lived presigned PUT URL; the browser uploads the image
// bytes directly to storage (never through this function), then calls
// POST /api/photos with the returned object_key to record it.
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return err(405, "Metode ikke understøttet");
    try {
      const caller = await requireMember(request);
      if (isResponse(caller)) return caller;

      const body: any = await request.json().catch(() => null);
      const contentType = typeof body?.contentType === "string" ? body.contentType : "";
      const ext = ALLOWED_TYPES[contentType];
      if (!ext) return err(400, "Kun JPEG, PNG, WEBP eller GIF billeder er tilladt");

      const objectKey = `photos/${randomUUID()}.${ext}`;
      const uploadUrl = await presignPut(objectKey, contentType);

      return json({ ok: true, object_key: objectKey, upload_url: uploadUrl, expires_in: 300 });
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
