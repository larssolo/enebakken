// Local stand-in for the site, for browser tests of the shared checklist:
// the page and static files from the repo, and the REAL /api/ticks,
// /api/checklist and /api/me handlers (bundled from the repo) on the local
// Postgres. Sign-in is faked: the cookie eb_test_user=<id> is the session,
// and /api/auth/token mints a JWT for it with a local Ed25519 key that the
// handlers verify through their normal JWKS path.
import http from "node:http";
import { createSigner, loadApi, relay, sendJson as send, serveStatic } from "../lib/harness.mjs";

const PORT = Number(process.env.PORT || 8935);
const ORIGIN = `http://localhost:${PORT}`;
process.env.NEON_AUTH_BASE_URL = `${ORIGIN}/neondb/auth`;

const signer = createSigner();
const USERS = {
  "user-a": { name: "Lars Sohl", email: "lars@example.com" },
  "user-b": { name: "Anna Hansen", email: "anna@example.com" },
  "user-c": { name: "Carl Berg", email: "carl@example.com" },
};
const mint = (sub) => signer.mint(ORIGIN, { sub, ...USERS[sub] });

const api = {
  "/api/ticks": await loadApi("ticks"),
  "/api/checklist": await loadApi("checklist"),
  "/api/me": await loadApi("me"),
};

let down = false;
let hits = [];
const cookieUser = (req) => {
  const m = /(?:^|;\s*)eb_test_user=([^;]+)/.exec(req.headers.cookie || "");
  return m && USERS[m[1]] ? m[1] : null;
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;
  if (p === "/__test/down") { down = url.searchParams.get("on") === "1"; return send(res, 200, { down }); }
  if (p === "/__test/hits") { const h = hits; if (url.searchParams.get("reset") === "1") hits = []; return send(res, 200, h); }
  if (down) { req.socket.destroy(); return; }
  hits.push(req.method + " " + p);

  if (p === "/neondb/auth/.well-known/jwks.json") return send(res, 200, signer.jwks);
  if (p === "/api/auth/token") {
    const user = cookieUser(req);
    return user ? send(res, 200, { token: mint(user) }) : send(res, 401, { error: "Ikke logget ind" });
  }
  if (p === "/api/auth/sign-out") return send(res, 200, { ok: true }, { "Set-Cookie": "eb_test_user=; Path=/; Max-Age=0" });
  if (p === "/api/photos") return send(res, 200, { items: [], nextCursor: null });

  if (api[p]) return relay(api[p], ORIGIN, req, res);

  if (await serveStatic(p, res)) return;
  res.writeHead(404);
  res.end("not found");
}).listen(PORT, () => console.log(`ticks test server on ${ORIGIN}`));
