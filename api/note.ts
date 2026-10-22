import { requireActiveUser } from "./_lib/auth.js";
import { sql } from "./_lib/db.js";
import { json, err, isResponse } from "./_lib/http.js";

// Enough for any shopping list; small enough that one note stays small.
const MAX_ITEMS = 100;
const MAX_TEXT_LENGTH = 200;
const MAX_ID_LENGTH = 40;

interface Item {
  id: string;
  text: string;
  done: boolean;
}

// GET /api/note — the signed-in person's own note: { items, updatedAt }.
// PUT /api/note — { items: [{ id, text, done }] } replaces it and answers
//                 like GET. The id is the page's, so an item keeps its
//                 identity while it is ticked or the list around it changes.
// The note is always the caller's own: there is no way to name anyone else's.
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "GET" && request.method !== "PUT") return err(405, "Metode ikke understøttet");

      const caller = await requireActiveUser(request);
      if (isResponse(caller)) return caller;

      if (request.method === "GET") {
        const rows = await sql`select items, updated_at from notes where user_id = ${caller.userId}`;
        return json(rows.length ? { items: rows[0].items, updatedAt: rows[0].updated_at } : { items: [], updatedAt: null });
      }

      const body: any = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || !Array.isArray(body.items)) return err(400, "Forventede { items: [...] }");
      if (body.items.length > MAX_ITEMS) return err(400, `Sedlen kan højst have ${MAX_ITEMS} punkter`);

      const items: Item[] = [];
      const ids = new Set<string>();
      for (const it of body.items) {
        const id = typeof it?.id === "string" ? it.id : "";
        const text = typeof it?.text === "string" ? it.text.trim() : "";
        if (!id || id.length > MAX_ID_LENGTH || ids.has(id)) return err(400, "Hvert punkt skal have sit eget id");
        if (!text) return err(400, "Et punkt kan ikke være tomt");
        if (text.length > MAX_TEXT_LENGTH) return err(400, `Et punkt kan højst være ${MAX_TEXT_LENGTH} tegn`);
        if (typeof it.done !== "boolean") return err(400, "Hvert punkt skal være afkrydset eller ej");
        ids.add(id);
        items.push({ id, text, done: it.done });
      }

      const rows = await sql`
        insert into notes (user_id, items, updated_at)
        values (${caller.userId}, ${sql.json(items as any)}, now())
        on conflict (user_id) do update set items = excluded.items, updated_at = excluded.updated_at
        returning items, updated_at`;
      return json({ items: rows[0].items, updatedAt: rows[0].updated_at });
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
