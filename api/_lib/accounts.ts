import { sql } from "./db.js";

// Removes an account entirely from Neon Auth's own schema plus this app's
// members row. Neon Auth owns that schema, so there's no single "delete
// user" call — every table that can reference the account (session,
// account, verification by email, and the user row itself; the
// organization/member/invitation tables are Better Auth's own org plugin,
// which this app never uses) is cleared in one transaction. Callers decide
// on their own whether the account is safe to delete (e.g. never an
// administrator) before calling this.
export async function deleteAuthAccount(userId: string, email: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from neon_auth.session where "userId" = ${userId}`;
    await tx`delete from neon_auth.account where "userId" = ${userId}`;
    await tx`delete from neon_auth.verification where identifier = ${email}`;
    await tx`delete from members where user_id = ${userId}`;
    await tx`delete from neon_auth.user where id::text = ${userId}`;
  });
}
