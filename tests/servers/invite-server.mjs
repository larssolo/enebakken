// Local stand-in for the site, to exercise the invite auto-login feature
// end to end against the REAL bundled route handlers (invites, redeem,
// members, me, sign-up, sign-in, token) and a mock Neon Auth upstream that
// implements just enough of sign-up/email, sign-in/email, /token, and the
// JWKS endpoint to make the real verifyToken()/authenticate() code path
// work unmodified. Everything else in the request pipeline is the actual
// shipped code — only the "Neon Auth" server itself is faked.
import http from "node:http";
import crypto from "node:crypto";
import postgres from "postgres";
import { DATABASE_URL, createSigner, loadApi, relay, sendJson as send, serveStatic } from "../lib/harness.mjs";

const PORT = Number(process.env.PORT || 8940);
const ORIGIN = `http://localhost:${PORT}`;
process.env.NEON_AUTH_BASE_URL = `${ORIGIN}/neondb/auth`;

const signer = createSigner();
const mint = (sub, email, name) => signer.mint(ORIGIN, { sub, email, name });

const db = postgres(DATABASE_URL, { onnotice: () => {} });

async function resetDb() {
  await db`delete from members`;
  await db`delete from invites`;
  await db`delete from neon_auth.session`;
  await db`delete from neon_auth.account`;
  await db`delete from neon_auth.verification`;
  await db`delete from neon_auth."user"`;
  const ownerId = crypto.randomUUID();
  await db`insert into neon_auth."user" (id, email, name) values (${ownerId}, 'owner@example.com', 'Owner Admin')`;
  await db`insert into members (user_id, role) values (${ownerId}, 'owner')`;
  return ownerId;
}
let OWNER_ID = await resetDb();
let failUpdateUser = false;

const routeApis = {
  invites: await loadApi("invites/index"),
  redeem: await loadApi("invites/redeem"),
  members: await loadApi("members"),
  me: await loadApi("me"),
  "sign-up": await loadApi("auth/sign-up"),
  "sign-in": await loadApi("auth/sign-in"),
  "sign-out": await loadApi("auth/sign-out"),
  token: await loadApi("auth/token"),
};
const proxyToReal = (api, req, res) => relay(api, ORIGIN, req, res);

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { resolve({}); }
    });
  });
}
http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;

  // Makes the next update-user calls fail upstream, to test that nothing
  // is changed on our side when Neon Auth refuses.
  if (p === "/__test/fail-update-user") {
    failUpdateUser = url.searchParams.get("on") === "1";
    return send(res, 200, { failUpdateUser });
  }
  if (p === "/__test/reset") {
    failUpdateUser = false;
    OWNER_ID = await resetDb();
    return send(res, 200, { ok: true, ownerId: OWNER_ID });
  }
  // Removes an account straight from the database, bypassing the app, to
  // test how an invite behaves when the account it made is simply gone.
  if (p === "/__test/drop-user") {
    const id = url.searchParams.get("id");
    await db`delete from neon_auth.session where "userId" = ${id}`;
    await db`delete from neon_auth."user" where id = ${id}`;
    return send(res, 200, { ok: true });
  }
  if (p === "/__test/db") {
    const [invites, users, members] = await Promise.all([
      db`select id, email, provisioned_user_id, session_cookie is not null as has_session, accepted_at is not null as accepted from invites`,
      db`select id, email, name from neon_auth."user"`,
      db`select user_id, role, display_name from members`,
    ]);
    return send(res, 200, { invites, users, members });
  }

  // ---- mock Neon Auth upstream ----
  if (p === "/neondb/auth/.well-known/jwks.json") return send(res, 200, signer.jwks);
  if (p === "/neondb/auth/sign-up/email" && req.method === "POST") {
    const { email, password, name } = await readBody(req);
    const existing = await db`select id from neon_auth."user" where email = ${email}`;
    if (existing.length > 0) return send(res, 422, { code: "USER_ALREADY_EXISTS" });
    const id = crypto.randomUUID();
    await db`insert into neon_auth."user" (id, email, name) values (${id}, ${email}, ${name || email})`;
    const token = crypto.randomBytes(16).toString("hex");
    await db`insert into neon_auth.session ("userId", token) values (${id}, ${token})`;
    return send(res, 200, { user: { id, email } }, { "Set-Cookie": `mock_session=${token}; Path=/; HttpOnly` });
  }
  if (p === "/neondb/auth/sign-in/email" && req.method === "POST") {
    const { email } = await readBody(req);
    const rows = await db`select id from neon_auth."user" where email = ${email}`;
    if (rows.length === 0) return send(res, 401, { code: "INVALID_CREDENTIALS" });
    const token = crypto.randomBytes(16).toString("hex");
    await db`insert into neon_auth.session ("userId", token) values (${rows[0].id}, ${token})`;
    return send(res, 200, { user: { email } }, { "Set-Cookie": `mock_session=${token}; Path=/; HttpOnly` });
  }
  if (p === "/neondb/auth/sign-out" && req.method === "POST") {
    const m = /(?:^|;\s*)mock_session=([^;]+)/.exec(req.headers.cookie || "");
    if (m) await db`delete from neon_auth.session where token = ${m[1]}`;
    return send(res, 200, { success: true });
  }
  // Better Auth's update-user: changes the session owner's name.
  if (p === "/neondb/auth/update-user" && req.method === "POST") {
    const m = /(?:^|;\s*)mock_session=([^;]+)/.exec(req.headers.cookie || "");
    const rows = m ? await db`select "userId" from neon_auth.session where token = ${m[1]}` : [];
    if (rows.length === 0) return send(res, 401, { code: "UNAUTHORIZED" });
    const { name } = await readBody(req);
    if (failUpdateUser) return send(res, 500, { code: "INTERNAL" });
    await db`update neon_auth."user" set name = ${name} where id = ${rows[0].userId}`;
    return send(res, 200, { status: true });
  }
  if (p === "/neondb/auth/token") {
    const pair = req.headers.cookie || "";
    const m = /(?:^|;\s*)mock_session=([^;]+)/.exec(pair);
    if (!m) return send(res, 401, { error: "no session" });
    const rows = await db`select u.id, u.email, u.name from neon_auth.session s join neon_auth."user" u on u.id = s."userId" where s.token = ${m[1]}`;
    if (rows.length === 0) return send(res, 401, { error: "unknown session" });
    return send(res, 200, { token: mint(rows[0].id, rows[0].email, rows[0].name) });
  }

  // ---- real routes, bundled from the repo's actual api/ files ----
  if (p === "/api/invites/redeem") return proxyToReal(routeApis.redeem, req, res);
  if (p === "/api/invites") return proxyToReal(routeApis.invites, req, res);
  if (p === "/api/members") return proxyToReal(routeApis.members, req, res);
  if (p === "/api/me") return proxyToReal(routeApis.me, req, res);
  if (p === "/api/auth/sign-up") return proxyToReal(routeApis["sign-up"], req, res);
  if (p === "/api/auth/sign-in") return proxyToReal(routeApis["sign-in"], req, res);
  if (p === "/api/auth/token") return proxyToReal(routeApis.token, req, res);
  if (p === "/api/auth/sign-out") return proxyToReal(routeApis["sign-out"], req, res);
  if (p === "/api/checklist") return send(res, 200, { items: [] });
  if (p === "/api/photos") {
    // Two cards: one uploaded by eva (when she exists), one by somebody
    // else — enough to see whose delete buttons show up for whom.
    const eva = (await db`select id from neon_auth."user" where email = 'existing.eva@example.com'`)[0];
    const dot = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    return send(res, 200, {
      items: [
        { id: "2", caption: "Evas billede", uploaded_by: eva ? eva.id : "nobody", created_at: new Date().toISOString(), url: dot },
        { id: "1", caption: "En andens billede", uploaded_by: "someone-else", created_at: new Date().toISOString(), url: dot },
      ],
      nextCursor: null,
    });
  }

  if (await serveStatic(p, res)) return;
  res.writeHead(404);
  res.end("not found");
}).listen(PORT, () => console.log(`invite test server on ${ORIGIN}, owner ${OWNER_ID}`));
