import { authenticate } from "./_lib/auth.js";
import { callerRole } from "./_lib/db.js";
import { json, err } from "./_lib/http.js";

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") return err(405, "Metode ikke understøttet");
    try {
      const caller = await authenticate(request);
      if (!caller) return json({ authenticated: false });
      const role = await callerRole(caller.userId);
      return json({ authenticated: true, email: caller.email, name: caller.name, role });
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
