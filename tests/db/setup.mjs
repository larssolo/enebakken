// Prepares an empty (or already prepared) Postgres for the test suites:
// a minimal stand-in for Neon Auth's own neon_auth schema — just the
// tables and columns this app's code reads or deletes from — and then
// every migration in migrations/, in order. Both steps are idempotent, so
// this is safe to run before every test run.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { REPO, DATABASE_URL } from "../lib/harness.mjs";

// In production these tables belong to Neon Auth (ids there are uuids; the
// app only ever compares them as text, so text ids are an honest stand-in).
const NEON_AUTH_STUB = `
  create schema if not exists neon_auth;
  create table if not exists neon_auth."user" (
    id text primary key,
    email text not null unique,
    name text,
    "createdAt" timestamptz not null default now()
  );
  create table if not exists neon_auth.session (
    id text primary key default gen_random_uuid()::text,
    "userId" text not null,
    token text
  );
  create table if not exists neon_auth.account (
    id text primary key default gen_random_uuid()::text,
    "userId" text not null,
    "providerId" text
  );
  create table if not exists neon_auth.verification (
    id text primary key default gen_random_uuid()::text,
    identifier text not null,
    value text
  );
`;

export async function setupDatabase() {
  const db = postgres(DATABASE_URL, { onnotice: () => {}, max: 1 });
  try {
    await db.unsafe(NEON_AUTH_STUB);
    const dir = path.join(REPO, "migrations");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      await db.unsafe(await readFile(path.join(dir, f), "utf8"));
      console.log(`  migration ${f}`);
    }
  } finally {
    await db.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await setupDatabase();
}
