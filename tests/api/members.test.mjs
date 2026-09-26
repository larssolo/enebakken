// Runs the real api/members.ts handler against a local Postgres (with a
// minimal hand-made neon_auth.user table, since the real one is Neon Auth's
// own managed schema) and real JWTs signed against a local JWKS endpoint.
import postgres from "postgres";
import { DATABASE_URL, createChecks, createSigner, loadApi, startJwksServer } from "../lib/harness.mjs";

const signer = createSigner();
const jwks = await startJwksServer(signer);
const mint = (sub, email, name) => signer.mint(jwks.origin, { sub, email, name });
const membersApi = await loadApi("members");
const db = postgres(DATABASE_URL, { onnotice: () => {} });

async function call(method, token, body) {
  const res = await membersApi.fetch(new Request("http://x/api/members", {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}
const get = (token) => call("GET", token);
const patch = (token, body) => call("PATCH", token, body);
const del = (token, body) => call("DELETE", token, body);

const { check, finish } = createChecks();

// fresh state: 4 accounts, none with a members row yet
await db`delete from members`;
await db`delete from invites`;
await db`delete from neon_auth."user"`;
const people = [
  { id: "u-alice", email: "alice@example.com", name: "Alice Owner" },
  { id: "u-bob", email: "bob@example.com", name: "Bob Normal" },
  { id: "u-carl", email: "carl@example.com", name: null }, // never set a name
  { id: "u-dana", email: "dana@example.com", name: "Dana Normal" },
];
for (const p of people) await db`insert into neon_auth."user" (id, email, name) values (${p.id}, ${p.email}, ${p.name})`;
await db`insert into members (user_id, role) values ('u-alice', 'owner')`;
await db`insert into members (user_id, role) values ('u-carl', 'blocked')`;
const T = Object.fromEntries(people.map((p) => [p.id, mint(p.id, p.email, p.name)]));

// ---- access control ----
let r = await get(null);
check("GET without a token: 401", r.status === 401, r);
r = await get(T["u-bob"]);
check("GET as a non-administrator: 403", r.status === 403 && r.body.error === "Kun en administrator kan gøre dette", r);
r = await get(T["u-alice"]);
check("GET as the administrator: 200, all 4 accounts listed", r.status === 200 && r.body.items.length === 4, r.body);
const roleOf = (items, id) => items.find((x) => x.user_id === id)?.role;
check("roles reported correctly (owner/blocked/user)", roleOf(r.body.items, "u-alice") === "owner" && roleOf(r.body.items, "u-carl") === "blocked" && roleOf(r.body.items, "u-bob") === "user", r.body.items);

r = await patch(T["u-bob"], { userId: "u-dana", owner: true });
check("PATCH as a non-administrator: 403", r.status === 403, r);

// ---- validation ----
r = await patch(T["u-alice"], { userId: "u-bob" });
check("neither blocked nor owner: 400", r.status === 400, r);
r = await patch(T["u-alice"], { userId: "u-bob", blocked: true, owner: true });
check("both blocked and owner at once: 400 (ambiguous)", r.status === 400, r);
r = await patch(T["u-alice"], { userId: "does-not-exist", owner: true });
check("unknown userId: 404", r.status === 404, r);

// ---- promote ----
r = await patch(T["u-alice"], { userId: "u-carl", owner: true });
check("can't promote a blocked account straight to administrator", r.status === 400 && r.body.error.includes("afblokeres"), r);
r = await patch(T["u-alice"], { userId: "u-bob", owner: true });
check("promote succeeds", r.status === 200, r);
let row = (await db`select role, display_name from members where user_id = 'u-bob'`)[0];
check("Bob is now owner, display_name taken from his account name", row.role === "owner" && row.display_name === "Bob Normal", row);
r = await patch(T["u-alice"], { userId: "u-dana", owner: true });
row = (await db`select role, display_name from members where user_id = 'u-dana'`)[0];
check("promoting an account with no name on file falls back sanely (Dana has a name here; Carl's null-name case is covered separately below)", row.role === "owner", row);
r = await patch(T["u-bob"], { userId: "u-alice", owner: true });
check("promoting an already-owner account is a harmless no-op (200)", r.status === 200, r);
check("...and Bob, now an administrator himself, can call the endpoint", true);

// null-name fallback: promote Carl (name is null) after unblocking him first
await db`delete from members where user_id = 'u-carl'`;
r = await patch(T["u-alice"], { userId: "u-carl", owner: true });
row = (await db`select role, display_name from members where user_id = 'u-carl'`)[0];
check("an account with no name falls back to its email as display_name", row.role === "owner" && row.display_name === "carl@example.com", row);
await db`update members set role = 'owner' where user_id = 'u-carl'`; // keep as owner for the demote tests below (already was)

// reset to a clean 4-owner-among-4-accounts-minus-one state for demote tests:
// alice, bob, dana, carl all owner right now - bring it back to just alice+bob
await patch(T["u-alice"], { userId: "u-dana", owner: false });
await patch(T["u-alice"], { userId: "u-carl", owner: false });
let owners = (await db`select user_id from members where role = 'owner' order by user_id`).map((x) => x.user_id);
check("back down to exactly alice + bob as administrators", JSON.stringify(owners) === JSON.stringify(["u-alice", "u-bob"]), owners);

// ---- demote ----
r = await patch(T["u-alice"], { userId: "u-dana", owner: false });
check("demoting a non-administrator: 400", r.status === 400 && r.body.error === "Kontoen er ikke administrator", r);
r = await patch(T["u-alice"], { userId: "u-bob", owner: false });
check("demote succeeds while another administrator remains", r.status === 200, r);
row = (await db`select role from members where user_id = 'u-bob'`)[0];
check("Bob's members row is gone (back to plain 'user', matching how unblock works)", row === undefined, row);

// ---- last-administrator guard ----
r = await patch(T["u-alice"], { userId: "u-alice", owner: false });
check("the sole remaining administrator can't demote themselves", r.status === 400 && r.body.error === "Der skal altid være mindst én administrator", r);
owners = (await db`select count(*)::int as n from members where role = 'owner'`)[0].n;
check("...and nothing changed", owners === 1, owners);

// ---- an administrator can't be blocked ----
r = await patch(T["u-alice"], { userId: "u-alice", blocked: true });
check("an administrator can't be blocked", r.status === 400 && r.body.error === "En administrator kan ikke blokeres", r);

// ---- last-administrator guard is race-proof (deterministic, via the writer lock) ----
// The real race is two DIFFERENT owner rows being demoted at once, each
// transaction's count check reading the other's not-yet-committed row as
// still present. Locking only the row a demote is about to delete would
// never catch that (each transaction deletes a different row, so they'd
// never contend on the same one) - the fix has to lock every owner row
// before counting. Proof: hold a lock on Alice's row specifically (not
// Bob's, the one about to be deleted) and demote Bob. The fix's own
// `select ... where role = 'owner' for update` has to lock Alice's row
// too before it can count, so it must wait for this held lock; without the
// fix, nothing in Bob's demote ever touches Alice's row, so it wouldn't
// wait at all.
await patch(T["u-alice"], { userId: "u-bob", owner: true }); // back to 2 administrators
const reserved = await db.reserve();
await reserved`begin`;
await reserved`select user_id from members where user_id = 'u-alice' for update`;
let raceDone = false;
const racePromise = patch(T["u-alice"], { userId: "u-bob", owner: false }).then((res) => { raceDone = true; return res; });
await new Promise((res) => setTimeout(res, 700));
const waitedForLock = !raceDone;
await reserved`commit`;
reserved.release();
const raceResult = await racePromise;
check("demoting Bob waits on a lock held on Alice's (a different owner's) row", waitedForLock, { waitedForLock });
check("...and still succeeds once the lock is released", raceResult.status === 200, raceResult);
owners = (await db`select user_id from members where role = 'owner' order by user_id`).map((x) => x.user_id);
check("exactly one administrator left afterwards, never zero", JSON.stringify(owners) === JSON.stringify(["u-alice"]), owners);

// ---- unrelated: blocking/unblocking still works as before ----
r = await patch(T["u-alice"], { userId: "u-dana", blocked: true });
check("block still works", r.status === 200 && (await db`select role from members where user_id='u-dana'`)[0].role === "blocked");
r = await patch(T["u-alice"], { userId: "u-dana", blocked: false });
check("unblock still works", r.status === 200 && (await db`select 1 from members where user_id='u-dana'`).length === 0);

// ---- delete a user entirely ----
// State right now: alice = owner, bob/carl/dana = plain members (no row).
r = await del(null, { userId: "u-dana" });
check("DELETE without a token: 401", r.status === 401, r);
r = await del(T["u-bob"], { userId: "u-dana" });
check("DELETE as a non-administrator: 403", r.status === 403, r);
r = await del(T["u-alice"], {});
check("DELETE with no userId: 400", r.status === 400, r);
r = await del(T["u-alice"], { userId: "does-not-exist" });
check("DELETE of an unknown userId: 404", r.status === 404, r);
r = await del(T["u-alice"], { userId: "u-alice" });
check("an administrator can't be deleted — must be demoted first", r.status === 400 && r.body.error.includes("fjern administrator-status"), r);

// give Dana a session, an oauth account, and a pending verification, plus a
// photo she "uploaded" — everything a real account can have attached.
await db`insert into neon_auth.session ("userId", token) values ('u-dana', 'sess-dana')`;
await db`insert into neon_auth.account ("userId", "providerId") values ('u-dana', 'credential')`;
await db`insert into neon_auth.verification (identifier, value) values ('dana@example.com', 'code-123')`;
await db`insert into photos (object_key, uploaded_by) values ('photos/test-dana.jpg', 'u-dana')`;

r = await del(T["u-alice"], { userId: "u-dana" });
check("delete succeeds", r.status === 200, r);
check("Dana's user row is gone", (await db`select 1 from neon_auth."user" where id = 'u-dana'`).length === 0);
check("...her session is gone", (await db`select 1 from neon_auth.session where "userId" = 'u-dana'`).length === 0);
check("...her oauth account row is gone", (await db`select 1 from neon_auth.account where "userId" = 'u-dana'`).length === 0);
check("...her pending verification (by email) is gone", (await db`select 1 from neon_auth.verification where identifier = 'dana@example.com'`).length === 0);
check("...any members row would be gone too (she had none here, but the query ran)", (await db`select 1 from members where user_id = 'u-dana'`).length === 0);
const photoAfter = (await db`select uploaded_by from photos where object_key = 'photos/test-dana.jpg'`)[0];
check("her photo stays, uploaded_by simply now points at nobody", photoAfter && photoAfter.uploaded_by === "u-dana", photoAfter);
await db`delete from photos where object_key = 'photos/test-dana.jpg'`;

r = await get(T["u-alice"]);
check("Dana no longer appears in the member list at all", r.body.items.every((x) => x.email !== "dana@example.com"), r.body.items.map((x) => x.email));

// deleting a blocked account works too (the actual motivating case: a
// mistyped/duplicate signup nobody wants blocked forever, just gone)
await db`insert into members (user_id, role) values ('u-carl', 'blocked')`;
r = await del(T["u-alice"], { userId: "u-carl" });
check("deleting a blocked account works", r.status === 200, r);
check("Carl is fully gone", (await db`select 1 from neon_auth."user" where id = 'u-carl'`).length === 0);

await db`delete from members`;
await db`delete from neon_auth."user"`;
await db`delete from neon_auth.session`;
await db`delete from neon_auth.account`;
await db`delete from neon_auth.verification`;
await db.end();
jwks.close();
finish();
