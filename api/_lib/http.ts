// Every route here answers with something personal — a session, a token, a
// name, who's blocked — so none of it is ever cacheable by a shared cache
// sitting in between (a CDN, a corporate proxy). no-store is the default;
// a caller can still override it explicitly through `headers`.
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

export function err(status: number, message: string): Response {
  return json({ error: message }, status);
}

export function isResponse(x: unknown): x is Response {
  return x instanceof Response;
}
