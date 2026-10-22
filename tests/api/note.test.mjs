// Runs the real api/note.ts handler (everyone's own note under "Luk ned")
// against a local Postgres with all migrations applied, with real JWTs
// signed against a local JWKS endpoint.
import postgres from "postgres";
import { DATABASE_URL, createChecks, createSigner, loadApi, startJwksServer } from "../lib/harness.mjs";

const signer = createSigner();
const jwks = await startJwksServer(signer);
const noteApi = await loadApi("note");
const db = postgres(DATABASE_URL, { onnotice: () => {} });
const mint = (sub) => signer.mint(jwks.origin, { sub, email: sub + "@example.com", name: sub });
const A = mint("note-a");
const B = mint("note-b");
const C = mint("note-c");

async function call(method, token, body) {
  const res = await noteApi.fetch(new Request("http://x/api/note", {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }));
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json, cache: res.headers.get("cache-control") };
}
const get = (token) => call("GET", token);
const put = (token, items) => call("PUT", token, { items });
// Postgres keeps jsonb keys in its own order, so items compare by content.
const norm = (v) => Array.isArray(v) ? v.map((it) => (it && typeof it === "object" ? Object.fromEntries(Object.entries(it).sort()) : it)) : v;
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const stored = async (user) => (await db`select items from notes where user_id = ${user}`)[0]?.items ?? null;

const { check, finish } = createChecks();
await db`delete from notes where user_id like 'note-%'`;
await db`delete from members where user_id like 'note-%'`;
await db`insert into members (user_id, role) values ('note-c', 'blocked')`;

// ---- who may ----
let r = await get(null);
check("GET without a token: 401", r.status === 401, r);
r = await put(null, []);
check("PUT without a token: 401", r.status === 401, r);
r = await call("GET", "not.a.token");
check("GET with a bad token: 401", r.status === 401, r);
r = await get(C);
check("a blocked account can't read a note: 403", r.status === 403, r);
r = await put(C, [{ id: "1", text: "x", done: false }]);
check("...nor write one", r.status === 403 && (await stored("note-c")) === null, r);
for (const method of ["POST", "DELETE", "PATCH"]) {
  r = await call(method, A, { items: [] });
  check(`${method}: 405`, r.status === 405, r);
}

// ---- reading and writing your own ----
r = await get(A);
check("someone without a note yet gets an empty one", r.status === 200 && same(r.body, { items: [], updatedAt: null }), r);
check("...never stored by a shared cache", r.cache === "no-store", r.cache);

const items = [
  { id: "k1", text: "  Kaffe  ", done: false },
  { id: "k2", text: "Toiletpapir", done: true },
  { id: "k3", text: "Æg, mælk & smør – til søndag 🥚", done: false },
];
r = await put(A, items);
const clean = items.map((it) => ({ ...it, text: it.text.trim() }));
check("PUT saves the note and answers with it, text trimmed", r.status === 200 && same(r.body.items, clean) && typeof r.body.updatedAt === "string", r);
check("...also no-store", r.cache === "no-store", r.cache);
const firstSaved = r.body.updatedAt;
r = await get(A);
check("GET gives back exactly that, in that order", r.status === 200 && same(r.body.items, clean) && r.body.updatedAt === firstSaved, r);
check("...the items in their order", same(r.body.items.map((it) => it.id), ["k1", "k2", "k3"]));

r = await put(A, [{ id: "k2", text: "Toiletpapir", done: false, evil: "<script>", by: "someone else" }]);
check("a PUT replaces the whole note, keeping only id, text and done", same(r.body.items, [{ id: "k2", text: "Toiletpapir", done: false }]), r.body);
check("...and moves updatedAt on", new Date(r.body.updatedAt) >= new Date(firstSaved), r.body);

// ---- everyone has their own ----
r = await get(B);
check("another person sees their own (empty) note, not A's", same(r.body.items, []), r.body);
r = await put(B, [{ id: "b1", text: "B's ting", done: false }]);
check("B saves theirs", r.status === 200, r);
check("...and A's is untouched", same((await get(A)).body.items, [{ id: "k2", text: "Toiletpapir", done: false }]));

// ---- what isn't a note ----
const before = await stored("note-a");
const bad = [
  ["no items array", { notItems: [] }],
  ["items not an array", { items: "Kaffe" }],
  ["an item without an id", { items: [{ text: "Kaffe", done: false }] }],
  ["two items with the same id", { items: [{ id: "x", text: "a", done: false }, { id: "x", text: "b", done: false }] }],
  ["an id longer than 40", { items: [{ id: "x".repeat(41), text: "a", done: false }] }],
  ["an empty item", { items: [{ id: "x", text: "   ", done: false }] }],
  ["an item longer than 200", { items: [{ id: "x", text: "a".repeat(201), done: false }] }],
  ["done that isn't true/false", { items: [{ id: "x", text: "a", done: "yes" }] }],
  ["more than 100 items", { items: Array.from({ length: 101 }, (_, i) => ({ id: "i" + i, text: "p" + i, done: false })) }],
  ["an item that isn't an object", { items: [null] }],
];
for (const [what, body] of bad) {
  r = await call("PUT", A, body);
  check(`refused, 400: ${what}`, r.status === 400 && typeof r.body?.error === "string", r);
}
r = await call("PUT", A, "{not json");
check("refused, 400: a body that isn't JSON", r.status === 400, r);
check("...and none of that changed the stored note", same(await stored("note-a"), before), await stored("note-a"));

// ---- the limits themselves are allowed ----
const full = Array.from({ length: 100 }, (_, i) => ({ id: "i" + i, text: i === 0 ? "a".repeat(200) : "p" + i, done: i % 2 === 0 }));
r = await put(A, full);
check("exactly 100 items, one of exactly 200 characters, is fine", r.status === 200 && r.body.items.length === 100 && r.body.items[0].text.length === 200, r.status);
r = await put(A, []);
check("emptying the note is fine", r.status === 200 && same(r.body.items, []) && same((await get(A)).body.items, []), r);

await db`delete from notes where user_id like 'note-%'`;
await db`delete from members where user_id like 'note-%'`;
await db.end();
jwks.close();
finish();
