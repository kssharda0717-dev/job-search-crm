import type { HybridSearchHit } from "@crm/shared";

/**
 * The pure half of reranking: reading the model's response and applying it to
 * the fused ranking.
 *
 * Split out of `rerank.ts` because that file imports `openai` from
 * `embeddings.ts`, which builds its client from `env` at module load — and
 * `env` throws at import when a variable is missing. ESM evaluates the whole
 * graph before a test's first assertion runs, so a test importing these two
 * functions from `rerank.ts` died on a machine with no `server/.env`, which is
 * to say in CI. It passed locally for exactly as long as the author happened to
 * have a configured `.env` beside the code.
 *
 * The rule this restores is in `docs/RULES.md`: pure logic lives where nothing
 * in its import graph reaches `env`. Not "mock env" — a mock would have to be
 * installed before the import that reads it, which is a load-order problem
 * rather than a test.
 */

/** Relevance grades the model is allowed to assign. */
export const MAX_GRADE = 2;

/**
 * Apply model grades to the fused ranking. Pure, so the ordering rules are
 * testable without a network call — which matters because every interesting
 * case here is a degenerate response.
 *
 * Ordering is by grade descending, then by the fused position. The fused order
 * is the tiebreak rather than the model's own, so the reranker changes the
 * result only where it actually has an opinion; retrieval keeps the say on
 * everything it graded equally.
 */
export function applyGrades(
  candidates: HybridSearchHit[],
  grades: Map<number, number>,
  limit: number,
): HybridSearchHit[] {
  const ranked = candidates
    .map((hit, position) => ({ hit, position, grade: grades.get(position) ?? 0 }))
    .sort((a, b) => b.grade - a.grade || a.position - b.position);

  const kept = ranked.filter((entry) => entry.grade > 0).slice(0, limit);

  // Every candidate graded 0 means the model found no usable evidence in this
  // resume for this reader. That is a real signal, but acting on it would hand
  // the agent an empty context and it would write from the job description
  // alone — the generic message. Degrade to the fused ranking instead.
  if (kept.length === 0) return candidates.slice(0, limit);

  return kept.map((entry) => entry.hit);
}

/**
 * Parse a rerank response into grades by candidate position.
 *
 * Unknown ids, out-of-range grades and non-numeric values are dropped rather
 * than throwing: a candidate the model failed to mention is indistinguishable
 * from one it graded 0, and both are handled by `applyGrades` without needing
 * the whole response to be discarded.
 */
export function parseGrades(content: string, candidateCount: number): Map<number, number> {
  const parsed: unknown = JSON.parse(content);
  const rows = (parsed as { grades?: unknown }).grades;
  if (!Array.isArray(rows)) throw new Error("Rerank response had no `grades` array");

  const grades = new Map<number, number>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const { id, grade } = row as { id?: unknown; grade?: unknown };
    if (typeof id !== "number" || typeof grade !== "number") continue;
    if (!Number.isInteger(id) || id < 0 || id >= candidateCount) continue;
    grades.set(id, Math.min(MAX_GRADE, Math.max(0, Math.round(grade))));
  }
  return grades;
}
