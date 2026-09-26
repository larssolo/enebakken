// Local stand-in for the site, for browser tests of the admin panel's
// promote/demote feature: the real page and the REAL /api/members handler
// (bundled from the repo) on local Postgres. Sign-in is faked the same way
// as ticks-server.mjs: cookie eb_test_user=<id> is the session, and
// /api/auth/token mints a real JWT for it against a local JWKS endpoint.
import http from "node:http";
import postgres from "postgres";
import { DATABASE_URL, createSigner, loadApi, relay, sendJson as send, serveStatic } from "../lib/harness.mjs";

const PORT = Number(process.env.PORT || 8936);
const ORIGIN = `http://localhost:${PORT}`;
process.env.NEON_AUTH_BASE_URL = `${ORIGIN}/neondb/auth`;

const signer = createSigner();
const USERS = {
  "u-alice": { name: "Alice Owner", email: "alice@example.com" },
  "u-bob": { name: "Bob Normal", email: "bob@example.com" },
  "u-carl": { name: "Carl Blocked", email: "carl@example.com" },
  "u-dana": { name: "Dana Normal", email: "dana@example.com" },
};
const mint = (sub) => signer.mint(ORIGIN, { sub, ...USERS[sub] });

const db = postgres(DATABASE_URL, { onnotice: () => {} });
await db`delete from members`;
await db`delete from invites`;
await db`delete from neon_auth."user"`;
for (const [id, u] of Object.entries(USERS)) await db`insert into neon_auth."user" (id, email, name) values (${id}, ${u.email}, ${u.name})`;
await db`insert into members (user_id, role) values ('u-alice', 'owner')`;
await db`insert into members (user_id, role) values ('u-carl', 'blocked')`;

const membersApi = await loadApi("members");

const cookieUser = (req) => {
  const m = /(?:^|;\s*)eb_test_user=([^;]+)/.exec(req.headers.cookie || "");
  return m && USERS[m[1]] ? m[1] : null;
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;
  if (p === "/__test/reset") {
    await db`delete from members`;
    await db`insert into members (user_id, role) values ('u-alice', 'owner')`;
    await db`insert into members (user_id, role) values ('u-carl', 'blocked')`;
    return send(res, 200, { ok: true });
  }

  if (p === "/neondb/auth/.well-known/jwks.json") return send(res, 200, signer.jwks);
  if (p === "/api/auth/token") {
    const user = cookieUser(req);
    return user ? send(res, 200, { token: mint(user) }) : send(res, 401, { error: "Ikke logget ind" });
  }
  if (p === "/api/auth/sign-out") return send(res, 200, { ok: true }, { "Set-Cookie": "eb_test_user=; Path=/; Max-Age=0" });
  if (p === "/api/me") {
    const user = cookieUser(req);
    if (!user) return send(res, 200, { authenticated: false });
    const role = (await db`select role from members where user_id = ${user}`)[0]?.role ?? null;
    return send(res, 200, { authenticated: true, userId: user, email: USERS[user].email, name: USERS[user].name, role });
  }
  if (p === "/api/checklist") return send(res, 200, { items: [] });
  if (p === "/api/photos") return send(res, 200, { items: [], nextCursor: null });
  if (p === "/api/invites" && req.method === "GET") return send(res, 200, { items: [] });

  if (p === "/api/members") return relay(membersApi, ORIGIN, req, res);

  if (await serveStatic(p, res)) return;
  res.writeHead(404);
  res.end("not found");
}).listen(PORT, () => console.log(`admin test server on ${ORIGIN}`));
