import { authenticate } from "./_lib/auth.js";
import { sql } from "./_lib/db.js";
import { json, err } from "./_lib/http.js";

// One-time bootstrap: the first authenticated caller becomes owner, but
// only while the members table is still empty. Permanently inert the
// moment anyone has claimed it — safe to leave deployed indefinitely.
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return err(405, "Metode ikke understøttet");
    try {
      const caller = await authenticate(request);
      if (!caller) return err(401, "Log ind for at fortsætte");

      const claimed = await sql.begin(async (tx) => {
        const existing = await tx`select 1 from members limit 1 for update`;
        if (existing.length > 0) return false;
        await tx`insert into members (user_id, role, display_name)
                  values (${caller.userId}, 'owner', ${caller.name?.trim() || caller.email})`;
        return true;
      });

      if (!claimed) return err(409, "Der er allerede en ejer");
      return json({ ok: true, role: "owner" });
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
