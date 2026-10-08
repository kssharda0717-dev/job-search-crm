import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { escapeLikePattern } from "../src/services/company-match";

/**
 * `%` and `_` are wildcards to Postgres' LIKE/ILIKE, and company names are
 * scraped from pages nobody here controls. Pasting one into `%…%` unescaped
 * turned "100% Remote" into a pattern matching every tracked application, which
 * made `match_jobs_by_company` return several candidates — and the capture path
 * correctly refuses to guess between several, so the contact was filed as
 * general networking with no error anywhere.
 */
describe("escapeLikePattern", () => {
  it("leaves an ordinary company name untouched", () => {
    assert.equal(escapeLikePattern("Stripe"), "Stripe");
    assert.equal(escapeLikePattern("Vector AI, Inc."), "Vector AI, Inc.");
  });

  it("escapes the wildcard that matches any run of characters", () => {
    assert.equal(escapeLikePattern("100% Remote"), "100\\% Remote");
  });

  it("escapes the wildcard that matches a single character", () => {
    assert.equal(escapeLikePattern("Node_Labs"), "Node\\_Labs");
  });

  it("escapes the backslash first, so the escapes it adds survive", () => {
    // Naively replacing % and _ before \ would produce `\\%`, which reads as an
    // escaped backslash followed by a live wildcard — the exact bug this
    // ordering exists to avoid.
    assert.equal(escapeLikePattern("a\\b"), "a\\\\b");
    assert.equal(escapeLikePattern("a\\%b"), "a\\\\\\%b");
  });

  it("handles every wildcard in one string", () => {
    assert.equal(escapeLikePattern("%_\\"), "\\%\\_\\\\");
  });
});

/**
 * The SQL side has its own copy of this rule, and the two must not drift: a
 * pattern escaped on one path and not the other means the RPC and the
 * TypeScript backfill disagree about which jobs a company matches, which shows
 * up as a contact that links one way round and not the other.
 */
describe("migration 0009", () => {
  const sql = readFileSync(
    fileURLToPath(
      new URL(
        "../../supabase/migrations/0009_escape_like_and_unique_chunks.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("defines escape_like with the backslash replaced first", () => {
    // Asserted as a literal rather than a regex: the string being checked is
    // three levels of backslash escaping deep, and a regex for it is unreadable
    // enough to be wrong without anyone noticing.
    assert.ok(
      sql.includes(
        String.raw`replace(replace(replace(p_value, '\', '\\'), '%', '\%'), '_', '\_')`,
      ),
      "escape_like must replace the backslash before the wildcards it adds",
    );
  });

  it("escapes both sides of the containment test", () => {
    assert.match(sql, /j\.company ilike '%' \|\| escape_like\(p_company\) \|\| '%'/);
    assert.match(sql, /p_company ilike '%' \|\| escape_like\(j\.company\) \|\| '%'/);
  });

  it("adds the unique key the chunk upsert now targets", () => {
    assert.match(sql, /unique \(resume_id, chunk_index\)/);
  });

  it("clears existing duplicates first, or the constraint cannot be added", () => {
    assert.match(sql, /delete from resume_chunks/);
  });
});
