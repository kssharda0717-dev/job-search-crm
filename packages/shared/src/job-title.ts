/**
 * Whether a string is a job title or a piece of LinkedIn's furniture.
 *
 * Zod-free and in its own subpath for the usual two reasons: a content script
 * that imports the `@crm/shared` barrel gets zod bundled and dies at load, and a
 * rule that lives only in the extension cannot be tested, because the extension
 * has no test runner.
 *
 * It lives here rather than in the scraper because the scraper is not the only
 * way a title reaches the database. `POST /jobs` is also called by the manual
 * "I applied" flow and by the ATS scrapers, and a title is not cosmetic: it
 * feeds `extractRoleKeywords`, the concern lens and the rerank rubric, so every
 * ranking signal for that application ends up steered by a button label. Three
 * live rows were filed as "Share negative feedback" and "Remote" before anyone
 * noticed, and they looked like a data-entry problem rather than the retrieval
 * problem they were.
 */

/**
 * Chrome LinkedIn renders where a heading or a job link would be.
 *
 * Exact matches only. "Remote Data Entry Administrator" is a real job title and
 * a prefix rule would reject it; the string that has to be refused is the filter
 * pill that says nothing but "Remote". This is a list of observed damage, not of
 * imagined cases — every entry has been written to the database.
 */
const NOT_A_TITLE = [
  /^share negative feedback$/i,
  /^(remote|on-?site|hybrid|easy apply|dismiss|undo|save|saved)$/i,
  /^job (dismissed|saved)\b/i,
  /^we won'?t show you/i,
];

/** The title if it is one, `null` if it is a control's label. */
export function looksLikeJobTitle(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return NOT_A_TITLE.some((pattern) => pattern.test(trimmed)) ? null : trimmed;
}
