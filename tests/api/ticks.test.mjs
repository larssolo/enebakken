// Runs the real api/ticks.ts and api/checklist.ts handlers against a local
// Postgres 16 with all migrations applied. Tokens are signed by a local
// Ed25519 key served from a local JWKS endpoint, so the handlers' real JWT
// verification runs unchanged.
import postgres from "postgres";
import { DATABASE_URL, createChecks, createSigner, loadApi, startJwksServer } from "../lib/harness.mjs";

const signer = createSigner();
const jwks = await startJwksServer(signer);
const ticksApi = await loadApi("ticks");
const checklistApi = await loadApi("checklist");
const db = postgres(DATABASE_URL, { onnotice: () => {} });

const mint = (sub, name, email) => signer.mint(jwks.origin, { sub, email: email || sub + "@example.com", name });
const A = mint("user-a", "Lars Sohl");
const B = mint("user-b", "Anna Marie Hansen");
const C = mint("user-c", "Spam Konto");

async function call(api, method, token, body, path = "/api/ticks") {
  const res = await api.fetch(new Request("http://x" + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }));
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json, cache: res.headers.get("cache-control") };
}
const ticks = (api, method, token, body) => call(api, method, token, body);
const post = (token, body) => ticks(ticksApi, "POST", token, body);
const get = (token) => ticks(ticksApi, "GET", token);

const { check, finish } = createChecks();
const view = (r, list) => (r.body?.ticks || []).filter((t) => t.list === list).map((t) => t.label).sort();

// fresh state
await db`delete from checklist_ticks`;
await db`update checklist_resets set reset_at = '-infinity'`;
await db`delete from members`;
const luk = (await db`select label from checklist_items where list = 'luk' order by position`).map((r) => r.label);
const aaben = (await db`select label from checklist_items where list = 'aaben' order by position`).map((r) => r.label);

// --- access ---
let r = await get(null);
check("GET without a token is 401", r.status === 401, r);
r = await ticks(ticksApi, "PUT", A, {});
check("other methods are 405", r.status === 405, r);
r = await get(A);
check("GET signed in: empty, no-store", r.status === 200 && Array.isArray(r.body.ticks) && r.body.ticks.length === 0 && r.cache === "no-store", r);

// --- a tick shows up for the other account, first name only ---
r = await post(A, { changes: [{ list: "luk", label: luk[0], checked: true, ageMs: 0 }] });
check("POST tick answers with the new state", r.status === 200 && r.body.ticks.length === 1 && r.body.ticks[0].mine === true && r.body.ticks[0].by === "Lars" && r.cache === "no-store", r.body);
r = await get(B);
check("other account sees it: first name, not mine, recent", r.body.ticks.length === 1 && r.body.ticks[0].by === "Lars" && r.body.ticks[0].mine === false && r.body.ticks[0].ageMs >= 0 && r.body.ticks[0].ageMs < 5000, r.body);
check("response carries no user ids or emails", !JSON.stringify(r.body).includes("user-a") && !JSON.stringify(r.body).includes("@"), r.body);

// --- newest change wins, whatever order they arrive in ---
await post(B, { changes: [{ list: "luk", label: luk[0], checked: false, ageMs: 0 }] });
r = await post(A, { changes: [{ list: "luk", label: luk[0], checked: true, ageMs: 60_000 }] }); // made offline a minute ago
check("an older offline tick doesn't undo a newer untick", view(r, "luk").length === 0, r.body);
r = await post(A, { changes: [{ list: "luk", label: luk[0], checked: true, ageMs: 0 }] });
check("a newer tick wins", view(r, "luk").includes(luk[0]), r.body);
const row = (await db`select changed_by, changed_by_name from checklist_ticks where list = 'luk' and label = ${luk[0]}`)[0];
check("row records who (id + full name)", row.changed_by === "user-a" && row.changed_by_name === "Lars Sohl", row);

// --- one batch, same item twice: newest wins, no 'affect row twice' error ---
r = await post(B, { changes: [
  { list: "luk", label: luk[1], checked: true, ageMs: 5000 },
  { list: "luk", label: luk[1], checked: false, ageMs: 1000 },
] });
check("duplicate item in a batch: newest wins, no error", r.status === 200 && !view(r, "luk").includes(luk[1]), r);

// --- reset for everyone, and a stale offline tick can't come back ---
await post(A, { changes: [{ list: "luk", label: luk[2], checked: true, ageMs: 0 }] });
r = await post(B, { resets: [{ list: "luk", ageMs: 0 }] });
check("reset clears the list for everyone", view(r, "luk").length === 0, r.body);
r = await post(A, { changes: [{ list: "luk", label: luk[3], checked: true, ageMs: 30_000 }] });
check("a tick made before the reset (sent late) is dropped", view(r, "luk").length === 0, r.body);
r = await post(A, { changes: [{ list: "luk", label: luk[3], checked: true, ageMs: 0 }] });
check("a tick after the reset counts", view(r, "luk").includes(luk[3]), r.body);
r = await post(B, { resets: [{ list: "luk", ageMs: 3_600_000 }] }); // a reset made an hour ago, sent late
check("an old reset doesn't clear newer ticks", view(r, "luk").includes(luk[3]), r.body);
const resetAt = (await db`select (now() - reset_at) < interval '10 seconds' as recent from checklist_resets where list = 'luk'`)[0];
check("reset line never moves backwards", resetAt.recent === true, resetAt);
// luk[3] was ticked 10 s ago; one batch holds a reset from 2 s ago and a tick from now.
await db`update checklist_resets set reset_at = '-infinity' where list = 'luk'`;
await db`update checklist_ticks set changed_at = now() - interval '10 seconds' where list = 'luk' and label = ${luk[3]}`;
r = await post(A, { changes: [{ list: "luk", label: luk[4], checked: true, ageMs: 0 }], resets: [{ list: "luk", ageMs: 2000 }] });
check("reset + later tick in one batch: reset clears older, newer tick survives", view(r, "luk").includes(luk[4]) && !view(r, "luk").includes(luk[3]), r.body);

// --- validation: bad entries are skipped, the rest of the batch still counts ---
r = await post(A, { changes: [
  { list: "luk", label: "Findes ikke på listen", checked: true, ageMs: 0 },
  { list: "kaelder", label: luk[5], checked: true, ageMs: 0 },
  { list: "luk", label: luk[5], checked: "ja", ageMs: 0 },
  { list: "luk", label: luk[6], checked: true, ageMs: 25 * 3600 * 1000 },
  { list: "luk", label: luk[7], checked: true, ageMs: "0" },
  { list: "luk", label: luk[8], checked: true, ageMs: -5000 },
  { list: "aaben", label: aaben[0], checked: true, ageMs: 0 },
] });
const lukNow = view(r, "luk");
check("unknown item, unknown list, bad types, too old: skipped", r.status === 200 && !lukNow.includes(luk[5]) && !lukNow.includes(luk[6]) && !lukNow.includes(luk[7]), r.body);
check("negative age is clamped to now and counts", lukNow.includes(luk[8]), lukNow);
check("valid entries in the same batch still count", view(r, "aaben").includes(aaben[0]), r.body);
const junk = await db`select count(*)::int as n from checklist_ticks where label = 'Findes ikke på listen' or list not in ('luk','aaben')`;
check("nothing stored for unknown items", junk[0].n === 0, junk);

r = await post(A, { changes: "nej" });
check("changes not an array: 400", r.status === 400, r);
r = await post(A, "{not json");
check("invalid JSON body: 400", r.status === 400, r);
r = await post(A, "null");
check("JSON null body: 400", r.status === 400, r);
r = await post(A, { changes: Array.from({ length: 201 }, () => ({ list: "luk", label: luk[0], checked: true, ageMs: 0 })) });
check("more than 200 changes: 400", r.status === 400, r);
r = await post(A, {});
check("empty POST just answers with the state", r.status === 200 && Array.isArray(r.body.ticks), r);

// --- blocked accounts are shut out ---
await db`insert into members (user_id, role) values ('user-c', 'blocked')`;
r = await get(C);
check("blocked account: GET 403 with a clear message", r.status === 403 && r.body.error === "Din konto er blokeret", r);
r = await post(C, { changes: [{ list: "luk", label: luk[9], checked: true, ageMs: 0 }] });
check("blocked account: POST 403, nothing stored", r.status === 403 && (await db`select 1 from checklist_ticks where label = ${luk[9]}`).length === 0, r);

// --- a list untouched for 24 hours reads as empty and is cleared on the next write ---
await db`update checklist_ticks set changed_at = now() - interval '25 hours' where list = 'aaben'`;
r = await get(A);
check("expired list reads as empty (other list untouched)", view(r, "aaben").length === 0 && view(r, "luk").length > 0, r.body);
r = await post(B, { changes: [{ list: "aaben", label: aaben[1], checked: true, ageMs: 0 }] });
const aabenRows = await db`select label from checklist_ticks where list = 'aaben'`;
check("next write starts a new visit: old rows deleted", aabenRows.length === 1 && aabenRows[0].label === aaben[1] && view(r, "aaben").length === 1, aabenRows);
await db`update checklist_ticks set changed_at = now() - interval '23 hours' where list = 'aaben'`;
r = await get(A);
check("a list touched 23 hours ago is still shown", view(r, "aaben").includes(aaben[1]), r.body);

// --- owner edits the list: ticks follow the item text ---
await db`insert into members (user_id, role) values ('user-a', 'owner')`;
await post(A, { changes: [{ list: "luk", label: luk[0], checked: true, ageMs: 0 }, { list: "luk", label: luk[1], checked: true, ageMs: 0 }] });
const kept = luk.filter((l) => l !== luk[1]);
r = await call(checklistApi, "PUT", A, { list: "luk", items: kept.map((label) => ({ label })) }, "/api/checklist");
check("owner saves the list without one ticked item", r.status === 200, r);
const lukRows = (await db`select label from checklist_ticks where list = 'luk'`).map((x) => x.label);
check("tick on the removed item is deleted, tick on a kept item stays", !lukRows.includes(luk[1]) && lukRows.includes(luk[0]), lukRows);
r = await call(checklistApi, "PUT", A, { list: "luk", items: [{ label: "Samme" }, { label: " Samme " }] }, "/api/checklist");
check("duplicate item text is refused", r.status === 400 && r.body.error.includes("to gange"), r);
r = await call(checklistApi, "PUT", B, { list: "luk", items: [{ label: "x" }] }, "/api/checklist");
check("non-owner can't edit the list", r.status === 403, r);
// restore the original list
await call(checklistApi, "PUT", A, { list: "luk", items: luk.map((label) => ({ label })) }, "/api/checklist");

// --- concurrency, deterministic: while another transaction holds the writer
// lock, a POST and a checklist PUT must wait for it (proves both take it) ---
async function blocksOnLock(label, run) {
  const x = await db.reserve();
  await x`begin`;
  await x`select list from checklist_resets order by list for update`;
  let done = false;
  const p = run().then((res) => { done = true; return res; });
  await new Promise((res) => setTimeout(res, 700));
  const waited = !done;
  await x`commit`;
  x.release();
  const res = await p;
  check(label, waited && res.status === 200, { waited, status: res.status });
}
await blocksOnLock("POST /api/ticks waits for the writer lock", () => post(A, { changes: [{ list: "luk", label: luk[0], checked: true, ageMs: 0 }] }));
await blocksOnLock("checklist PUT waits for the writer lock", () => call(checklistApi, "PUT", A, { list: "luk", items: luk.map((label) => ({ label })) }, "/api/checklist"));
let getDone = false;
{
  const x = await db.reserve();
  await x`begin`;
  await x`select list from checklist_resets order by list for update`;
  const p = get(B).then((res) => { getDone = true; return res; });
  await new Promise((res) => setTimeout(res, 700));
  check("GET does not wait for the writer lock (reads never block)", getDone, { getDone });
  await x`commit`;
  x.release();
  await p;
}

// --- concurrency, statistical: a reset racing an older change never lets the old change survive ---
let leaked = 0;
for (let i = 0; i < 25; i++) {
  await post(A, { changes: [{ list: "luk", label: luk[2], checked: false, ageMs: 0 }] });
  await Promise.all([
    post(B, { resets: [{ list: "luk", ageMs: 0 }] }),
    post(A, { changes: [{ list: "luk", label: luk[2], checked: true, ageMs: 2000 }] }),
  ]);
  const bad = await db`
    select 1 from checklist_ticks t join checklist_resets r using (list)
    where t.list = 'luk' and t.checked and t.changed_at <= r.reset_at`;
  if (bad.length) leaked++;
}
check("25 races of reset vs older change: never a tick older than the reset", leaked === 0, { leaked });

// --- many concurrent writers on one item: final state is the newest change ---
await db`delete from checklist_ticks`;
await db`update checklist_resets set reset_at = '-infinity'`;
const ops = Array.from({ length: 30 }, (_, i) => ({ checked: i % 2 === 0, ageMs: 1000 * (30 - i) }));
await Promise.all(ops.map((o, i) => post(i % 2 ? A : B, { changes: [{ list: "luk", label: luk[0], ...o }] })));
const final = (await db`select checked from checklist_ticks where list = 'luk' and label = ${luk[0]}`)[0];
const newest = ops.reduce((a, o) => (o.ageMs < a.ageMs ? o : a));
check("30 concurrent writes: the newest change is what stays", final && final.checked === newest.checked, { final, newest });

await db`delete from checklist_ticks`;
await db`update checklist_resets set reset_at = '-infinity'`;
await db`delete from members`;
await db.end();
jwks.close();
finish();
