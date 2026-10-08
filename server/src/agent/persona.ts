import type { Persona } from "@crm/shared";

/**
 * Deterministic persona classification from a LinkedIn headline.
 *
 * `classify_persona` used to be decided entirely by the model, with the tool
 * doing nothing but record whatever it said. That is the wrong division of
 * labour twice over: the model guesses, and the guess then steers retrieval, so
 * a single wrong word silently changes which resume bullets the draft is built
 * from. An HR Coordinator classified as an Engineering_Leader got the most
 * technical bullets in the resume and a closing question about how the team
 * measures AI implementations — a question she has no way to answer.
 *
 * Headlines state the job in plain words, so most of this does not need a model
 * at all. This runs first and vetoes the model when the two disagree; the model
 * is left to decide only the cases the rules cannot see.
 *
 * Pure and dependency-free so it can be unit tested; nothing here may import
 * `env`, which throws at import time.
 */

/** Words that say "I hire people", which outrank everything else in a headline. */
const RECRUITING =
  /\b(recruit\w*|talent\s+acquisition|talent\s+partner|sourcer|staffing|hr|human\s+resources|people\s+(ops|operations|partner)|technical\s+sourcing)\b/i;

/** Words that say "I run something". */
const LEADERSHIP =
  /\b(manager|mgr|director|head|vp|svp|evp|vice\s+president|lead|leader)\b/i;

/** Words that say the thing being run, or built, is software. */
const ENGINEERING =
  /\b(engineer\w*|software|technical|technology|platform|infrastructure|backend|back[\s-]?end|frontend|front[\s-]?end|full[\s-]?stack|devops|sre|ai|ml|machine\s+learning|data|architecture|r&d)\b/i;

/** Owners of the business rather than of a team. */
const EXECUTIVE =
  /\b(founder|co[\s-]?founder|ceo|cto|coo|cfo|cpo|cro|cmo|ciso|chief|president|owner|managing\s+director|general\s+partner|entrepreneur)\b/i;

/** Individual contributors who build the product. */
const INDIVIDUAL_ENGINEER =
  /\b(engineer|developer|programmer|swe|sde|scientist|researcher|architect|technologist|sre|devops)\b/i;

/** Everyone else who works there: support, success, ops, sales, marketing, design. */
const ADJACENT =
  /\b(support|customer\s+(success|experience|service|care)|client\s+services|success|solutions|account\s+(executive|manager)|sales|business\s+development|marketing|operations|ops|finance|accounting|legal|counsel|design(er)?|ux|ui|content|community|writer|teacher|instructor|tutor|coordinator|administrator|assistant)\b/i;

export function personaFromHeadline(headline: string | null | undefined): Persona | null {
  const text = (headline ?? "").trim();
  if (!text) return null;

  // Recruiting first: "Technical Recruiter" and "HR Coordinator" both contain
  // words the rules below would otherwise claim, and getting this one wrong is
  // the most expensive mistake — a recruiter asked an architecture question
  // reads as a mass mailing.
  if (RECRUITING.test(text)) return "Technical_Recruiter";

  // Before the executive rule, so "VP of Engineering" is a leader of engineers
  // rather than an owner of the business.
  if (LEADERSHIP.test(text) && ENGINEERING.test(text)) return "Engineering_Leader";

  if (EXECUTIVE.test(text)) return "Founder_Executive";

  if (INDIVIDUAL_ENGINEER.test(text)) return "Peer_Engineer";

  if (ADJACENT.test(text)) return "Adjacent_Employee";

  // A headline like "Building things at Acme" says nothing checkable. Return
  // nothing rather than a confident guess, and let the model decide.
  return null;
}
