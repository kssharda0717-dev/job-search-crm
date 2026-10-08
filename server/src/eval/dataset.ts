import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Persona } from "@crm/shared";

/**
 * The resume the whole eval set is labelled against.
 *
 * Declared here rather than in `seed.ts` so that anything wanting to resolve
 * labels can reach it without importing the database module, which pulls in
 * `env` and throws at import time when a key is missing. That is fine for a
 * runner and fatal for a unit test.
 */
export const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../eval/fixtures/resume.txt",
);

/**
 * One labelled retrieval case.
 *
 * Relevance is declared with `relevantMarkers` — distinctive phrases that must
 * appear in a relevant chunk — rather than with chunk indices. Indices are a
 * function of `CHUNK_TARGET_CHARS`, so hardcoding them would silently
 * invalidate the whole eval set the first time anyone tuned the chunker, which
 * is exactly the change the eval set exists to measure.
 */
export interface RetrievalCase {
  id: string;
  /** The recipient this draft would be addressed to. Drives the persona lens. */
  recipientTitle: string;
  persona: Persona;
  /** Phrases that identify the chunks a good retrieval must surface. */
  relevantMarkers: string[];
  /**
   * Phrases that identify chunks which must NOT be surfaced. Recorded
   * separately from "not relevant" because these are the known attractors — the
   * skills wall outranked every achievement bullet until migration 0005, and a
   * metric that only counts hits would not have caught it.
   */
  forbiddenMarkers?: string[];
  /** Why this case exists. Printed on failure, so a red line explains itself. */
  rationale: string;
}

export interface ResolvedCase extends RetrievalCase {
  relevantChunks: number[];
  forbiddenChunks: number[];
}

/**
 * Turn marker phrases into chunk indices against a specific chunking of the
 * fixture.
 *
 * A marker that matches nothing is thrown rather than skipped: a silently
 * unmatched label makes recall look worse for reasons that have nothing to do
 * with retrieval, and a zero that means "the label is stale" is
 * indistinguishable from a zero that means "the search is broken".
 */
export function resolveCase(testCase: RetrievalCase, chunks: readonly string[]): ResolvedCase {
  return {
    ...testCase,
    relevantChunks: resolveMarkers(testCase.id, testCase.relevantMarkers, chunks),
    forbiddenChunks: resolveMarkers(testCase.id, testCase.forbiddenMarkers ?? [], chunks),
  };
}

function resolveMarkers(
  caseId: string,
  markers: readonly string[],
  chunks: readonly string[],
): number[] {
  const matched = new Set<number>();

  for (const marker of markers) {
    const needle = marker.toLowerCase();
    // Every chunk containing the marker counts. Chunks carry an overlap, so a
    // bullet near a boundary genuinely appears in two of them and retrieving
    // either one is a correct answer.
    const found = chunks
      .map((chunk, index) => ({ chunk: chunk.toLowerCase(), index }))
      .filter(({ chunk }) => chunk.includes(needle));

    if (found.length === 0) {
      throw new Error(
        `Eval case "${caseId}": marker ${JSON.stringify(marker)} matches no chunk. ` +
          "The fixture or the chunker changed; fix the label rather than the metric.",
      );
    }
    for (const { index } of found) matched.add(index);
  }

  return [...matched].sort((a, b) => a - b);
}
