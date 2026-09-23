// Hand-rolled EdDSA (Ed25519) JWT verification against Neon Auth's JWKS,
// using only Node's built-in Web Crypto — no dependency. Verified standalone
// against a real Neon Auth token before this shipped: valid token accepted;
// tampered payload, wrong issuer, alg confusion, and exp+1s all rejected;
// exp-1s still accepted.

import { callerRole } from "./db.js";
import { err } from "./http.js";

const AUTH_BASE = process.env.NEON_AUTH_BASE_URL!;
const ISSUER = new URL(AUTH_BASE).origin;
const JWKS_URL = `${AUTH_BASE}/.well-known/jwks.json`;

let jwksCache: { keys: any[] } | null = null;
let jwksCachedAt = 0;

async function getJwks(): Promise<{ keys: any[] }> {
  if (jwksCache && Date.now() - jwksCachedAt < 10 * 60 * 1000) return jwksCache;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  jwksCache = await res.json();
  jwksCachedAt = Date.now();
  return jwksCache!;
}

export interface Caller {
  userId: string;
  email: string;
  name: string | null;
}

export async function verifyToken(token: string): Promise<Caller | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header: any, payload: any;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (header.alg !== "EdDSA") return null; // reject algorithm confusion

  const jwks = await getJwks();
  let jwk = jwks.keys.find((k) => k.kid === header.kid && k.kty === "OKP" && k.crv === "Ed25519");
  if (!jwk) {
    // Key rotation: refetch once before giving up.
    jwksCache = null;
    const fresh = await getJwks();
    jwk = fresh.keys.find((k) => k.kid === header.kid && k.kty === "OKP" && k.crv === "Ed25519");
    if (!jwk) return null;
  }

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return null;
  }

  const signedData = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const signature = Buffer.from(sigB64, "base64url");

  const valid = await crypto.subtle.verify("Ed25519", key, signature, signedData);
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  if (payload.iss !== ISSUER) return null;
  if (payload.aud !== ISSUER) return null;
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;

  return { userId: payload.sub, email: payload.email, name: typeof payload.name === "string" ? payload.name : null };
}

export async function authenticate(request: Request): Promise<Caller | null> {
  const auth = request.headers.get("authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) return null;
  return verifyToken(auth.slice(7));
}

export async function requireOwner(request: Request): Promise<Caller | Response> {
  const caller = await authenticate(request);
  if (!caller) return err(401, "Log ind for at fortsætte");
  const role = await callerRole(caller.userId);
  if (role !== "owner") return err(403, "Kun ejeren kan gøre dette");
  return caller;
}

// Any signed-in account may share photos and the checklist ticks, unless
// the owner has blocked it.
export async function requireActiveUser(request: Request): Promise<Caller | Response> {
  const caller = await authenticate(request);
  if (!caller) return err(401, "Log ind for at fortsætte");
  if ((await callerRole(caller.userId)) === "blocked") return err(403, "Din konto er blokeret");
  return caller;
}
