// Runs the real api/auth/token.ts handler against a mock Neon Auth
// upstream whose /token response can be made to succeed, refuse (401 —
// the session itself is gone), or fail transiently (500 or a dropped
// connection), to check the handler tells those apart correctly, and that
// a successful check slides the eb_session cookie's expiry forward.
import http from "node:http";
import { createChecks, createSigner, loadApi } from "../lib/harness.mjs";

const signer = createSigner();
let mode = "ok"; // "ok" | "401" | "500" | "network" | "bad-body"

const mockAuth = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/neondb/auth/token") {
    if (mode === "401") { res.writeHead(401, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ code: "SESSION_EXPIRED" })); }
    if (mode === "500") { res.writeHead(500); return res.end("boom"); }
    if (mode === "network") { req.socket.destroy(); return; }
    if (mode === "bad-body") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ nope: true })); }
    const tok = signer.mint(ORIGIN, { sub: "user-a", email: "a@example.com", name: "A" });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ token: tok }));
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => mockAuth.listen(0, "127.0.0.1", r));
const ORIGIN = `http://localhost:${mockAuth.address().port}`;
process.env.NEON_AUTH_BASE_URL = `${ORIGIN}/neondb/auth`;

const tokenApi = await loadApi("auth/token");

async function call(cookie) {
  const res = await tokenApi.fetch(new Request("http://x/api/auth/token", { headers: cookie ? { Cookie: cookie } : {} }));
  const setCookies = res.headers.getSetCookie();
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body, setCookies, cacheControl: res.headers.get("cache-control") };
}
const rawPair = "mock_session=abc123";
const cookieHeader = "eb_session=" + encodeURIComponent(rawPair);

const { check, finish } = createChecks();

let r = await call(null);
check("no session cookie at all: 401, no Set-Cookie", r.status === 401 && r.setCookies.length === 0, r);

mode = "ok";
r = await call(cookieHeader);
check("a good check: 200 with a token", r.status === 200 && typeof r.body.token === "string", r);
const setCookie = r.setCookies[0] || "";
check("...slides eb_session forward with the same underlying pair", setCookie.startsWith("eb_session=" + encodeURIComponent(rawPair) + ";"), setCookie);
check("...for a full 7 days, matching Neon Auth's own session lifetime", /Max-Age=604800\b/.test(setCookie), setCookie);
check("...HttpOnly, Secure, SameSite=Lax like every other session cookie", /HttpOnly/.test(setCookie) && /Secure/.test(setCookie) && /SameSite=Lax/.test(setCookie), setCookie);
check("the response is never cached", r.cacheControl === "no-store", r.cacheControl);

mode = "401";
r = await call(cookieHeader);
check("Neon Auth says the session is gone: 401, and the cookie is left untouched (not cleared here)", r.status === 401 && r.setCookies.length === 0, r);
check("...never cached either", r.cacheControl === "no-store", r.cacheControl);

mode = "500";
r = await call(cookieHeader);
check("Neon Auth erroring (500): NOT treated as signed out — 503, not 401", r.status === 503, r);
check("...and doesn't touch the cookie", r.setCookies.length === 0, r.setCookies);

mode = "network";
r = await call(cookieHeader);
check("Neon Auth unreachable: also 503, not 401", r.status === 503, r);

mode = "bad-body";
r = await call(cookieHeader);
check("Neon Auth returning nonsense: 502 (unexpected response), not 401", r.status === 502, r);

mode = "ok";
r = await tokenApi.fetch(new Request("http://x/api/auth/token", { method: "POST", headers: { Cookie: cookieHeader } }));
check("POST is rejected", r.status === 405, r.status);

mockAuth.close();
finish();
