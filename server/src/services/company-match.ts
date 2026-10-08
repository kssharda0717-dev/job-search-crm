/**
 * Pure company-name matching helpers.
 *
 * Deliberately free of database and config imports so they stay unit-testable
 * without a live Supabase project or a populated environment.
 */

const LEGAL_SUFFIXES =
  /\b(inc|llc|ltd|limited|corp|corporation|gmbh|plc|co|sa|ag|bv|nv|pvt|pte)\b/g;

/**
 * Strip legal suffixes and punctuation so "Stripe, Inc." and "Stripe" agree.
 * LinkedIn headlines and ATS listings rarely spell a company the same way.
 */
export function normalizeCompany(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(LEGAL_SUFFIXES, "")
    .replace(/[.,()|·•@]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether two company names refer to the same employer.
 *
 * The same containment test `match_jobs_by_company` performs in SQL, lifted
 * into TypeScript so the reverse direction — an application arriving *after*
 * the contacts who work there — can be resolved in one pass over the tables
 * instead of one round trip per contact.
 *
 * The trigram leg is intentionally not reproduced: this decides whether to link
 * records the user never explicitly connected, so it should be the strict half
 * of the SQL rule, not the fuzzy one.
 */
export function companiesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = normalizeCompany(a);
  const right = normalizeCompany(b);
  // A one- or two-letter remnant ("AI", "Co") matches far too much to be
  // evidence of anything.
  if (left.length < 3 || right.length < 3) return false;
  return left.includes(right) || right.includes(left);
}

/**
 * Escape the three characters that mean something to Postgres' LIKE/ILIKE, so a
 * scraped or model-supplied string is matched literally.
 *
 * The TypeScript twin of `escape_like()` in migration 0009, and it exists for
 * the same reason: `%` and `_` are wildcards, so "100% Remote" pasted into
 * `%…%` matches every row in the table. Backslash goes first, or the escapes
 * added after it would themselves be escaped.
 *
 * Keep this and the SQL function in step. A pattern escaped on one side and not
 * the other is worse than neither, because the two paths would then disagree
 * about which jobs a company matches.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * LinkedIn headlines are freeform, e.g.
 *   "Senior SWE at Stripe | ex-Google"
 *   "Engineering Manager @ Ramp"
 * Pull out the employer when the profile's company field wasn't scraped.
 */
export function companyFromHeadline(
  headline: string | null | undefined,
): string | null {
  if (!headline) return null;
  // `\bat\b` anchors the word form, but `@` needs its own alternative: it is a
  // non-word character, so a preceding `\b` never matches after a space.
  const match = headline.match(/(?:\bat\b|@)\s*([^|·•\-–—,]+)/i);
  if (!match?.[1]) return null;
  const company = match[1].trim();
  return company.length > 1 && company.length < 60 ? company : null;
}
