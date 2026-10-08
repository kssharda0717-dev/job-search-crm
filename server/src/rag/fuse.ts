import type { HybridSearchHit } from "@crm/shared";

/**
 * One chunk as returned by a single retrieval leg, ordered best-first by the
 * store that produced it.
 *
 * There is deliberately no `score` here. Scores from a dense leg (cosine
 * distance) and a sparse leg (`ts_rank_cd` cover density) are not on a
 * comparable scale, and their distributions shift per query, so anything that
 * reads them has to invent a weighting constant that is wrong for the next
 * document. RRF reads rank order only, so rank order is all a store must
 * promise.
 */
export interface RankedChunk {
  chunk_id: string;
  resume_id: string;
  chunk_index: number;
  chunk_text: string;
}

/**
 * Reciprocal Rank Fusion over one or more ranked legs.
 *
 * This used to live inside `hybrid_search_resume_chunks`, which made it
 * unreachable from a test: verifying that a chunk found by only one leg still
 * competes required a populated Postgres with a 1536-dimension embedding. It is
 * also what made the vector store swappable — a store now only has to return
 * ranked lists, and fusion is identical whichever store produced them.
 *
 * Ranks are 1-based positions within each leg, so the first result contributes
 * `1 / (k + 1)`. A chunk missing from a leg contributes nothing from that leg
 * rather than being penalised, which is the "full outer join" behaviour the SQL
 * had: a chunk only the sparse leg found must still be able to win.
 */
export function fuseRrf(
  legs: RankedChunk[][],
  options: { k: number; limit: number },
): HybridSearchHit[] {
  const { k, limit } = options;
  const [denseLeg = [], sparseLeg = []] = legs;

  const byId = new Map<string, { chunk: RankedChunk; score: number }>();

  for (const leg of legs) {
    leg.forEach((chunk, index) => {
      const contribution = 1 / (k + index + 1);
      const existing = byId.get(chunk.chunk_id);
      if (existing) {
        existing.score += contribution;
      } else {
        byId.set(chunk.chunk_id, { chunk, score: contribution });
      }
    });
  }

  // Reported for debugging and for the eval harness, which measures each leg
  // separately to tell "fusion is wrong" apart from "one leg matched nothing".
  const denseRank = rankLookup(denseLeg);
  const sparseRank = rankLookup(sparseLeg);

  return [...byId.values()]
    .sort((a, b) => b.score - a.score || a.chunk.chunk_index - b.chunk.chunk_index)
    .slice(0, limit)
    .map(({ chunk, score }) => ({
      chunk_id: chunk.chunk_id,
      resume_id: chunk.resume_id,
      chunk_index: chunk.chunk_index,
      chunk_text: chunk.chunk_text,
      dense_rank: denseRank.get(chunk.chunk_id) ?? null,
      sparse_rank: sparseRank.get(chunk.chunk_id) ?? null,
      rrf_score: score,
    }));
}

function rankLookup(leg: RankedChunk[]): Map<string, number> {
  return new Map(leg.map((chunk, index) => [chunk.chunk_id, index + 1]));
}

/**
 * `k` for fusing whole lenses, as opposed to fusing the dense and sparse legs
 * within one lens.
 *
 * `RRF_K = 60` is the constant from the original RRF paper, tuned over TREC
 * runs of thousands of documents, where the difference between rank 1 and rank
 * 4 really is noise. Across two six-element lens rankings it erases rank
 * altogether — 1/61 against 1/64 — so fusion degenerates into counting how many
 * lenses returned a chunk at all. At k = 1 a chunk two lenses both rank third
 * (1/4 + 1/4) exactly ties a chunk one lens ranks first (1/2), which is the
 * trade this system actually wants to make.
 */
export const LENS_RRF_K = 1;

/**
 * Reciprocal Rank Fusion across retrieval lenses: one vote per lens.
 *
 * Deliberately not the same call as fusing all four legs in one pot. The
 * headline lens's sparse leg is empty whenever the recipient's job title shares
 * no literal vocabulary with the resume, which is the common case — pooling
 * legs would then give the generic persona lens twice the say over exactly the
 * recipients whose headline is most distinctive, i.e. the ones the headline
 * lens exists for.
 *
 * This replaced an interleave that took hit 1 of each lens and dropped the
 * rest. The eval caught it discarding a correct answer: for an engineering
 * leader the one relevant chunk was ranked third by the concern lens and was
 * never even considered.
 *
 * `dense_rank` and `sparse_rank` are carried through from the first lens that
 * found the chunk. They describe leg provenance inside that lens and mean
 * nothing across lenses; `rrf_score` is replaced with the cross-lens score.
 */
export function fuseLenses(
  lenses: HybridSearchHit[][],
  limit: number,
): HybridSearchHit[] {
  const byId = new Map<string, { hit: HybridSearchHit; score: number }>();

  for (const lens of lenses) {
    lens.forEach((hit, index) => {
      const contribution = 1 / (LENS_RRF_K + index + 1);
      const existing = byId.get(hit.chunk_id);
      if (existing) {
        existing.score += contribution;
      } else {
        byId.set(hit.chunk_id, { hit, score: contribution });
      }
    });
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score || a.hit.chunk_index - b.hit.chunk_index)
    .slice(0, limit)
    .map(({ hit, score }) => ({ ...hit, rrf_score: score }));
}
