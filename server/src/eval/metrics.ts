/**
 * Ranking metrics over a single query's results.
 *
 * `retrieved` is the ranked list of chunk indices the system returned, best
 * first. `relevant` is the labelled gold set for that query. Both identify
 * chunks by `chunk_index` rather than `chunk_id`, because ids are generated per
 * insert and a committed fixture cannot name them; `chunkResumeText` is
 * deterministic, so an index survives re-indexing.
 *
 * Everything here is pure and total — no database, no network, no `env`.
 */

export interface RankingMetrics {
  /** Of the top k, how many were relevant. Precision is what the model sees:
   *  an irrelevant chunk in the context window is a chunk the draft can be
   *  built from, so this matters more here than in a search product. */
  precisionAtK: number;
  /** Of everything relevant, how much made the top k. */
  recallAtK: number;
  /** 1 / rank of the first relevant hit. Rewards getting one right thing to the
   *  top, which is what `interleave()` takes from each lens. */
  reciprocalRank: number;
  /** Rank-discounted gain, normalised against the best achievable ordering. */
  ndcgAtK: number;
  /** Did anything relevant appear at all. Separated out because a zero here is
   *  a different failure from a bad ordering — usually a dead leg. */
  hit: boolean;
}

export function evaluateRanking(
  retrieved: readonly number[],
  relevant: readonly number[],
  k: number,
): RankingMetrics {
  const gold = new Set(relevant);
  const topK = retrieved.slice(0, k);
  const hits = topK.filter((index) => gold.has(index));

  return {
    precisionAtK: topK.length === 0 ? 0 : hits.length / topK.length,
    // Guard the empty gold set rather than returning NaN: a case with no
    // labelled answer is a broken case, and NaN would poison every average it
    // is folded into without ever naming itself.
    recallAtK: gold.size === 0 ? 0 : hits.length / gold.size,
    reciprocalRank: reciprocalRank(retrieved, gold),
    ndcgAtK: ndcg(topK, gold, k),
    hit: hits.length > 0,
  };
}

function reciprocalRank(retrieved: readonly number[], gold: ReadonlySet<number>): number {
  const position = retrieved.findIndex((index) => gold.has(index));
  return position === -1 ? 0 : 1 / (position + 1);
}

/**
 * Binary-relevance nDCG. Gains are 0 or 1, so DCG is the sum of 1/log2(rank+1)
 * over the relevant hits and the ideal is the same sum over the first
 * min(|gold|, k) positions.
 */
function ndcg(topK: readonly number[], gold: ReadonlySet<number>, k: number): number {
  const dcg = topK.reduce(
    (sum, index, position) => (gold.has(index) ? sum + 1 / Math.log2(position + 2) : sum),
    0,
  );

  const idealDepth = Math.min(gold.size, k);
  let ideal = 0;
  for (let position = 0; position < idealDepth; position++) {
    ideal += 1 / Math.log2(position + 2);
  }

  return ideal === 0 ? 0 : dcg / ideal;
}

/**
 * Mean of each metric across cases, plus MRR.
 *
 * Averaging per query rather than pooling all hits together is deliberate: a
 * resume with twelve relevant chunks would otherwise drown out one with two,
 * and the second is the case the persona lenses exist to serve.
 */
export interface AggregateMetrics extends RankingMetrics {
  cases: number;
  /** Mean reciprocal rank — the conventional name for the averaged RR. */
  mrr: number;
  /**
   * Fraction of cases that retrieved anything relevant.
   *
   * Reported next to the means because it answers a different question. A run
   * can hold a respectable mean nDCG while a third of the cases returned
   * nothing usable at all, and those are the messages that actually get sent
   * with the wrong evidence in them. `hit` above is the strict form: every case.
   */
  hitRate: number;
}

export function aggregate(results: readonly RankingMetrics[]): AggregateMetrics {
  const n = results.length;
  if (n === 0) {
    return {
      cases: 0,
      precisionAtK: 0,
      recallAtK: 0,
      reciprocalRank: 0,
      mrr: 0,
      ndcgAtK: 0,
      hit: false,
      hitRate: 0,
    };
  }

  const mean = (pick: (m: RankingMetrics) => number) =>
    results.reduce((sum, m) => sum + pick(m), 0) / n;

  const mrr = mean((m) => m.reciprocalRank);
  const hitRate = mean((m) => (m.hit ? 1 : 0));

  return {
    cases: n,
    precisionAtK: mean((m) => m.precisionAtK),
    recallAtK: mean((m) => m.recallAtK),
    reciprocalRank: mrr,
    mrr,
    ndcgAtK: mean((m) => m.ndcgAtK),
    hit: hitRate === 1,
    hitRate,
  };
}
