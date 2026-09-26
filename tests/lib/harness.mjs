// Shared plumbing for the test suites: where the repo and the test database
// are, how the real api/ handlers are loaded, how tokens are signed, and how
// results are counted. Every suite runs the actual shipped handler code —
// bundled straight from api/*.ts — against a local Postgres; only Neon Auth
// itself is replaced (by a local Ed25519 key and, where needed, a mock
// upstream in tests/servers/).
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import { build } from "esbuild";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://eb:eb@localhost:5432/ebtest";
// The handlers read DATABASE_URL when their module loads, so it has to be
// set before the first loadApi().
process.env.DATABASE_URL = DATABASE_URL;

const BUILD_DIR = path.join(REPO, "tests", ".build");

// Bundles api/<route>.ts (e.g. "members", "invites/redeem") and returns its
// default export — the { fetch } object Vercel calls. npm packages stay
// external and resolve from the repo's own node_modules, exactly as they do
// in production. Set NEON_AUTH_BASE_URL before calling: it's read at load.
export async function loadApi(route) {
  const outfile = path.join(BUILD_DIR, `${process.pid}-${route.replace(/\//g, "__")}.mjs`);
  await build({
    entryPoints: [path.join(REPO, "api", `${route}.ts`)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    outfile,
    logLevel: "warning",
  });
  return (await import(pathToFileURL(outfile).href)).default;
}

// A stand-in for Neon Auth's signing key. `mint` issues the same kind of
// EdDSA JWT Neon Auth does, with issuer/audience set to `origin`, so the
// handlers' real verification path accepts it unchanged.
export function createSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "EdDSA", use: "sig" };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return {
    jwks: { keys: [jwk] },
    mint(origin, { sub, email, name }) {
      const h = b64({ alg: "EdDSA", kid: "k1", typ: "JWT" });
      const p = b64({ sub, email, name, iss: origin, aud: origin, exp: Math.floor(Date.now() / 1000) + 900 });
      return `${h}.${p}.${crypto.sign(null, Buffer.from(h + "." + p), privateKey).toString("base64url")}`;
    },
  };
}

// For suites that call handlers directly: serves only the JWKS document on a
// free port. Returns the origin the handlers must treat as Neon Auth's.
export async function startJwksServer(signer) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(signer.jwks));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://localhost:${server.address().port}`;
  process.env.NEON_AUTH_BASE_URL = `${origin}/neondb/auth`;
  return { origin, close: () => server.close() };
}

// Hands a Node request to a real handler as a web Request, and writes its
// Response back — including several Set-Cookie headers, which must stay
// separate headers rather than one joined string.
export async function relay(api, origin, req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const response = await api.fetch(new Request(origin + req.url, { method: req.method, headers, body }));
  const out = {};
  response.headers.forEach((v, k) => { if (k !== "set-cookie") out[k] = v; });
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length) out["set-cookie"] = setCookies;
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
}

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

// Serves Enebakken.html and the static assets next to it, straight from the
// working tree. Returns false when the path isn't one of them.
const MIME = { ".html": "text/html; charset=utf-8", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".js": "application/javascript", ".webmanifest": "application/manifest+json" };
export async function serveStatic(p, res) {
  const { readFile } = await import("node:fs/promises");
  const file = p === "/" ? "Enebakken.html" : p.slice(1);
  const type = MIME[path.extname(file)];
  if (!type || file.includes("..") || file.includes("/")) return false;
  try {
    const buf = await readFile(path.join(REPO, file));
    res.writeHead(200, { "Content-Type": type });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

// PASS/FAIL bookkeeping shared by every suite. `finish()` prints the tally
// and exits non-zero on any failure, which is what the runner looks at.
export function createChecks() {
  const results = [];
  return {
    check(name, cond, detail) {
      results.push(!!cond);
      console.log((cond ? "PASS" : "FAIL") + "  " + name + (cond ? "" : "  :: " + JSON.stringify(detail)));
    },
    finish() {
      const failed = results.filter((x) => !x).length;
      console.log(`\n${results.length - failed}/${results.length} passed`);
      process.exit(failed || results.length === 0 ? 1 : 0);
    },
  };
}

export async function launchBrowser() {
  const { chromium } = await import("playwright");
  return chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox", "--disable-gpu"],
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Where a suite's server listens; the runner passes it in, and running a
// suite by hand falls back to the server's usual port.
export const baseUrl = (defaultPort) => process.env.TEST_BASE_URL || `http://localhost:${defaultPort}`;

// Screenshots go to tests/.artifacts/ (git-ignored; CI keeps them when a
// run fails).
export function screenshotPath(name) {
  const dir = path.join(REPO, "tests", ".artifacts");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}
