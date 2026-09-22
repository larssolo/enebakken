import postgres from "postgres";

// Module-scope singleton: reused across warm invocations of the same
// function instance, same pattern as any long-lived Node server.
export const sql = postgres(process.env.DATABASE_URL!);

export async function callerRole(userId: string): Promise<string | null> {
  const rows = await sql`select role from members where user_id = ${userId}`;
  return (rows[0]?.role as string | undefined) ?? null;
}
