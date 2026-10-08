/**
 * Apply pending migrations, then exit.
 *
 * This is a one-shot process, not part of the server. The reason is the
 * connection string: `DATABASE_URL` carries the Postgres superuser password,
 * and the only thing that needs it is DDL. A long-running HTTP server that
 * holds it keeps a credential in memory for hours in order to use it for the
 * first two seconds. So the secret is read here, in a module `src/index.ts`
 * never imports, and deliberately *not* added to `src/env.ts`.
 *
 * `src/migrate/plan.ts` decides what to run and refuses when the database and
 * the repository disagree. This file only talks to Postgres.
 *
 *   pnpm --filter @crm/server migrate
 *   pnpm --filter @crm/server migrate --baseline
 *
 * `--baseline` records every file as applied *without running it*, for the one
 * database where the migrations were already applied by hand before this
 * runner existed. Running it against a fresh database would leave an empty
 * schema that claims to be fully migrated, so it refuses unless the schema
 * already looks migrated.
 */

import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  checksum,
  parseVersion,
  planMigrations,
  requiresOwnTransaction,
  type AppliedMigration,
  type MigrationFile,
} from "./plan";

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/migrations",
);

/**
 * An arbitrary but fixed key. Two containers started at once — which is the
 * normal case on a `docker compose up` after an update — would otherwise both
 * read an empty ledger and both run `0001`.
 */
const LOCK_KEY = 4_027_591_083;

const LEDGER = `
  create table if not exists public.schema_migrations (
    version    integer primary key,
    filename   text        not null,
    checksum   text        not null,
    applied_at timestamptz not null default now()
  );
`;

function readMigrations(): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const filename of readdirSync(MIGRATIONS_DIR)) {
    if (!filename.endsWith(".sql")) continue;
    const version = parseVersion(filename);
    // A `.sql` without a leading number is not a migration — a rollback script
    // or a scratch file. Skipping beats guessing an order for it.
    if (version === null) continue;
    files.push({
      version,
      filename,
      sql: readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8"),
    });
  }
  return files;
}

async function readLedger(client: pg.Client): Promise<AppliedMigration[]> {
  const { rows } = await client.query<AppliedMigration>(
    "select version, filename, checksum from public.schema_migrations",
  );
  return rows;
}

async function record(client: pg.Client, file: MigrationFile): Promise<void> {
  await client.query(
    `insert into public.schema_migrations (version, filename, checksum)
     values ($1, $2, $3)`,
    [file.version, file.filename, checksum(file.sql)],
  );
}

/**
 * Run one migration.
 *
 * Most files go inside a transaction with their ledger row, so a failure
 * leaves no trace and the next run retries from the same point.
 *
 * The exceptions are the files Postgres refuses to run in a transaction
 * block. Those execute bare, and the ledger row is written afterwards — so a
 * failure halfway leaves the file *unrecorded*, and the next run stops on it
 * rather than stepping over a half-applied change. That is the intended
 * behaviour: a human has to look.
 */
async function apply(client: pg.Client, file: MigrationFile): Promise<void> {
  if (requiresOwnTransaction(file.sql)) {
    process.stdout.write(`  ${file.filename} (outside a transaction)\n`);
    await client.query(file.sql);
    await record(client, file);
    return;
  }

  process.stdout.write(`  ${file.filename}\n`);
  await client.query("begin");
  try {
    await client.query(file.sql);
    await record(client, file);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/**
 * Does this database already have the schema the migrations build?
 *
 * `--baseline` claims the files have been applied without checking the SQL, so
 * the claim is worth one piece of evidence. `resume_chunks` is created by
 * `0001` and used by every later migration; if it is absent, nothing was
 * applied by hand and baselining would be a lie the runner then trusts
 * forever.
 */
async function looksMigrated(client: pg.Client): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    "select to_regclass('public.resume_chunks') is not null as present",
  );
  return rows[0]?.present === true;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. It is the Postgres connection string, not the " +
        "Supabase REST URL: Supabase dashboard → Project Settings → Database → " +
        "Connection string → URI. server/.env.example has the shape.",
    );
  }

  const baseline = process.argv.includes("--baseline");
  const files = readMigrations();
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    // Blocks rather than failing, so a second container waits for the first.
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(LEDGER);

    if (baseline) {
      if (!(await looksMigrated(client))) {
        throw new Error(
          "--baseline refused: this database has no `resume_chunks` table, so " +
            "the migrations have not been applied by hand. Recording them as " +
            "applied would leave an empty schema claiming to be up to date. " +
            "Run `pnpm --filter @crm/server migrate` instead.",
        );
      }
      const applied = await readLedger(client);
      const known = new Set(applied.map((row) => row.version));
      const pending = files.filter((file) => !known.has(file.version));
      for (const file of pending.sort((a, b) => a.version - b.version)) {
        process.stdout.write(`  recording ${file.filename} as already applied\n`);
        await record(client, file);
      }
      process.stdout.write(
        pending.length === 0
          ? "Ledger already complete; nothing to baseline.\n"
          : `Baselined ${pending.length} migration(s). No SQL was run.\n`,
      );
      return;
    }

    const plan = planMigrations(files, await readLedger(client));
    if (plan.length === 0) {
      process.stdout.write("Database is up to date.\n");
      return;
    }

    process.stdout.write(`Applying ${plan.length} migration(s):\n`);
    for (const file of plan) await apply(client, file);
    process.stdout.write("Done.\n");
  } finally {
    // Released by disconnecting too, but only once the session actually ends.
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

main().catch((error: unknown) => {
  // Loud and non-zero. A migration step that fails quietly is how this
  // repository ended up with two migrations everyone believed were applied.
  process.stderr.write(`\nMigration failed.\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
