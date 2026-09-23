import postgres from "postgres";
import { requireActiveUser } from "./_lib/auth.js";
import { sql } from "./_lib/db.js";
import { json, err, isResponse } from "./_lib/http.js";

const LISTS = new Set(["luk", "aaben"]);
// A list nobody has touched for this long is a finished visit and reads as
// empty. A change older than this was made on a previous visit and is dropped.
const VISIT_HOURS = 24;
const MAX_AGE_MS = VISIT_HOURS * 60 * 60 * 1000;
const MAX_CHANGES = 200;
const MAX_LABEL_LENGTH = 500;

const NO_STORE = { "Cache-Control": "no-store" };

interface Change {
  list: string;
  label: string;
  checked: boolean;
  age_ms: number;
}

// How long ago the phone made the change, in its own clock. Ages instead of
// timestamps: a phone whose clock is off still orders its changes correctly.
function parseAge(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value > MAX_AGE_MS) return null;
  return Math.max(0, Math.round(value));
}

// What the page shows: checked items, who checked them (first name only;
// nobody needs more) and how long ago.
async function readTicks(q: postgres.ISql, userId: string) {
  const rows = await q`
    select t.list, t.label, t.changed_by_name, t.changed_by = ${userId} as mine,
           (extract(epoch from now() - t.changed_at) * 1000)::float8 as age_ms
    from checklist_ticks t
    where t.checked
      and exists (select 1 from checklist_items i where i.list = t.list and i.label = t.label)
      and t.list in (select list from checklist_ticks group by list
                     having max(changed_at) >= now() - make_interval(hours => ${VISIT_HOURS}))`;
  return rows.map((r) => ({
    list: r.list as string,
    label: r.label as string,
    by: (typeof r.changed_by_name === "string" && r.changed_by_name.trim().split(/\s+/)[0]) || null,
    mine: r.mine as boolean,
    ageMs: Math.max(0, Math.round(r.age_ms as number)),
  }));
}

// GET  /api/ticks — the shared ticks on both lists.
// POST /api/ticks — { resets?: [{ list, ageMs }], changes?: [{ list, label,
//      checked, ageMs }] }, what one phone did since it last got through.
//      Answers with the ticks as they stand afterwards.
// Both need a signed-in account the owner hasn't blocked: who checked what,
// and when, says when the house is empty, so it isn't public.
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "GET" && request.method !== "POST") return err(405, "Metode ikke understøttet");

      const caller = await requireActiveUser(request);
      if (isResponse(caller)) return caller;

      if (request.method === "GET") {
        return json({ ticks: await readTicks(sql, caller.userId) }, 200, NO_STORE);
      }

      const body: any = await request.json().catch(() => null);
      const rawResets = body?.resets ?? [];
      const rawChanges = body?.changes ?? [];
      if (!body || typeof body !== "object" || !Array.isArray(rawResets) || !Array.isArray(rawChanges)) {
        return err(400, "Forventede { resets: [...], changes: [...] }");
      }
      if (rawResets.length > 10 || rawChanges.length > MAX_CHANGES) return err(400, "For mange ændringer på én gang");

      // The newest reset per list.
      const resets = new Map<string, number>();
      for (const r of rawResets) {
        const age = parseAge(r?.ageMs);
        if (!LISTS.has(r?.list) || age === null) continue;
        const prev = resets.get(r.list);
        if (prev === undefined || age < prev) resets.set(r.list, age);
      }

      // The newest change per item: one statement can't update a row twice.
      // Anything malformed or too old is skipped rather than failing the
      // batch, so one bad entry can't hold back the rest.
      const changes = new Map<string, Change>();
      for (const c of rawChanges) {
        const age = parseAge(c?.ageMs);
        const label = typeof c?.label === "string" ? c.label : "";
        if (!LISTS.has(c?.list) || !label || label.length > MAX_LABEL_LENGTH) continue;
        if (typeof c?.checked !== "boolean" || age === null) continue;
        const key = c.list + "\n" + label;
        const prev = changes.get(key);
        if (!prev || age < prev.age_ms) changes.set(key, { list: c.list, label, checked: c.checked, age_ms: age });
      }

      const name = caller.name?.trim() || null;
      const ticks = await sql.begin(async (tx) => {
        // Writers take turns: a reset and an older change arriving at the
        // same moment must not both win. (The checklist PUT takes it too.)
        await tx`select list from checklist_resets order by list for update`;

        await tx`
          delete from checklist_ticks where list in (
            select list from checklist_ticks group by list
            having max(changed_at) < now() - make_interval(hours => ${VISIT_HOURS}))`;

        for (const [list, age] of resets) {
          await tx`
            delete from checklist_ticks
            where list = ${list} and changed_at <= now() - make_interval(secs => ${age / 1000})`;
          await tx`
            update checklist_resets
            set reset_at = greatest(reset_at, now() - make_interval(secs => ${age / 1000}))
            where list = ${list}`;
        }

        // A change counts only for an item that is on the list, only if it
        // was made after the last reset, and only if nothing newer has
        // already been recorded for that item.
        if (changes.size > 0) {
          await tx`
            insert into checklist_ticks as t (list, label, checked, changed_by, changed_by_name, changed_at)
            select c.list, c.label, c.checked, ${caller.userId}, ${name},
                   now() - make_interval(secs => c.age_ms / 1000)
            from jsonb_to_recordset(${tx.json([...changes.values()] as any)})
                 as c(list text, label text, checked boolean, age_ms float8)
            join checklist_resets r on r.list = c.list
            where now() - make_interval(secs => c.age_ms / 1000) > r.reset_at
              and exists (select 1 from checklist_items i where i.list = c.list and i.label = c.label)
            on conflict (list, label) do update
              set checked = excluded.checked,
                  changed_by = excluded.changed_by,
                  changed_by_name = excluded.changed_by_name,
                  changed_at = excluded.changed_at
              where t.changed_at <= excluded.changed_at`;
        }

        return readTicks(tx, caller.userId);
      });

      return json({ ticks }, 200, NO_STORE);
    } catch (e) {
      console.error(e);
      return err(500, "Der gik noget galt");
    }
  },
};
