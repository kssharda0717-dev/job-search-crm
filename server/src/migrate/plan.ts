/**
 * Decide which migrations to run, in what order, and which cannot be wrapped in
 * a transaction.
 *
 * Its own module, with no database and no `env`, for the reason given in
 * `rag/embedding-guard.ts`: a rule worth enforcing is worth testing, and this
 * one is testable only if importing it costs nothing. Everything that touches
 * Postgres lives in `run.ts`.
 *
 * The failures this guards against are the ones the README already warns about
 * in prose — a migration skipped, applied twice, or edited after the fact. Until
 * now the only thing stopping them was a human reading that prose.
 */

import { createHash } from "node:crypto";

export interface MigrationFile {
  /** Leading number in the filename, parsed as an integer: `0009` → 9. */
  version: number;
  filename: string;
  sql: string;
}

/** A row of the `schema_migrations` ledger. */
export interface AppliedMigration {
  version: number;
  filename: string;
  checksum: string;
}

/**
 * Content hash of a migration, stored alongside it in the ledger.
 *
 * `docs/RULES.md` → Migrations says "never edit a migration that has been run",
 * which was unenforceable: an edited file leaves the database shaped like the
 * old version and the repository claiming the new one, with nothing to compare.
 * Storing the hash turns that rule into something the runner can check.
 */
export function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/**
 * `0009_escape_like_and_unique_chunks.sql` → `9`, or `null` if the name does
 * not start with digits followed by an underscore.
 */
export function parseVersion(filename: string): number | null {
  const digits = /^(\d+)_/.exec(filename)?.[1];
  if (digits === undefined) return null;
  // Radix 10 explicitly: `parseInt("0008")` is 8 either way in modern engines,
  // but the omission is the classic way to get 0 and nobody re-reads it.
  return Number.parseInt(digits, 10);
}

/**
 * Strip SQL comments so prose cannot be mistaken for a statement.
 *
 * This is not decoration. `0003` and `0004` both carry a header comment that
 * says, in words, "`alter type … add value` cannot run inside a transaction
 * block" — and `0006`'s comment names the function it drops. A detector that
 * reads raw file text sees those sentences as SQL, so every file that merely
 * *discusses* a statement gets treated as if it contained one.
 *
 * Single-quoted literals are tracked because `escape_like()` in `0009` contains
 * `'%'` and `'_'`; a `--` inside a literal is data, not a comment.
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let inString = false;

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (inLine) {
      if (sql[i] === "\n") {
        inLine = false;
        out += "\n";
      }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (two === "*/") {
        inBlock = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (inString) {
      // '' is an escaped quote inside a literal, not the end of one.
      if (sql[i] === "'" && sql[i + 1] === "'") {
        out += "''";
        i += 2;
        continue;
      }
      if (sql[i] === "'") inString = false;
      out += sql[i];
      i += 1;
      continue;
    }

    if (two === "--") {
      inLine = true;
      i += 2;
      continue;
    }
    if (two === "/*") {
      inBlock = true;
      i += 2;
      continue;
    }
    if (sql[i] === "'") {
      inString = true;
      out += sql[i];
      i += 1;
      continue;
    }

    out += sql[i];
    i += 1;
  }

  return out;
}

/**
 * Whether this migration must run with autocommit rather than inside a
 * transaction.
 *
 * Two statements qualify. `create index concurrently` is rejected outright
 * inside a transaction block. `alter type … add value` is accepted by Postgres
 * 12+ only so long as the new value is not used before commit — a condition
 * `0003` and `0004` happen to satisfy, but one that depends on what a *future*
 * migration puts in the same file. Running these outside a transaction costs
 * nothing and removes the dependency on that subtlety.
 *
 * The trade is real and is accepted deliberately: a file run without a
 * transaction that fails halfway stays half-applied. `run.ts` does not record
 * such a file as applied, so the next run stops on it rather than skipping past
 * it.
 */
export function requiresOwnTransaction(sql: string): boolean {
  const bare = stripSqlComments(sql);
  return (
    /\balter\s+type\b[\s\S]*?\badd\s+value\b/i.test(bare) ||
    /\bcreate\s+(unique\s+)?index\s+concurrently\b/i.test(bare)
  );
}

/**
 * The ordered list of migrations still to apply.
 *
 * Throws rather than returning a partial answer. Every condition below means
 * the database and the repository disagree about history, and the only safe
 * response is to stop before writing anything — a migration runner that
 * guesses is worse than no migration runner, because it is trusted.
 *
 * @param files   Every `*.sql` found on disk, in any order.
 * @param applied Ledger rows already recorded in the database.
 */
export function planMigrations(
  files: MigrationFile[],
  applied: AppliedMigration[],
): MigrationFile[] {
  const byVersion = new Map<number, MigrationFile>();
  for (const file of files) {
    const clash = byVersion.get(file.version);
    if (clash) {
      // Two files numbered the same cannot be ordered, and picking either one
      // silently applies half a change set.
      throw new Error(
        `Two migrations share version ${file.version}: "${clash.filename}" and ` +
          `"${file.filename}". Renumber one; migrations are append-only, so the ` +
          `later change takes the next free number.`,
      );
    }
    byVersion.set(file.version, file);
  }

  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (!file) {
      throw new Error(
        `Migration ${row.version} ("${row.filename}") is recorded as applied to ` +
          `this database but no longer exists on disk. The database is ahead of ` +
          `the code — deploying this build would leave the schema unexplained. ` +
          `Check out the commit that still has it rather than deleting the row.`,
      );
    }
    if (checksum(file.sql) !== row.checksum) {
      throw new Error(
        `"${file.filename}" has changed since it was applied to this database. ` +
          `The schema reflects the old text and the repository shows the new ` +
          `one, and nothing downstream can tell. docs/RULES.md: migrations are ` +
          `append-only. Restore the file and put the change in a new migration.`,
      );
    }
  }

  const appliedVersions = new Set(applied.map((row) => row.version));
  return [...byVersion.values()]
    .filter((file) => !appliedVersions.has(file.version))
    .sort((a, b) => a.version - b.version);
}
