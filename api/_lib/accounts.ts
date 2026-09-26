import { sql } from "./db.js";

// A person's name, whether they set it themselves or it's given with an
// invite: trimmed, with runs of whitespace (a double space, a stray tab or
// newline) collapsed to one space. "" when there's no usable name.
export const MAX_NAME_LENGTH = 100;
export function normalizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
}

// Removes an account entirely from Neon Auth's own schema plus this app's
// members row. Neon Auth owns that schema, so there's no single "delete
// user" call — every table that can reference the account (session,
// account, verification by email, and the user row itself; the
// organization/member/invitation tables are Better Auth's own org plugin,
// which this app never uses) is cleared in one transaction. Callers decide
// on their own whether the account is safe to delete (e.g. never an
// administrator) before calling this.
//
// An invite still waiting to be used that created this account is withdrawn
// too: its stored session died with the account, so the link could only
// ever claim to log someone in without actually doing it.
export async function deleteAuthAccount(userId: string, email: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from invites where provisioned_user_id = ${userId} and accepted_at is null`;
    await tx`delete from neon_auth.session where "userId" = ${userId}`;
    await tx`delete from neon_auth.account where "userId" = ${userId}`;
    await tx`delete from neon_auth.verification where identifier = ${email}`;
    await tx`delete from members where user_id = ${userId}`;
    await tx`delete from neon_auth.user where id::text = ${userId}`;
  });
}
