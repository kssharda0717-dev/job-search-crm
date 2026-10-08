import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checksum,
  parseVersion,
  planMigrations,
  requiresOwnTransaction,
  stripSqlComments,
  type MigrationFile,
} from "../src/migrate/plan";

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../supabase/migrations",
);

function file(version: number, filename: string, sql = "select 1;"): MigrationFile {
  return { version, filename, sql };
}

describe("parseVersion", () => {
  it("reads the leading number", () => {
    assert.equal(parseVersion("0009_escape_like_and_unique_chunks.sql"), 9);
    assert.equal(parseVersion("0014_record_accepted_repairs.sql"), 14);
  });

  it("parses as decimal, not octal", () => {
    // "0008" through parseInt without a radix is a classic source of 0.
    assert.equal(parseVersion("0008_draft_runs.sql"), 8);
  });

  it("rejects a name that does not start with digits", () => {
    assert.equal(parseVersion("README.md"), null);
    assert.equal(parseVersion("rollback_0009.sql"), null);
  });
});

describe("stripSqlComments", () => {
  it("removes line and block comments", () => {
    assert.match(stripSqlComments("-- a comment\nselect 1;"), /^\s*select 1;$/);
    assert.match(stripSqlComments("/* block */ select 1;"), /select 1;/);
  });

  it("keeps a -- that is inside a string literal", () => {
    // escape_like() in 0009 is built from literals; treating their contents as
    // comments would silently truncate the statement.
    const sql = "select replace(x, '--', '');";
    assert.match(stripSqlComments(sql), /'--'/);
  });

  it("handles a doubled quote inside a literal", () => {
    assert.match(stripSqlComments("select 'it''s';"), /'it''s'/);
  });
});

describe("requiresOwnTransaction", () => {
  it("flags alter type … add value", () => {
    assert.equal(requiresOwnTransaction("alter type persona add value 'X';"), true);
  });

  it("flags create index concurrently", () => {
    assert.equal(requiresOwnTransaction("create index concurrently i on t (c);"), true);
  });

  it("does not flag ordinary DDL", () => {
    assert.equal(requiresOwnTransaction("alter table jobs add column x text;"), false);
  });

  it("does not flag a comment that merely discusses the statement", () => {
    // This is the real case, not a synthetic one: 0003 and 0004 both carry a
    // header comment explaining that `alter type … add value` cannot run in a
    // transaction. A detector reading raw text would flag every file that
    // documents the hazard, including files that do not contain it.
    const prose = "-- `alter type ... add value` cannot run inside a transaction.\nselect 1;";
    assert.equal(requiresOwnTransaction(prose), false);
  });
});

describe("planMigrations", () => {
  it("returns pending migrations in numeric order", () => {
    const files = [file(10, "0010_c.sql"), file(2, "0002_a.sql"), file(9, "0009_b.sql")];
    const plan = planMigrations(files, []);
    assert.deepEqual(
      plan.map((m) => m.version),
      [2, 9, 10],
    );
  });

  it("orders numerically rather than lexicographically", () => {
    // "0010" sorts before "0009" as text only when padding is inconsistent, but
    // the moment someone writes 100_x.sql a string sort puts it before 9.
    const plan = planMigrations([file(100, "100_x.sql"), file(9, "0009_b.sql")], []);
    assert.deepEqual(
      plan.map((m) => m.version),
      [9, 100],
    );
  });

  it("skips migrations already recorded", () => {
    const a = file(1, "0001_init.sql");
    const b = file(2, "0002_storage.sql");
    const plan = planMigrations(
      [a, b],
      [{ version: 1, filename: a.filename, checksum: checksum(a.sql) }],
    );
    assert.deepEqual(
      plan.map((m) => m.version),
      [2],
    );
  });

  it("refuses two files with the same version", () => {
    assert.throws(
      () => planMigrations([file(15, "0015_a.sql"), file(15, "0015_b.sql")], []),
      /share version 15/,
    );
  });

  it("refuses a migration that was edited after being applied", () => {
    // docs/RULES.md makes this a rule; without the checksum nothing enforces it.
    // The database keeps the old shape, the repo shows the new text, and every
    // later reader is misled about what the schema actually is.
    const edited = file(1, "0001_init.sql", "create table jobs (id uuid);");
    assert.throws(
      () =>
        planMigrations(
          [edited],
          [{ version: 1, filename: edited.filename, checksum: checksum("something else") }],
        ),
      /has changed since it was applied/,
    );
  });

  it("refuses when the database is ahead of the code", () => {
    assert.throws(
      () => planMigrations([], [{ version: 7, filename: "0007_x.sql", checksum: "abc" }]),
      /no longer exists on disk/,
    );
  });

  it("is a no-op when everything is applied", () => {
    const a = file(1, "0001_init.sql");
    const plan = planMigrations(
      [a],
      [{ version: 1, filename: a.filename, checksum: checksum(a.sql) }],
    );
    assert.deepEqual(plan, []);
  });
});

describe("the real migrations directory", () => {
  // These run against the actual files rather than fixtures. A fixture cannot
  // catch a renumbering mistake in the directory the runner will read.
  const files = ["0003_adjacent_employee_persona.sql", "0004_founder_executive_persona.sql"];

  for (const name of files) {
    it(`${name} is correctly detected as non-transactional`, () => {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
      assert.equal(requiresOwnTransaction(sql), true);
    });
  }

  it("0001 is transactional despite discussing other statements", () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, "0001_init.sql"), "utf8");
    assert.equal(requiresOwnTransaction(sql), false);
  });
});
