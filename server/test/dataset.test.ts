import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { RETRIEVAL_CASES } from "../eval/retrieval-cases";
import { FIXTURE_PATH, resolveCase } from "../src/eval/dataset";
import { chunkResumeText } from "../src/rag/chunk";

const CHUNKS = chunkResumeText(readFileSync(FIXTURE_PATH, "utf8"));

describe("the labelled retrieval set", () => {
  it("chunks the fixture into more than one retrieval unit", () => {
    // A single-chunk fixture would score 1.0 for any retriever at all.
    assert.ok(CHUNKS.length > 3, `fixture produced ${CHUNKS.length} chunks`);
  });

  // This is the check that keeps the eval honest without a database. If anyone
  // tunes CHUNK_TARGET_CHARS or edits the fixture, a marker stops matching and
  // this fails here rather than showing up as an unexplained drop in recall.
  for (const testCase of RETRIEVAL_CASES) {
    it(`resolves every marker for "${testCase.id}"`, () => {
      const resolved = resolveCase(testCase, CHUNKS);

      assert.ok(
        resolved.relevantChunks.length > 0,
        `${testCase.id} has no relevant chunks: ${testCase.rationale}`,
      );
      // A chunk cannot be both the answer and the trap. When it is, the case
      // can never pass and the metric is measuring the label, not the search.
      const overlap = resolved.relevantChunks.filter((index) =>
        resolved.forbiddenChunks.includes(index),
      );
      assert.deepEqual(
        overlap,
        [],
        `${testCase.id}: chunk(s) ${overlap.join(", ")} are labelled both relevant and forbidden`,
      );
    });
  }

  it("throws rather than silently skipping a marker that matches nothing", () => {
    assert.throws(
      () =>
        resolveCase(
          {
            id: "stale",
            recipientTitle: "x",
            persona: "Peer_Engineer",
            relevantMarkers: ["a phrase this fixture does not contain"],
            rationale: "",
          },
          CHUNKS,
        ),
      /matches no chunk/,
    );
  });

  it("keeps the skills wall out of every gold set", () => {
    // The wall matches almost any keyword query and contains no system, no
    // number and no decision. If it ever became a correct answer, the eval
    // would start rewarding the exact failure it was built to catch.
    const wall = CHUNKS.findIndex((chunk) => chunk.includes("Python, Go, TypeScript, Java"));
    assert.notEqual(wall, -1, "the fixture lost its skills wall");

    for (const testCase of RETRIEVAL_CASES) {
      assert.ok(
        !resolveCase(testCase, CHUNKS).relevantChunks.includes(wall),
        `${testCase.id} labels the skills wall as relevant`,
      );
    }
  });
});
