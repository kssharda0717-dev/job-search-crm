import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HybridSearchHit } from "@crm/shared";
import { concernLensQuery } from "../src/rag/lens-query";
import { applyGrades, parseGrades } from "../src/rag/rerank";

function hit(n: number): HybridSearchHit {
  return {
    chunk_id: `c${n}`,
    resume_id: "r1",
    chunk_index: n,
    chunk_text: `chunk ${n}`,
    dense_rank: null,
    sparse_rank: null,
    rrf_score: 0,
  };
}

const candidates = [hit(0), hit(1), hit(2), hit(3)];

describe("applyGrades", () => {
  it("drops a zero-graded chunk that fusion ranked first", () => {
    // The whole reason the reranker exists. Chunk 0 is the skills wall: ranked
    // top-2 by both legs of both lenses, and useless as evidence because it
    // makes no claim.
    const graded = applyGrades(
      candidates,
      new Map([[0, 0], [1, 2], [2, 1], [3, 1]]),
      3,
    );

    assert.deepEqual(graded.map((h) => h.chunk_index), [1, 2, 3]);
  });

  it("breaks grade ties on the fused order, not the model's", () => {
    // Retrieval keeps the say wherever the reranker has no opinion, so a
    // rerank pass can only ever change the result where it graded differently.
    const graded = applyGrades(
      candidates,
      new Map([[0, 1], [1, 1], [2, 1], [3, 1]]),
      3,
    );

    assert.deepEqual(graded.map((h) => h.chunk_index), [0, 1, 2]);
  });

  it("falls back to the fused order when everything is graded zero", () => {
    // An empty evidence list would make the agent write from the job
    // description alone — the generic message this subsystem exists to prevent.
    const graded = applyGrades(
      candidates,
      new Map([[0, 0], [1, 0], [2, 0], [3, 0]]),
      2,
    );

    assert.deepEqual(graded.map((h) => h.chunk_index), [0, 1]);
  });

  it("treats a candidate the model never mentioned as grade zero", () => {
    const graded = applyGrades(candidates, new Map([[2, 2]]), 3);

    assert.deepEqual(graded.map((h) => h.chunk_index), [2]);
  });

  it("returns fewer than the limit rather than padding with rejects", () => {
    // Two good chunks and a limit of 3 must not become two good chunks plus the
    // skills wall. A short, specific message beats a padded one.
    const graded = applyGrades(candidates, new Map([[1, 2], [3, 2]]), 3);

    assert.equal(graded.length, 2);
  });

  it("never returns a chunk that was not a candidate", () => {
    const graded = applyGrades(candidates, new Map([[9, 2]]), 3);

    for (const h of graded) {
      assert.ok(candidates.some((c) => c.chunk_id === h.chunk_id));
    }
  });
});

describe("concernLensQuery", () => {
  const sandra = {
    recipientTitle: "Technical Recruiter | IT Recruitment",
    company: "Verdant Technology Outsourcing",
    persona: "Technical_Recruiter" as const,
  };

  /**
   * The role used to reach the task prompt and nothing else. Every ranking
   * signal — both dense queries, both sparse queries, and the rerank rubric —
   * was computed without knowing what job the message was about, so all of them
   * were answering "what is most impressive about this candidate?" A recruiter
   * screening an Oracle Fusion HCM vacancy got a client-satisfaction score from
   * an unrelated reconciliation tool, top-ranked and perfectly on-brief for the
   * question the system had actually asked.
   */
  it("names the role applied to", () => {
    const query = concernLensQuery({
      ...sandra,
      roleTitle: "Oracle Fusion HCM Functional Consultant",
    });

    assert.ok(query.includes("Oracle Fusion HCM Functional Consultant"));
  });

  it("still varies by recipient once the role is named", () => {
    // Naming the role must not recreate the deleted JD lens, which asked the
    // same question for every recipient and so returned a byte-identical
    // ranking for all six cases in the eval set.
    const role = "Oracle Fusion HCM Functional Consultant";
    const recruiter = concernLensQuery({ ...sandra, roleTitle: role });
    const engineer = concernLensQuery({
      ...sandra,
      recipientTitle: "Senior Backend Engineer",
      persona: "Peer_Engineer",
      roleTitle: role,
    });

    assert.notEqual(recruiter, engineer);
  });

  it("degrades to the reader-only question when no role is linked", () => {
    // A contact with no linked application has no role to be relevant to.
    // Interpolating "undefined" or an empty title into the embedded query would
    // poison the vector rather than leave it neutral.
    const query = concernLensQuery({ ...sandra, roleTitle: null });

    assert.ok(!query.includes("screening for"));
    assert.ok(!query.toLowerCase().includes("null"));
    assert.ok(!query.toLowerCase().includes("undefined"));
  });
});

describe("parseGrades", () => {
  it("reads a well-formed response", () => {
    const grades = parseGrades('{"grades":[{"id":0,"grade":2},{"id":1,"grade":0}]}', 2);

    assert.equal(grades.get(0), 2);
    assert.equal(grades.get(1), 0);
  });

  it("ignores ids outside the candidate range", () => {
    // A hallucinated id must not shift the meaning of a real one.
    const grades = parseGrades('{"grades":[{"id":7,"grade":2},{"id":-1,"grade":2}]}', 3);

    assert.equal(grades.size, 0);
  });

  it("clamps an out-of-range grade instead of discarding the response", () => {
    const grades = parseGrades('{"grades":[{"id":0,"grade":9},{"id":1,"grade":-4}]}', 2);

    assert.equal(grades.get(0), 2);
    assert.equal(grades.get(1), 0);
  });

  it("skips malformed rows and keeps the rest", () => {
    const grades = parseGrades(
      '{"grades":[null,{"id":"0","grade":2},{"id":1,"grade":2}]}',
      2,
    );

    assert.deepEqual([...grades.entries()], [[1, 2]]);
  });

  it("throws when there is no grades array, so the caller can fall back", () => {
    assert.throws(() => parseGrades('{"result":"ok"}', 2));
    assert.throws(() => parseGrades("not json", 2));
  });
});
