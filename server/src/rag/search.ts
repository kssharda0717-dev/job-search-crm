import {
  EMBEDDING_MODEL,
  type HybridSearchHit,
  PERSONA_CONCERNS,
  type Persona,
  RERANK_CANDIDATES,
  RRF_K,
  capProfileText,
} from "@crm/shared";
import type { UsageMeter } from "../observability/meter";
import { embeddingMismatch } from "./embedding-guard";
import { embedText } from "./embeddings";
import { fuseLenses, fuseRrf, type RankedChunk } from "./fuse";
import { concernLensQuery } from "./lens-query";
import { extractRoleKeywords, toOrQuery } from "./keywords";
import { rerankForRecipient } from "./rerank";
import { vectorStore } from "./store";

/**
 * Over-fetch relative to the requested limit: fusion needs depth in each leg to
 * mean anything, otherwise RRF degenerates to whichever leg matched at all.
 */
function legDepth(limit: number): number {
  return Math.max(limit * 10, 30);
}

/** Both legs of hybrid retrieval, unfused. Exposed for the eval harness, which
 * scores each leg separately — a fused score cannot distinguish a mis-weighted
 * fusion from a leg that returned nothing at all. */
export async function retrieveLegs(params: {
  /** Null searches every resume the candidate has indexed. See `VectorStore`. */
  jobId: string | null;
  query: string;
  keywords?: string | null;
  limit?: number;
}): Promise<{ dense: RankedChunk[]; sparse: RankedChunk[] }> {
  const { jobId, query, limit = 3 } = params;
  const depth = legDepth(limit);

  // Before the vectors are compared, not after. This is the only chokepoint
  // every retrieval path goes through, including the eval harness — which is
  // the point: an eval that scores a cross-model corpus reports a number that
  // means nothing, and a low score would be read as a ranking regression.
  const mismatch = embeddingMismatch(
    await vectorStore.embeddingModels(jobId),
    EMBEDDING_MODEL,
  );
  if (mismatch) throw new Error(mismatch);

  const queryEmbedding = await embedText(query);

  const [dense, sparse] = await Promise.all([
    vectorStore.denseSearch({ jobId, embedding: queryEmbedding, limit: depth }),
    vectorStore.sparseSearch({
      jobId,
      queryText: params.keywords ?? query,
      limit: depth,
    }),
  ]);

  return { dense, sparse };
}

/**
 * Dense + sparse retrieval fused with RRF, scoped to one application's resume.
 *
 * Fusion used to happen inside Postgres to save a round trip. It moved into
 * `fuse.ts` so that it could be tested and so that the dense leg could be
 * served by something other than Postgres; the second query is cheap next to
 * the embedding call that precedes both.
 */
export async function hybridSearch(params: {
  jobId: string | null;
  query: string;
  keywords?: string | null;
  limit?: number;
}): Promise<HybridSearchHit[]> {
  const limit = params.limit ?? 3;
  const { dense, sparse } = await retrieveLegs(params);
  return fuseRrf([dense, sparse], { k: RRF_K, limit });
}

/**
 * Depth to pull from each lens before fusing them. Fusing top-`limit` lists
 * would throw away the evidence the eval caught us throwing away: for an
 * engineering leader the one relevant chunk sat at rank 3 of the concern lens
 * and never reached the merge at all.
 */
const LENS_DEPTH = RERANK_CANDIDATES;

/**
 * Retrieve the resume evidence that stitches together the person being written
 * to and the resume actually submitted for this application.
 *
 * It runs two lenses rather than one because a single query cannot serve both.
 * The original implementation asked one question — "skills relevant to a
 * <title> at <company>", with the JD's technology keywords on the sparse leg —
 * which meant every recipient at a company got the same, most-technical
 * bullets. A support lead and a CTO are not looking for the same evidence about
 * the same candidate, and a bullet that is irrelevant to the reader is an
 * unanswered message no matter how strong it is.
 *
 * Lens A (their field): the recipient's own headline *and their profile*, used
 *   as the query. This is the one that finds shared ground, and it was the
 *   missing input: the recipient reached retrieval only as a five-value persona
 *   enum, which throws away everything specific about them. An HR coordinator at
 *   an AI company and a staff recruiter at the same company produced
 *   byte-identical queries, and the four years of payroll-systems work sitting
 *   in the resume — the one thing the HR coordinator would have replied to —
 *   was unreachable from both.
 *
 *   The headline alone only half-fixed that. A headline is a slogan — "Talent
 *   Partner | We're hiring!" — and plenty of people leave it at their job title
 *   or blank. The About and Experience sections are where it says they spent six
 *   years on HRIS implementations, which is the sentence that decides whether
 *   this resume has anything to say to them. `recipientProfile` carries it.
 * Lens B (their concerns): what someone in that role judges a candidate by,
 *   *while screening for the role the user applied to*, plus that role's own
 *   keywords on the sparse leg.
 *
 *   The role used to be absent from both dense queries. Only its keywords
 *   reached retrieval, and only on one sparse leg — which, for anyone outside
 *   software, meant it reached retrieval not at all (see `extractRoleKeywords`).
 *   The result: a recruiter screening an Oracle Fusion HCM req was sent a
 *   client-satisfaction metric from an unrelated project, because every ranking
 *   signal in the system was answering "what would this reader find
 *   impressive?" and none of them was answering "about this job".
 *
 * There used to be a third lens asking why the candidate fits the JD. Its query
 * named only the company, so it returned a byte-identical ranking for all six
 * recipients in the eval set, led every time by the resume's comma-separated
 * skills wall — which matched five of its six sparse keywords while a real
 * achievement bullet matches one. It spent a third of the evidence budget
 * reproducing the exact defect the lenses exist to fix. Naming the role inside
 * Lens B is not a revival of it: Lens B stays recipient-specific, because the
 * persona clause still varies per reader.
 *
 * Fusion then hands `RERANK_CANDIDATES` chunks to `rerankForRecipient`, which
 * cuts to `limit`. The lenses decide what is *about* this reader; the reranker
 * decides what is worth *saying* to them. See rag/rerank.ts for why that second
 * question cannot be answered by either retrieval leg.
 */
export async function searchResumeForRecipient(params: {
  /**
   * Null when the contact is linked to no application — a person recovered from
   * the Sent-invitations page, who arrives with a headline and no employer.
   * Retrieval then runs over every resume the candidate has indexed instead of
   * returning nothing. The caller must tell the model the evidence was written
   * for a different role.
   */
  jobId: string | null;
  recipientTitle: string;
  company: string;
  jdText: string | null;
  /** The role the user applied to, e.g. "Oracle Fusion HCM Functional
   * Consultant". The subject of the message, and so the thing every ranking
   * decision has to be relative to. */
  roleTitle: string | null;
  persona: Persona | null;
  /** About + Experience + Skills, as scraped from their profile. Usually null
   * until the user has opened the person's own profile page once. */
  recipientProfile?: string | null;
  limit?: number;
  /** Optional run accounting. Absent in the eval harness, which does not bill
   * itself against a draft. */
  meter?: UsageMeter;
}): Promise<HybridSearchHit[]> {
  const limit = params.limit ?? 3;
  // Peer_Engineer is the safe default: it is the persona whose concerns overlap
  // most with a technical JD, so an unclassified recipient degrades to roughly
  // the old behaviour rather than to something worse.
  const concerns = PERSONA_CONCERNS[params.persona ?? "Peer_Engineer"];
  const roleKeywords = extractRoleKeywords(params.jdText, params.roleTitle);
  const profile = params.recipientProfile?.trim() || null;
  const role = params.roleTitle?.trim() || null;

  const [fieldLens, concernLens] = await Promise.all([
    hybridSearch({
      jobId: params.jobId,
      query:
        `The person being written to works as: ${params.recipientTitle}.` +
        // Truncated, and deliberately so. This string is embedded, and an
        // embedding is an average: pasting four thousand characters of someone's
        // career in here pulls the query vector towards the centroid of
        // everything they have ever done, which is close to nothing in
        // particular. The opening of a condensed profile is About plus the
        // current role — what they are doing now, which is what the message is
        // about.
        (profile ? ` Their profile says: ${queryExcerpt(profile)}` : "") +
        ` Find anything in this resume that touches their world — the same ` +
        `domain, the same systems, the same users, or the same problems they ` +
        `handle every day.`,
      // The recipient's own words, headline first. They frequently match nothing
      // in the resume, in which case the sparse leg simply contributes no rows
      // and the dense leg carries this lens alone — which is the intended
      // behaviour, since the overlap here is usually semantic ("HR coordinator"
      // / "HCM payroll") rather than lexical. The profile is what gives this leg
      // a chance of a *lexical* hit: "Oracle", "payroll", "workday" are nouns
      // that appear verbatim in both documents, and a headline rarely has them.
      keywords: toOrQuery([
        ...headlineTerms(params.recipientTitle, params.company),
        ...profileTerms(profile, params.company),
      ]),
      limit: LENS_DEPTH,
    }),
    hybridSearch({
      jobId: params.jobId,
      query: concernLensQuery({
        recipientTitle: params.recipientTitle,
        company: params.company,
        persona: params.persona,
        roleTitle: role,
      }),
      // Persona vocabulary first, role keywords second: the union is what makes
      // a support-shaped bullet and a Kafka-shaped bullet both reachable, and
      // without the persona terms the support-shaped one has no way in at all.
      keywords: toOrQuery([...concerns.terms, roleKeywords]),
      limit: LENS_DEPTH,
    }),
  ]);

  const fused = fuseLenses([fieldLens, concernLens], RERANK_CANDIDATES);

  return rerankForRecipient(
    fused,
    {
      recipientTitle: params.recipientTitle,
      company: params.company,
      persona: params.persona,
      roleTitle: role,
      roleKeywords,
    },
    limit,
    params.meter,
  );
}

/**
 * Words in a headline that say nothing about what the person does.
 *
 * The employer is stripped separately: matching the company name against the
 * resume would retrieve the application's own cover-letter-ish lines rather
 * than anything about the recipient.
 */
const HEADLINE_NOISE = new Set([
  "the", "and", "for", "with", "our", "ex", "team", "global", "hiring",
  "helping", "building", "passionate", "senior", "junior", "lead", "head",
]);

function headlineTerms(headline: string, company: string): string[] {
  const employer = new Set(company.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

  return headline
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter(
      (word) => word.length > 2 && !HEADLINE_NOISE.has(word) && !employer.has(word),
    );
}

/**
 * How much of a profile reaches the embedded query. See the comment at the call
 * site for why this is not the whole thing.
 */
const MAX_RECIPIENT_QUERY_CHARS = 700;

function queryExcerpt(profile: string): string {
  return capProfileText(profile, MAX_RECIPIENT_QUERY_CHARS).replace(/\n/g, " ");
}

/**
 * Prose filler. `HEADLINE_NOISE` was tuned for a one-line slogan; an About
 * section is sentences, and its commonest words are function words that match
 * every resume chunk equally and so rank nothing.
 */
const PROFILE_NOISE = new Set([
  "about", "experience", "skills", "years", "year", "work", "working", "works",
  "role", "roles", "company", "companies", "business", "people", "person",
  "from", "that", "this", "their", "they", "have", "has", "been", "was", "were",
  "into", "over", "more", "most", "across", "within", "also", "than", "then",
  "who", "how", "what", "where", "when", "you", "your", "his", "her", "its",
  "currently", "previously", "present", "full", "time", "part",
]);

/**
 * Terms from the profile worth putting on the sparse leg, frequency-first.
 *
 * Frequency rather than order, because what a person repeats across several
 * roles is what they actually do — "payroll" appearing in four of five entries
 * says more than whatever their newest job happens to be called. The cap exists
 * because an OR query is a ranking signal, not a filter: past a few dozen terms
 * every chunk matches something and `ts_rank_cd` is ranking noise.
 */
const MAX_PROFILE_TERMS = 30;

function profileTerms(profile: string | null, company: string): string[] {
  if (!profile) return [];
  const employer = new Set(company.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

  const counts = new Map<string, number>();
  for (const word of profile.toLowerCase().split(/[^a-z0-9+#]+/)) {
    if (word.length < 3) continue;
    if (HEADLINE_NOISE.has(word) || PROFILE_NOISE.has(word)) continue;
    if (employer.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PROFILE_TERMS)
    .map(([term]) => term);
}
