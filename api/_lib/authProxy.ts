// Server-side proxy helpers for Neon Auth (Better Auth). The browser never
// talks to Neon Auth's own origin directly — that would mean a third-party
// session cookie, which Safari blocks outright and Chrome/Firefox only keep
// alive via partitioning that isn't worth depending on. Instead these route
// handlers call Neon Auth over plain server-to-server HTTP (no cookie policy
// applies there) and relay the session as our own first-party, HttpOnly
// cookie on www.enebakken.info.
//
// The cookie's value is the upstream Set-Cookie's "name=value" pair, stored
// verbatim (URL-encoded) without assuming its exact name — relaying it back
// as a Cookie header is all Neon Auth needs to recognize the session.

export const AUTH_BASE = process.env.NEON_AUTH_BASE_URL!;
export const SITE_ORIGIN = "https://www.enebakken.info";

const MY_COOKIE = "eb_session";
const DEFAULT_MAX_AGE = 60 * 60 * 24 * 7; // 7 days, matches Neon Auth's own session lifetime

function upstreamSetCookieHeader(res: Response): string | null {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const all = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  return all[0] ?? res.headers.get("set-cookie");
}

export function getUpstreamCookiePair(res: Response): string | null {
  const raw = upstreamSetCookieHeader(res);
  if (!raw) return null;
  return raw.split(";")[0].trim(); // "name=value"
}

export function getUpstreamMaxAge(res: Response): number {
  const raw = upstreamSetCookieHeader(res) ?? "";
  const m = raw.match(/Max-Age=(\d+)/i);
  return m ? parseInt(m[1], 10) : DEFAULT_MAX_AGE;
}

export function setSessionCookie(headers: Headers, pair: string, maxAge: number): void {
  headers.append(
    "Set-Cookie",
    `${MY_COOKIE}=${encodeURIComponent(pair)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
  );
}

export function clearSessionCookie(headers: Headers): void {
  headers.append("Set-Cookie", `${MY_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

export function readSessionCookie(request: Request): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const name = part.slice(0, i).trim();
    if (name === MY_COOKIE) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Neon Auth requires an Origin header on state-changing calls (sign-up
// rejects with MISSING_ORIGIN otherwise) — send it on every proxied call.
export function upstreamHeaders(extra?: Record<string, string>): Record<string, string> {
  return { "Content-Type": "application/json", Origin: SITE_ORIGIN, ...extra };
}
