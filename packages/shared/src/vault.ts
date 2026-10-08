/**
 * Document Vault routing rules: which uploaded file is the resume, and which
 * tracked application an uploaded file is allowed to be filed against.
 *
 * Pure and dependency-free, in its own module for two reasons. It is imported
 * by a content script, so it must never reach zod (see the note on the
 * `./vault` subpath in package.json); and the decisions below are the ones that
 * misfiled three tailored CVs on 2026-10-01, so they are worth testing without
 * a browser.
 */

/**
 * How much a file looks like the document the vault is for.
 *
 * An application usually asks for more than one upload — a resume and a cover
 * letter, sometimes a portfolio — and the stash holds one document per tab, so
 * whichever the user attached *last* used to win. Attaching the cover letter
 * second therefore filed the cover letter as the tailored resume and the CV was
 * lost, which is precisely backwards: the resume is the thing outreach is later
 * generated from.
 *
 * Ranking rather than filtering is deliberate. Refusing anything that is not
 * named "resume" would lose the very common `Arjun_Nair.pdf`, so an
 * unrecognised name still counts — it just loses to an explicit resume and wins
 * against an explicit cover letter.
 */
export function documentRank(fileName: string): number {
  if (COVER_LETTER.test(fileName)) return 0;
  if (RESUME.test(fileName)) return 2;
  return 1;
}

/**
 * Word boundaries in a filename, which `\b` does not provide.
 *
 * `_` is a word character, so `\bcv\b` does not match `Arjun_CV.pdf` and
 * `\bresume\b` does not match `Arjun_Nair_Resume.pdf` — and underscores are
 * how almost every exported CV is named, including the vault's own
 * `<Name>_<Company>_<Role>.pdf`. Every such file therefore scored as
 * unrecognised, so the ranking that exists to stop a cover letter being filed
 * as the tailored resume could not tell them apart.
 */
const SEP = "[\\s_.\\-]";
const COVER_LETTER = new RegExp(`(?:^|${SEP})(?:cover${SEP}*letter|coverletter|cl)(?=$|${SEP})`, "i");
const RESUME = new RegExp(`(?:^|${SEP})(?:resume|cv|curriculum${SEP}*vitae)(?=$|${SEP})`, "i");

/** Nothing has been filed against this application yet. */
export const NOTHING_DELIVERED = -1;

/**
 * How long after an application is tracked a freshly picked file may still be
 * assumed to belong to it.
 *
 * Deliberately far shorter than `HANDSHAKE_TTL_MS`, which this used to reuse.
 * Two hours is not "the ATS asked for the file on a later step", it is "the
 * user has since started a different application".
 */
export const DELIVERY_WINDOW_MS = 10 * 60 * 1000;

/** A tracked application, and the rank of whatever is already filed against it. */
export interface DeliveryTarget {
  jobId: string;
  /** When the application was tracked, as an epoch milliseconds instant. */
  at: number;
  deliveredRank: number;
}

/**
 * Whether a file just picked by the user may be filed against this application.
 *
 * Both guards exist because of a real incident. The binding to a tracked job
 * used to survive until its tab closed, and the tab-independent form for two
 * hours, with nothing marking it as satisfied — so the *next* application's CV,
 * picked in the apply form before that application is tracked (which is the
 * normal order), resolved to the *previous* job and was filed there. Three
 * consecutive applications each received the following one's resume, and the
 * last received none.
 *
 * Refusing is cheap: an unclaimed resume waits in the stash, and the commit a
 * few seconds later takes it. Accepting wrongly is not — it overwrites a
 * tailored CV that exists nowhere else.
 *
 * The rank comparison keeps the one case a flat "once only" rule would break:
 * an ATS that asks for the cover letter first and the CV second still ends up
 * with the CV, because the CV outranks it. The next application's CV outranks
 * nothing and is left alone.
 */
export function acceptsDelivery(
  target: DeliveryTarget | undefined,
  fileName: string,
  now: number,
): boolean {
  if (!target) return false;
  if (now - target.at > DELIVERY_WINDOW_MS) return false;
  return documentRank(fileName) > target.deliveredRank;
}
