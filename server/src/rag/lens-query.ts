import { PERSONA_CONCERNS, type Persona } from "@crm/shared";

/**
 * The dense query for Lens B of `searchResumeForRecipient`.
 *
 * Its own module, and not part of `search.ts`, for the same reason
 * `embedding-guard.ts` is: `search.ts` reaches `rag/embeddings.ts`, which builds
 * an OpenAI client from `env` at import time and throws without one. Nothing in
 * that import graph can be unit tested, and this string is exactly the kind of
 * thing that should be.
 *
 * Shared with the retrieval eval, which scores this lens leg by leg. The eval
 * used to hold its own copy; the two then said different things, so a change to
 * the lens moved production without moving the number whose job is to detect
 * changes to the lens.
 */
export function concernLensQuery(target: {
  recipientTitle: string;
  company: string;
  persona: Persona | null;
  roleTitle: string | null;
}): string {
  // Peer_Engineer is the safe default: the persona whose concerns overlap most
  // with a technical JD, so an unclassified recipient degrades to roughly the
  // old behaviour rather than to something worse.
  const concerns = PERSONA_CONCERNS[target.persona ?? "Peer_Engineer"];

  return (
    `A ${target.recipientTitle} at ${target.company} judges a candidate by ` +
    `${concerns.caresAbout}.` +
    // The role, stated before the instruction rather than after it. Without it
    // this query asks for whatever is most impressive about the candidate, and
    // the most impressive thing in a resume is frequently not the thing the
    // reader is hiring for. That is not hypothetical: the recruiter for an
    // Oracle Fusion HCM vacancy was sent a client-satisfaction score from an
    // unrelated reconciliation tool, with ten Oracle HCM passages unused in the
    // same corpus.
    (target.roleTitle
      ? ` They are screening for a ${target.roleTitle}, so the evidence has to ` +
        `be about that work. Find what this candidate has done in that role's ` +
        `own domain — its systems, its modules, its deliverables.`
      : " Find the evidence that speaks to exactly that.")
  );
}
