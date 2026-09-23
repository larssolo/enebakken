export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function err(status: number, message: string): Response {
  return json({ error: message }, status);
}

export function isResponse(x: unknown): x is Response {
  return x instanceof Response;
}
