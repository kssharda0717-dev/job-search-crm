/**
 * Turn the eval runners from reports into gates.
 *
 * Both runners already computed everything needed to fail a release and then
 * exited 0 anyway. `eval:drafting` printed the words "FAIL: two recipients
 * received a byte-identical draft" on stdout and returned success — so the one
 * defect the whole persona pipeline exists to prevent could ship past a script
 * whose entire purpose was to catch it, as long as nobody read the scrollback.
 * A check that requires a human to read it is not a check.
 *
 * The thresholds below are floors, not targets, and they are deliberately set
 * under the recorded baseline in `docs/EVALUATION.md` §6 rather than at it.
 * Two reasons, both measured rather than assumed:
 *
 *  - The reranker is an LLM call, so the same query can move a chunk by ±1 rank
 *    between runs (§3). A threshold pinned to the exact baseline would fail on
 *    noise, and a gate that cries wolf gets bypassed within a week — at which
 *    point it is worse than no gate, because people believe it is running.
 *  - The fixture is six chunks and six cases. One case flipping is 0.167 of a
 *    rate. The floors are chosen so that *one case regressing* trips the gate
 *    and run-to-run wobble does not; there is no threshold between those two
 *    that is finer than the dataset can support.
 *
 * Raise a floor when the baseline moves up and holds across two runs. Never
 * lower one to make a run pass — that is the failure mode this file is a
 * defence against, so it is written down here rather than in a wiki.
 */

export interface Gate {
  name: string;
  /** The measured value, formatted by the caller for display. */
  actual: number;
  threshold: number;
  /** `min` = actual must be >=; `max` = actual must be <=. */
  direction: "min" | "max";
}

export const RETRIEVAL_FLOORS = {
  /** Baseline 0.710. One case losing its top hit costs ~0.11. */
  ndcgAtK: 0.6,
  /** Baseline 0.667. */
  mrr: 0.55,
  /** Baseline 0.833 = 5/6. 4/6 = 0.667 trips this. */
  hitRate: 0.75,
  /**
   * Baseline 1 of 6 cases. This is a count, not a rate, and it is the strictest
   * line here: a forbidden chunk is a labelled known-bad passage reaching the
   * agent, which is a correctness failure rather than a ranking one.
   */
  maxViolations: 1,
} as const;

export const DRAFTING_FLOORS = {
  /** Baseline 0.833. A second rounded or invented figure trips this. */
  numericFaithfulness: 0.8,
  /** Baseline 5/6 drafts with zero critique problems. */
  cleanDraftRate: 0.66,
  /**
   * Baseline 0.507, and near its arithmetic floor at this fixture size (§6), so
   * this is a ceiling against sameness creeping back — not something to tune.
   * 0.8 means the recipients are being pitched from substantially one evidence
   * set again, which is the defect the two-lens retrieval was built to fix.
   */
  maxEvidenceOverlap: 0.8,
} as const;

/**
 * Print the verdict and set the exit code.
 *
 * Returns nothing and throws nothing: the runner still has a `finally` that
 * tears down the seeded corpus, and throwing here would be a second failure
 * path around it. `process.exitCode` lets the process end normally and still
 * report failure to CI.
 */
export function enforce(label: string, gates: Gate[]): void {
  const failed = gates.filter((gate) =>
    gate.direction === "min" ? gate.actual < gate.threshold : gate.actual > gate.threshold,
  );

  console.log(`\n=== ${label} gates ===`);
  for (const gate of gates) {
    const ok = !failed.includes(gate);
    const comparison = gate.direction === "min" ? ">=" : "<=";
    console.log(
      `  ${ok ? "pass" : "FAIL"}  ${gate.name.padEnd(22)} ` +
        `${gate.actual.toFixed(3)} ${comparison} ${gate.threshold.toFixed(3)}`,
    );
  }

  if (failed.length > 0) {
    console.log(
      `\n${failed.length} gate(s) failed. This does not ship. Read the per-case ` +
        `rows above to find which case regressed — an aggregate never tells you ` +
        `that, and changing the threshold is not a fix.`,
    );
    process.exitCode = 1;
  }
}
