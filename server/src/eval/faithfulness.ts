import { numbersIn, ungroundedNumbers } from "../agent/critique";

/**
 * How much of what the draft asserts is actually supported by the chunks it was
 * built from.
 *
 * This is deliberately deterministic rather than an LLM judge. An LLM judge
 * costs a call per case, is non-reproducible across runs, and — the part that
 * matters here — is graded by the same family of model that wrote the draft, so
 * it agrees with its own hallucinations. The two things measured below are the
 * two that can be checked exactly, and one of them is the failure that actually
 * shipped.
 */
export interface FaithfulnessScore {
  /**
   * 1 − (figures not present in the evidence ÷ figures in the draft).
   *
   * This is the score that matters. The recipient can hold the message next to
   * the resume attached to the same application, and the realistic failure is
   * rounding — "over 30,000" for 32,330 — not invention.
   */
  numeric: number;
  /**
   * Fraction of the draft's distinctive claim vocabulary that appears in the
   * evidence. A weak proxy on its own — paraphrase scores badly and a generic
   * sentence scores well — so it is reported beside `numeric` rather than
   * folded into one number that hides which of the two moved.
   */
  lexical: number;
  /** Figures in the draft that are in none of the retrieved chunks. */
  ungrounded: string[];
  /** Number of figures the draft makes a claim with. */
  figures: number;
}

export function scoreFaithfulness(
  draft: string,
  evidence: readonly string[],
): FaithfulnessScore {
  const chunks = [...evidence];
  const figures = numbersIn(draft);
  const ungrounded = ungroundedNumbers(draft, chunks);

  return {
    // No figures is not a faithfulness failure — a draft is allowed to make a
    // qualitative claim — so an empty numerator scores 1 rather than 0.
    numeric: figures.length === 0 ? 1 : 1 - ungrounded.length / figures.length,
    lexical: lexicalSupport(draft, chunks),
    ungrounded,
    figures: figures.length,
  };
}

/**
 * Words that carry no claim, so their presence or absence in the evidence says
 * nothing. Kept small on purpose: an aggressive stop list flatters the score by
 * deleting everything it cannot match.
 */
const NON_CLAIM_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "your", "you", "our", "was",
  "were", "are", "been", "have", "has", "had", "from", "into", "about", "them",
  "they", "their", "what", "when", "which", "would", "could", "should", "how",
  "some", "any", "all", "one", "out", "but", "not", "its", "his", "her",
  "over", "under", "after", "before", "also", "than", "then", "there", "here",
  "just", "like", "much", "more", "most", "very", "saw", "see", "seen",
]);

/**
 * Only the sender's own claims are checked. A question about the recipient's
 * work ("how does your team handle refunds") is not supposed to be supported by
 * the sender's resume, and scoring it as unsupported would mark every correctly
 * targeted draft down for being correctly targeted.
 */
function claimSentences(draft: string): string[] {
  return draft
    .split(/(?<=[.?!])\s+/)
    .filter((sentence) => !sentence.includes("?") && /\b(i|my|me)\b/i.test(sentence));
}

function lexicalSupport(draft: string, evidence: string[]): number {
  const claims = claimSentences(draft).join(" ");
  const terms = distinctiveTerms(claims);
  if (terms.size === 0) return 1;

  const supported = distinctiveTerms(evidence.join(" "));
  let found = 0;
  for (const term of terms) {
    if (supported.has(term)) found++;
  }
  return found / terms.size;
}

function distinctiveTerms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((word) => word.length > 2 && !NON_CLAIM_WORDS.has(word)),
  );
}
