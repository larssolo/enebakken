import { requireOwner } from "./_lib/auth.js";
import { sql } from "./_lib/db.js";
import { json, err, isResponse } from "./_lib/http.js";

const VALID_LISTS = new Set(["luk", "aaben"]);

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method === "GET") {
        const url = new URL(request.url);
        const list = url.searchParams.get("list");
        if (list && !VALID_LISTS.has(list)) {
          return err(400, "list skal være luk eller aaben");
        }
        const rows = list
          ? await sql`select id, list, label, position from checklist_items
                      where list = ${list} order by position`
          : await sql`select id, list, label, position from checklist_items
                      order by list, position`;
        return json({ items: rows });
      }

      if (request.method === "PUT") {
        const caller = await requireOwner(request);
        if (isResponse(caller)) return caller;

        const body: any = await request.json().catch(() => null);
        const list = body?.list;
        const items = body?.items;
        if (!VALID_LISTS.has(list) || !Array.isArray(items) || items.length === 0) {
          return err(400, 'Forventede { list: "luk"|"aaben", items: [{ label }] }');
        }
        const labels: string[] = [];
        for (const it of items) {
          const label = typeof it?.label === "string" ? it.label.trim() : "";
          if (!label) return err(400, "Hvert punkt skal have en label");
          if (label.length > 500) return err(400, "En label er for lang (max 500 tegn)");
          labels.push(label);
        }

        await sql.begin(async (tx) => {
          await tx`delete from checklist_items where list = ${list}`;
          for (let i = 0; i < labels.length; i++) {
            await tx`insert into checklist_items (list, label, position)
                      values (${list}, ${labels[i]}, ${i + 1})`;
          }
        });
        return json({ ok: true, list, count: labels.length });
      }

      return err(405, "Metode ikke understøttet");
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
