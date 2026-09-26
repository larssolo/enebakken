// End-to-end API tests for the invite auto-login feature, against the real
// bundled route handlers (see servers/invite-server.mjs) and a mock Neon Auth
// upstream. Covers: fresh invite auto-login, resend refreshing a stale
// unredeemed provisioning, cancel cleaning up an unredeemed account,
// an email that already has an account falling back to the classic flow,
// and the guardrails (non-owner can't invite, expired/garbage tokens).
// Also the names: a name given with the invite, and "Skift navn".
import { baseUrl, createChecks } from "../lib/harness.mjs";

const BASE = baseUrl(8940);
const { check, finish } = createChecks();

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  let body = null;
  try { body = await res.json(); } catch {}
  const setCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return { status: res.status, ok: res.ok, body, setCookie };
}
function cookiePair(setCookieHeader) {
  return setCookieHeader.split(";")[0].trim();
}

async function reset() {
  const r = await req("/__test/reset", { method: "POST" });
  return r.body.ownerId;
}
async function dbState() {
  return (await req("/__test/db")).body;
}

// Signs up a throwaway admin, promotes via the mock's direct DB access is
// not available here, so instead: sign up, then use SQL through the real
// server's own /__test endpoints is not exposed for writes — so we sign up
// the seeded owner from reset() instead. ownerId from reset() already has
// role 'owner' in members. We just need a bearer token for it: sign in.
async function signInAsOwner(ownerEmail) {
  const su = await req("/api/auth/sign-in", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ownerEmail, password: "anything" }),
  });
  const cookie = cookiePair(su.setCookie[0]);
  const tk = await req("/api/auth/token", { headers: { Cookie: cookie } });
  return { cookie, token: tk.body.token };
}

async function main() {
  await reset();
  const owner = await signInAsOwner("owner@example.com");
  check("owner sign-in worked and minted a token", !!owner.token, owner);

  // ---- 1) fresh invite auto-provisions an account + session ----
  let r = await req("/api/invites", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + owner.token },
    body: JSON.stringify({ email: "Frans@Example.com" }),
  });
  check("invite creation succeeds", r.ok && r.body.link, r);
  const inviteUrl = new URL(r.body.link);
  const token1 = inviteUrl.searchParams.get("invite");

  let state = await dbState();
  let invite = state.invites.find((i) => i.email.toLowerCase() === "frans@example.com");
  check("invite row got a provisioned account and a stored session", !!invite.provisioned_user_id && invite.has_session, invite);
  let provisionedUser = state.users.find((u) => u.id === invite.provisioned_user_id);
  check("a real neon_auth.user row was created for the invitee, with a placeholder name", provisionedUser && provisionedUser.name === "Frans", provisionedUser);

  // Redeeming as an unauthenticated visitor with just the token logs them
  // straight in — no Authorization header, no prior account action at all.
  r = await req("/api/invites/redeem", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: token1 }),
  });
  check("redeem without being signed in succeeds and reports autoLoggedIn", r.ok && r.body.autoLoggedIn === true, r);
  check("redeem sets our own eb_session cookie", r.setCookie.some((c) => c.startsWith("eb_session=")), r.setCookie);
  const eb1 = cookiePair(r.setCookie.find((c) => c.startsWith("eb_session=")));

  const tk1 = await req("/api/auth/token", { headers: { Cookie: eb1 } });
  const me1 = await req("/api/me", { headers: { Authorization: "Bearer " + (tk1.body && tk1.body.token) } });
  check("the auto-login session actually works end to end (token mint + /api/me)", me1.ok && me1.body.authenticated && me1.body.email === "frans@example.com", me1.body);

  state = await dbState();
  const memberRow = state.members.find((m) => m.user_id === invite.provisioned_user_id);
  check("redeeming created a members row with role 'member'", memberRow && memberRow.role === "member", memberRow);
  invite = state.invites.find((i) => i.id === invite.id);
  check("the invite is marked accepted and its stored session is cleared", invite.accepted && !invite.has_session, invite);

  r = await req("/api/invites/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token1 }) });
  check("redeeming the same token twice fails (already accepted)", !r.ok, r);

  // ---- 2) resend of a still-pending, never-redeemed invite restarts it fresh ----
  r = await req("/api/invites", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + owner.token },
    body: JSON.stringify({ email: "carl@example.com" }),
  });
  const tokenCarl1 = new URL(r.body.link).searchParams.get("invite");
  let stateCarl = await dbState();
  const carlInvite1 = stateCarl.invites.find((i) => i.email === "carl@example.com");
  const carlUser1 = carlInvite1.provisioned_user_id;

  r = await req("/api/invites", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + owner.token },
    body: JSON.stringify({ email: "carl@example.com" }),
  });
  const tokenCarl2 = new URL(r.body.link).searchParams.get("invite");
  check("resend returns a different token", tokenCarl2 !== tokenCarl1, { tokenCarl1, tokenCarl2 });

  stateCarl = await dbState();
  const carlInvite2 = stateCarl.invites.find((i) => i.email === "carl@example.com");
  check("resend re-provisioned a fresh account (different user id)", carlInvite2.provisioned_user_id !== carlUser1, { before: carlUser1, after: carlInvite2.provisioned_user_id });
  check("the old provisioned account no longer exists", !stateCarl.users.some((u) => u.id === carlUser1), stateCarl.users);
  check("exactly one carl account exists (not orphaned duplicates)", stateCarl.users.filter((u) => u.email === "carl@example.com").length === 1, stateCarl.users);

  r = await req("/api/invites/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: tokenCarl1 }) });
  check("the OLD (pre-resend) link no longer works at all", !r.ok, r);
  r = await req("/api/invites/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: tokenCarl2 }) });
  check("the NEW (post-resend) link auto-logs in", r.ok && r.body.autoLoggedIn, r);

  // ---- 3) cancelling a never-redeemed invite deletes its provisioned account ----
  r = await req("/api/invites", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + owner.token },
    body: JSON.stringify({ email: "dana@example.com" }),
  });
  let stateDana = await dbState();
  const danaInvite = stateDana.invites.find((i) => i.email === "dana@example.com");
  check("dana got a provisioned account", !!danaInvite.provisioned_user_id, danaInvite);

  r = await req("/api/invites", {
    method: "DELETE", headers: { "Content-Type": "application/json", Authorization: "Bearer " + owner.token },
    body: JSON.stringify({ id: danaInvite.id }),
  });
  check("cancelling the invite succeeds", r.ok, r);
  stateDana = await dbState();
  check("the invite row is gone", !stateDana.invites.some((i) => i.id === danaInvite.id), stateDana.invites);
  check("...and the never-redeemed account it made is gone too, not left behind with an unknown password", !stateDana.users.some((u) => u.id === danaInvite.provisioned_user_id), stateDana.users);

  // ---- 4) an email that already has an account falls back to the classic flow ----
  const evaSignUp = await req("/api/auth/sign-up", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "eva@example.com", password: "correcthorsebatterystaple", name: "Eva Existing" }),
  });
  const evaCookie = cookiePair(evaSignUp.setCookie.find((c) => c.startsWith("eb_session=")));

  r = await req("/api/invites", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + owner.token },
    body: JSON.stringify({ email: "eva@example.com" }),
  });
  let stateEva = await dbState();
  const evaInvite = stateEva.invites.find((i) => i.email === "eva@example.com");
  check("inviting an email that already has an account provisions nothing new", evaInvite.provisioned_user_id === null && !evaInvite.has_session, evaInvite);

  const tokenEva = new URL(r.body.link).searchParams.get("invite");
  r = await req("/api/invites/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: tokenEva }) });
  check("redeeming it while signed out (no session to auto-login with) is refused, not silently accepted", !r.ok && !r.body.autoLoggedIn, r);

  const evaTok = await req("/api/auth/token", { headers: { Cookie: evaCookie } });
  r = await req("/api/invites/redeem", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + evaTok.body.token },
    body: JSON.stringify({ token: tokenEva }),
  });
  check("...but redeeming it once actually signed in under that same email still works (classic path preserved)", r.ok && !r.body.autoLoggedIn, r);

  // ---- 5) guardrails ----
  r = await req("/api/invites", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "noauth@example.com" }),
  });
  check("creating an invite with no auth at all is refused", r.status === 401, r);

  r = await req("/api/invites/redeem", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "not-a-real-token" }),
  });
  check("redeeming a garbage token is refused", !r.ok, r);

  // ---- 6) the admin list marks an invited account nobody has used yet ----
  r = await req("/api/invites", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + owner.token },
    body: JSON.stringify({ email: "gina@example.com" }),
  });
  const tokenGina = new URL(r.body.link).searchParams.get("invite");
  let members = await req("/api/members", { headers: { Authorization: "Bearer " + owner.token } });
  let gina = members.body.items.find((m) => m.email === "gina@example.com");
  check("an invited, not-yet-used account is flagged invite_pending in the member list", gina && gina.invite_pending === true, gina);
  const franz = members.body.items.find((m) => m.email === "frans@example.com");
  check("...while an account whose invite was used is not", franz && franz.invite_pending === false, franz);
  r = await req("/api/invites/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: tokenGina }) });
  members = await req("/api/members", { headers: { Authorization: "Bearer " + owner.token } });
  gina = members.body.items.find((m) => m.email === "gina@example.com");
  check("...and the flag clears as soon as the link is used", r.ok && gina && gina.invite_pending === false, gina);

  // ---- 7) deleting an invited account before its link is used withdraws the invite ----
  r = await req("/api/invites", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + owner.token },
    body: JSON.stringify({ email: "hans@example.com" }),
  });
  const tokenHans = new URL(r.body.link).searchParams.get("invite");
  members = await req("/api/members", { headers: { Authorization: "Bearer " + owner.token } });
  const hans = members.body.items.find((m) => m.email === "hans@example.com");
  r = await req("/api/members", {
    method: "DELETE", headers: { "Content-Type": "application/json", Authorization: "Bearer " + owner.token },
    body: JSON.stringify({ userId: hans.user_id }),
  });
  check("deleting the invited account via the admin list works", r.ok, r);
  const pendingAfter = await req("/api/invites", { headers: { Authorization: "Bearer " + owner.token } });
  check("...and its pending invite disappears with it", !pendingAfter.body.items.some((i) => i.email === "hans@example.com"), pendingAfter.body.items);
  r = await req("/api/invites/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: tokenHans }) });
  check("...so the old link no longer claims to log anyone in", !r.ok && !(r.body && r.body.autoLoggedIn), r);

  // ---- 8) redeem never reports a login when the account is gone (bypassing the app) ----
  r = await req("/api/invites", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + owner.token },
    body: JSON.stringify({ email: "ida@example.com" }),
  });
  const tokenIda = new URL(r.body.link).searchParams.get("invite");
  const idaInvite = (await dbState()).invites.find((i) => i.email === "ida@example.com");
  await req("/__test/drop-user?id=" + encodeURIComponent(idaInvite.provisioned_user_id));
  r = await req("/api/invites/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: tokenIda }) });
  check("redeeming an invite whose account vanished is refused with a clear message", r.status === 400 && /ikke længere gyldig/.test(r.body.error), r);
  check("...and sets no session cookie", !r.setCookie.some((c) => c.startsWith("eb_session=")), r.setCookie);

  // ---- 9) signing up with an email that already has an account explains what to do ----
  r = await req("/api/auth/sign-up", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "gina@example.com", password: "somethinglong", name: "Gina" }),
  });
  check("sign-up for an existing email says to use the invite link or 'Glemt adgangskode'", r.status === 409 && /invitationen/.test(r.body.error) && /Glemt adgangskode/.test(r.body.error), r.body);

  await nameTests();
  finish();
}

// ---- names: given with the invite, and changed by the person themselves ----
async function nameTests() {
  await reset();
  const owner = await signInAsOwner("owner@example.com");
  const invite = (body) => req("/api/invites", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + owner.token },
    body: JSON.stringify(body),
  });
  const userByEmail = async (email) => (await dbState()).users.find((u) => u.email === email);

  let r = await invite({ email: "joan.falk6@example.com", name: "  Joan   Falk  " });
  check("invite with a name: the account is created under that name (spaces tidied)", r.ok && (await userByEmail("joan.falk6@example.com"))?.name === "Joan Falk", await userByEmail("joan.falk6@example.com"));
  r = await invite({ email: "per.olsen2@example.com" });
  check("invite without a name still falls back to one made from the e-mail", r.ok && (await userByEmail("per.olsen2@example.com"))?.name === "Per Olsen2", await userByEmail("per.olsen2@example.com"));
  r = await invite({ email: "blank@example.com", name: "   " });
  check("a blank name counts as no name", r.ok && (await userByEmail("blank@example.com"))?.name === "Blank", await userByEmail("blank@example.com"));
  r = await invite({ email: "long@example.com", name: "x".repeat(101) });
  check("a name over 100 characters is refused, and no account is made", r.status === 400 && /100 tegn/.test(r.body.error) && !(await userByEmail("long@example.com")), r);
  r = await invite({ email: "hundred@example.com", name: "x".repeat(100) });
  check("exactly 100 characters is fine", r.ok && (await userByEmail("hundred@example.com"))?.name === "x".repeat(100), r);

  // A resend with a new name restarts a never-used invite under that name;
  // a resend for an account that's in use never renames it.
  r = await invite({ email: "per.olsen2@example.com", name: "Per Olsen" });
  check("resending a never-used invite with a name re-creates the account under it", r.ok && (await userByEmail("per.olsen2@example.com"))?.name === "Per Olsen", await userByEmail("per.olsen2@example.com"));
  r = await invite({ email: "owner@example.com", name: "Someone Else" });
  check("inviting an existing account with a name leaves its name alone", r.ok && (await userByEmail("owner@example.com"))?.name === "Owner Admin", await userByEmail("owner@example.com"));

  // ---- "Skift navn": PATCH /api/me ----
  const tokenFor = async (cookie) => (await req("/api/auth/token", { headers: { Cookie: cookie } })).body.token;
  const rename = (cookie, token, body) => req("/api/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const joanToken = new URL((await invite({ email: "joan.falk6@example.com", name: "Joan Falk" })).body.link).searchParams.get("invite");
  r = await req("/api/invites/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: joanToken }) });
  const joan = cookiePair(r.setCookie.find((c) => c.startsWith("eb_session=")));
  let joanJwt = await tokenFor(joan);
  const joanId = (await userByEmail("joan.falk6@example.com")).id;

  r = await rename(null, null, { name: "Joan" });
  check("PATCH /api/me signed out: 401", r.status === 401, r);
  r = await rename(null, joanJwt, { name: "Joan" });
  check("...with a token but no session cookie: 401", r.status === 401, r);
  r = await rename(joan, joanJwt, { name: "   " });
  check("an empty name is refused", r.status === 400 && r.body.error === "Skriv dit navn", r);
  r = await rename(joan, joanJwt, {});
  check("a missing name is refused", r.status === 400, r);
  r = await rename(joan, joanJwt, "not json");
  check("a body that isn't JSON is refused, not a 500", r.status === 400, r);
  r = await rename(joan, joanJwt, { name: 42 });
  check("a name that isn't text is refused", r.status === 400, r);
  r = await rename(joan, joanJwt, { name: "y".repeat(101) });
  check("a name over 100 characters is refused", r.status === 400 && /100 tegn/.test(r.body.error), r);
  check("...and none of the refused attempts changed anything", (await userByEmail("joan.falk6@example.com")).name === "Joan Falk");

  // The token and the session cookie must be the same person: a token
  // left over from someone else can't rename this session's account, or
  // write onto the other person's members row.
  r = await rename(joan, owner.token, { name: "Hijack" });
  check("a token from another person than the session is refused", r.status === 401, r);
  const s = await dbState();
  check("...and neither account nor members row changed", s.users.find((u) => u.id === joanId).name === "Joan Falk" && s.users.find((u) => u.email === "owner@example.com").name === "Owner Admin" && !s.members.some((m) => m.display_name === "Hijack"), s);

  await req("/__test/fail-update-user?on=1");
  r = await rename(joan, joanJwt, { name: "Joan Upstream" });
  await req("/__test/fail-update-user?on=0");
  check("when Neon Auth refuses the change: 502 and a clear message", r.status === 502 && /Kunne ikke gemme navnet/.test(r.body.error), r);
  check("...and the members row wasn't changed on its own", !(await dbState()).members.some((m) => m.display_name === "Joan Upstream"));

  r = await rename(joan, joanJwt, { name: "  Joan \t Sofie\n Falk " });
  check("a valid rename succeeds and returns the name with its spaces tidied", r.ok && r.body.name === "Joan Sofie Falk", r);
  check("...the account itself is renamed", (await userByEmail("joan.falk6@example.com")).name === "Joan Sofie Falk");
  check("...her members row carries the new name too", (await dbState()).members.find((m) => m.user_id === joanId)?.display_name === "Joan Sofie Falk");
  joanJwt = await tokenFor(joan);
  const me = await req("/api/me", { headers: { Authorization: "Bearer " + joanJwt } });
  check("...and a fresh token (so /api/me and her ticks) carries the new name", me.body.name === "Joan Sofie Falk", me.body);
  const list = await req("/api/members", { headers: { Authorization: "Bearer " + owner.token } });
  const row = list.body.items.find((m) => m.user_id === joanId);
  check("...and the administrator's user list shows it", row && row.display_name === "Joan Sofie Falk", row);

  // Someone without a members row (signed up themselves) can rename too.
  r = await req("/api/auth/sign-up", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "solo@example.com", password: "longenoughpw", name: "Solo" }) });
  const solo = cookiePair(r.setCookie.find((c) => c.startsWith("eb_session=")));
  r = await rename(solo, await tokenFor(solo), { name: "Solo Hansen" });
  check("an account without a members row can rename itself", r.ok && (await userByEmail("solo@example.com")).name === "Solo Hansen", r);
  const soloId = (await userByEmail("solo@example.com")).id;
  check("...without a members row being created for it", !(await dbState()).members.some((m) => m.user_id === soloId));

  r = await req("/api/me", { method: "DELETE", headers: { Authorization: "Bearer " + joanJwt } });
  check("other methods on /api/me: 405", r.status === 405, r);
}

main().catch((e) => { console.error(e); process.exit(1); });
