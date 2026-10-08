import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type HybridSearchHit, RRF_K } from "@crm/shared";
import { fuseLenses, fuseRrf, type RankedChunk } from "../src/rag/fuse";

function chunk(n: number): RankedChunk {
  return {
    chunk_id: `c${n}`,
    resume_id: "r1",
    chunk_index: n,
    chunk_text: `chunk ${n}`,
  };
}

function hit(n: number): HybridSearchHit {
  return { ...chunk(n), dense_rank: 1, sparse_rank: null, rrf_score: 1 / 61 };
}

const opts = { k: RRF_K, limit: 10 };

describe("fuseRrf", () => {
  it("ranks a chunk both legs agree on above one only the top of a single leg found", () => {
    // c2 is 2nd in both legs; c1 is 1st in dense and absent from sparse. Two
    // mid-rank agreements beating one strong single-leg hit is the whole reason
    // for using RRF rather than taking the better leg's ordering.
    const dense = [chunk(1), chunk(2)];
    const sparse = [chunk(3), chunk(2)];

    const fused = fuseRrf([dense, sparse], opts);

    assert.equal(fused[0]?.chunk_id, "c2");
  });

  it("keeps a chunk only one leg returned", () => {
    // The SQL this replaced was a full outer join; an inner join here would
    // silently delete every result the dense leg alone could find, which is
    // most of what the headline lens contributes.
    const fused = fuseRrf([[chunk(1)], [chunk(2)]], opts);

    assert.deepEqual(
      fused.map((hit) => hit.chunk_id).sort(),
      ["c1", "c2"],
    );
  });

  it("reports per-leg ranks, with null for the leg that missed", () => {
    const fused = fuseRrf([[chunk(9), chunk(1)], [chunk(1)]], opts);
    const c1 = fused.find((hit) => hit.chunk_id === "c1");
    const c9 = fused.find((hit) => hit.chunk_id === "c9");

    assert.equal(c1?.dense_rank, 2);
    assert.equal(c1?.sparse_rank, 1);
    assert.equal(c9?.dense_rank, 1);
    assert.equal(c9?.sparse_rank, null);
  });

  it("scores a rank-1 hit at 1/(k+1)", () => {
    const fused = fuseRrf([[chunk(1)], []], { k: 60, limit: 1 });
    assert.equal(fused[0]?.rrf_score, 1 / 61);
  });

  it("breaks score ties by chunk index, not by map insertion order", () => {
    const fused = fuseRrf([[chunk(5)], [chunk(2)]], opts);
    assert.deepEqual(fused.map((hit) => hit.chunk_index), [2, 5]);
  });

  it("returns nothing when every leg is empty", () => {
    assert.deepEqual(fuseRrf([[], []], opts), []);
  });

  it("honours the limit", () => {
    const dense = [chunk(1), chunk(2), chunk(3), chunk(4)];
    assert.equal(fuseRrf([dense, []], { k: RRF_K, limit: 2 }).length, 2);
  });
});

describe("fuseLenses", () => {
  it("considers a hit ranked below the cut of the lens that found it", () => {
    // The regression the retrieval eval caught. The merge this replaced took
    // hit 1 of each lens and then hit 2 of each, so with two lenses and a limit
    // of 3 nothing below rank 2 was ever looked at. For the engineering-leader
    // case the one relevant chunk was ranked third by the concern lens.
    const field = [hit(9), hit(8), hit(7), hit(6), hit(5)];
    const concern = [hit(4), hit(3), hit(2)];

    const fused = fuseLenses([field, concern], 3);

    assert.deepEqual(fused.map((h) => h.chunk_index), [4, 9, 3]);
  });

  it("ranks a chunk both lenses found above one only a single lens ranked first", () => {
    // Agreement between the recipient's field and the recipient's concerns is
    // the strongest signal this system has that a bullet is worth sending.
    const field = [hit(1), hit(2)];
    const concern = [hit(3), hit(2)];

    assert.equal(fuseLenses([field, concern], 3)[0]?.chunk_index, 2);
  });

  it("keeps rank meaningful instead of degenerating into counting lenses", () => {
    // At RRF_K = 60 these score 1/61 and 1/62 — indistinguishable, so a lens's
    // own ordering would carry no information at all across two short lists.
    const fused = fuseLenses([[hit(1), hit(2)], []], 2);

    assert.equal(fused[0]?.rrf_score, 1 / 2);
    assert.equal(fused[1]?.rrf_score, 1 / 3);
  });

  it("carries leg provenance through but replaces the score", () => {
    const withRanks: HybridSearchHit = {
      ...hit(1),
      dense_rank: 4,
      sparse_rank: 2,
    };

    const fused = fuseLenses([[withRanks], []], 1);

    assert.equal(fused[0]?.dense_rank, 4);
    assert.equal(fused[0]?.sparse_rank, 2);
    assert.notEqual(fused[0]?.rrf_score, withRanks.rrf_score);
  });

  it("returns nothing when every lens is empty", () => {
    assert.deepEqual(fuseLenses([[], []], 3), []);
  });
});
