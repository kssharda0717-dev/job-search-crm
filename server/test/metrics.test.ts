import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregate, evaluateRanking } from "../src/eval/metrics";

describe("evaluateRanking", () => {
  it("scores a perfect top-3", () => {
    const m = evaluateRanking([1, 2, 3], [1, 2, 3], 3);
    assert.equal(m.precisionAtK, 1);
    assert.equal(m.recallAtK, 1);
    assert.equal(m.reciprocalRank, 1);
    assert.equal(m.ndcgAtK, 1);
    assert.equal(m.hit, true);
  });

  it("scores a complete miss at zero without producing NaN", () => {
    const m = evaluateRanking([7, 8, 9], [1, 2], 3);
    assert.equal(m.precisionAtK, 0);
    assert.equal(m.recallAtK, 0);
    assert.equal(m.reciprocalRank, 0);
    assert.equal(m.ndcgAtK, 0);
    assert.equal(m.hit, false);
  });

  it("counts recall against the gold set, not against k", () => {
    // One of four relevant chunks found. Precision and recall disagreeing is
    // the normal case and the reason both are reported.
    const m = evaluateRanking([1, 8, 9], [1, 2, 3, 4], 3);
    assert.equal(m.precisionAtK, 1 / 3);
    assert.equal(m.recallAtK, 1 / 4);
  });

  it("gives reciprocal rank by position of the first hit", () => {
    assert.equal(evaluateRanking([9, 9, 1], [1], 3).reciprocalRank, 1 / 3);
  });

  it("finds a hit below k for RR but not for precision", () => {
    // RR deliberately scans the whole list: "the right answer was at rank 5"
    // is a different diagnosis from "the right answer is not in the index".
    const m = evaluateRanking([9, 9, 9, 9, 1], [1], 3);
    assert.equal(m.reciprocalRank, 1 / 5);
    assert.equal(m.precisionAtK, 0);
    assert.equal(m.hit, false);
  });

  it("prefers the relevant chunk higher up, which precision cannot see", () => {
    const early = evaluateRanking([1, 8, 9], [1], 3);
    const late = evaluateRanking([8, 9, 1], [1], 3);

    assert.equal(early.precisionAtK, late.precisionAtK);
    assert.ok(early.ndcgAtK > late.ndcgAtK);
    assert.equal(early.ndcgAtK, 1);
  });

  it("normalises nDCG against the best achievable ordering, not against k", () => {
    // Only one chunk is relevant, so finding it first is a perfect ranking even
    // though two of the three returned chunks are not relevant.
    assert.equal(evaluateRanking([1, 8, 9], [1], 3).ndcgAtK, 1);
  });

  it("returns zero rather than NaN for an empty gold set", () => {
    const m = evaluateRanking([1, 2], [], 3);
    assert.equal(m.recallAtK, 0);
    assert.equal(m.ndcgAtK, 0);
  });

  it("returns zero rather than NaN when nothing was retrieved", () => {
    const m = evaluateRanking([], [1], 3);
    assert.equal(m.precisionAtK, 0);
    assert.equal(m.recallAtK, 0);
  });
});

describe("aggregate", () => {
  it("averages per query rather than pooling hits", () => {
    // Case A has one relevant chunk and finds it (recall 1). Case B has four
    // and finds one (recall 0.25). Pooling would give 2/5 = 0.4; the mean of
    // the per-query recalls is 0.625, and B must not be able to drown out A.
    const a = evaluateRanking([1], [1], 3);
    const b = evaluateRanking([1, 8, 9], [1, 2, 3, 4], 3);

    assert.equal(aggregate([a, b]).recallAtK, 0.625);
  });

  it("reports hit rate separately from the strict all-hit flag", () => {
    const hit = evaluateRanking([1], [1], 3);
    const miss = evaluateRanking([9], [1], 3);
    const agg = aggregate([hit, miss]);

    assert.equal(agg.hitRate, 0.5);
    assert.equal(agg.hit, false);
    assert.equal(agg.cases, 2);
  });

  it("names the averaged reciprocal rank MRR", () => {
    const agg = aggregate([
      evaluateRanking([1], [1], 3),
      evaluateRanking([9, 1], [1], 3),
    ]);
    assert.equal(agg.mrr, 0.75);
  });

  it("returns zeroes for no cases", () => {
    const agg = aggregate([]);
    assert.equal(agg.cases, 0);
    assert.equal(agg.mrr, 0);
    assert.equal(agg.hitRate, 0);
  });
});
