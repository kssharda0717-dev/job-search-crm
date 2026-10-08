import {
  type HybridSearchHit,
  PERSONA_CONCERNS,
  type Persona,
  RERANK_MODEL,
} from "@crm/shared";
import { recordUsage, type UsageMeter } from "../observability/meter";
import { openai } from "./embeddings";
import { MAX_GRADE, applyGrades, parseGrades } from "./grades";

/**
 * Reranking: a second pass that reorders retrieved chunks by asking whether
 * each one is usable *as evidence in a message to this specific person*.
 *
 * Why this exists, from the retrieval eval rather than from fashion. Across the
 * six labelled recipients, two chunks took 11 of the 18 evidence slots: the
 * resume's comma-separated skills wall and its education block. Neither states
 * anything the candidate did. They win because a list of sixty technologies
 * matches more query terms than any real sentence (the sparse leg) and sits
 * near the centroid of "backend engineering" (the dense leg) — so they were
 * ranked top-2 by *both legs of both lenses*, and no rearrangement of fusion
 * can exclude something every retriever likes. Fusion was the ceiling.
 *
 * What a reranker adds is the one judgement neither leg can represent: a
 * passage can match a query perfectly and still make no claim. Cosine distance
 * and cover density both score surface overlap; only a reader can score whether
 * there is a fact in there to say out loud.
 *
 * Three properties this must have, in order of importance:
 *
 *  1. It can only reorder and drop. Candidates come from the vector store and
 *     go to the agent unchanged, so no rerank response can introduce a sentence
 *     that is not in the user's resume. Everything downstream — `critique.ts`,
 *     the faithfulness eval — assumes evidence is verbatim.
 *  2. It fails open. A rerank failure returns the fused order, because a draft
 *     built from second-best evidence is recoverable and a drafting flow that
 *     500s on an API blip is not.
 *  3. It never returns nothing. If the model rejects every candidate, the fused
 *     top-`limit` is used. An empty evidence list makes the agent write from
 *     the job description alone, which is the generic-message failure this
 *     whole subsystem exists to prevent.
 */

export interface RerankTarget {
  recipientTitle: string;
  company: string;
  persona: Persona | null;
  /** The role the user applied to. Null when the contact is not linked to an
   *  application, in which case there is no role to be relevant to and the
   *  grading falls back to reader-fit alone. */
  roleTitle: string | null;
  /** That role's own vocabulary, from its title and description. Given to the
   *  grader because a title alone does not say what the work consists of, and
   *  the model should not have to infer "Fast Formula" from "HCM Consultant". */
  roleKeywords: string;
}

/**
 * Reorder `candidates` for `target`, keeping at most `limit`.
 *
 * Returns the fused order untouched when there is nothing to decide (one
 * candidate or fewer) or when the model call fails.
 */
export async function rerankForRecipient(
  candidates: HybridSearchHit[],
  target: RerankTarget,
  limit: number,
  meter?: UsageMeter,
): Promise<HybridSearchHit[]> {
  if (candidates.length <= 1) return candidates.slice(0, limit);

  let grades: Map<number, number>;
  try {
    grades = await gradeCandidates(candidates, target, meter);
  } catch (error) {
    console.warn(
      `[rerank] falling back to fused order: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return candidates.slice(0, limit);
  }

  return applyGrades(candidates, grades, limit);
}

async function gradeCandidates(
  candidates: HybridSearchHit[],
  target: RerankTarget,
  meter?: UsageMeter,
): Promise<Map<number, number>> {
  const response = await openai.chat.completions.create({
    model: RERANK_MODEL,
    // Reranking is a judgement, not a generation. Sampling here would make the
    // same resume produce different evidence on a retry, and the drafting eval
    // could not tell a regression from noise.
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt(candidates, target) },
    ],
  });

  // Recorded before the response is validated. A rerank call that came back
  // unparseable was still billed, and the fail-open path above would otherwise
  // make a run that paid for a wasted call look like a run that never made it.
  if (meter) recordUsage(meter, response.usage);

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Rerank response was empty");
  return parseGrades(content, candidates.length);
}

/**
 * The rubric turns on relevance to the *role*, not on how impressive a passage
 * is. That is the correction of a shipped failure: the previous rubric asked
 * only for "a concrete outcome this reader would care about", and a recruiter
 * screening an Oracle Fusion HCM vacancy was sent a client-satisfaction score
 * from an unrelated reconciliation tool. It scored top marks under the old
 * wording — personally done, quantified, sustained for nine months, and
 * certainly of interest to a recruiter — while ten Oracle HCM passages sat in
 * the same corpus unused. "Impressive" and "on topic" are different questions,
 * and only the second one decides whether a recruiter can act on the message.
 *
 * Note also that the reader's own `caresAbout` for a recruiter says the
 * candidate must have "already done this job somewhere real" — a sentence that
 * cannot be evaluated at all unless the grader is told what the job is. It was
 * not.
 */
const SYSTEM_PROMPT = `You grade passages from one candidate's resume for use as evidence in a short networking message to one specific person about one specific job the candidate has applied to.

Grade each passage 0, 1 or 2:

2 — states something the candidate personally did, with a concrete outcome, system or decision, AND that work is in the same domain as the role under discussion, AND this reader would care about it.
1 — states something the candidate personally did, but it is in a different domain from the role under discussion, or it is generic, or it is aimed at a different audience than this reader.
0 — not usable as evidence. Lists of technologies, skills sections, section headings, contact details, education and dates all score 0 no matter how well they match the reader's field. They contain no claim, so nothing in them can be said out loud in a message.

The domain test decides 2 against 1, and it is not a test of how impressive the passage is. A quantified, hard-won achievement from unrelated work is a 1. An achievement in the role's own domain with a weaker number is a 2. A message whose one fact is off-topic reads as a mass mailing, whatever the number in it says.

Be strict about 0. A passage that only proves familiarity with words is worthless here: the message must contain a fact, and a fact cannot be extracted from an inventory.

If no role is given, ignore the domain test and grade on reader fit alone.

Reply with JSON only: {"grades":[{"id":0,"grade":2},{"id":1,"grade":0}]}. Grade every passage exactly once.`;

function userPrompt(candidates: HybridSearchHit[], target: RerankTarget): string {
  const concerns = target.persona ? PERSONA_CONCERNS[target.persona] : null;

  const role = target.roleTitle
    ? `Role under discussion: ${target.roleTitle}.` +
      (target.roleKeywords
        ? `\nThat role is about: ${target.roleKeywords}`
        : "") +
      "\n\n"
    : "";

  const reader =
    `Reader: ${target.recipientTitle} at ${target.company}.` +
    (concerns ? `\nThis reader judges a candidate by ${concerns.caresAbout}` : "");

  const passages = candidates
    .map((hit, index) => `[${index}]\n${hit.chunk_text}`)
    .join("\n\n");

  return `${role}${reader}\n\nPassages:\n\n${passages}`;
}
