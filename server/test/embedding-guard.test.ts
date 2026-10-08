import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { embeddingMismatch } from "../src/rag/embedding-guard";

const CURRENT = "text-embedding-3-small";

describe("embeddingMismatch", () => {
  it("passes a corpus embedded by the current model", () => {
    assert.equal(embeddingMismatch([CURRENT], CURRENT), null);
  });

  it("treats an empty corpus as searchable, not as a mismatch", () => {
    // "No resume indexed" is a state the agent handles with an explicit
    // no-evidence tool response. Throwing here would turn a degraded draft into
    // a failed one for every contact whose application has no resume.
    assert.equal(embeddingMismatch([], CURRENT), null);
  });

  it("catches a same-width swap, which nothing else catches", () => {
    // ada-002 is also 1536 dimensions, so vector(1536) accepts it and cosine
    // distance keeps returning numbers. This is the whole reason the column
    // exists; a width change would already have failed at the insert.
    const problem = embeddingMismatch(["text-embedding-ada-002"], CURRENT);
    assert.ok(problem);
    assert.match(problem, /text-embedding-ada-002/);
    assert.match(problem, /text-embedding-3-small/);
  });

  it("names the way out, not just the problem", () => {
    const problem = embeddingMismatch(["text-embedding-ada-002"], CURRENT);
    assert.match(problem!, /Re-index|EMBEDDING_MODEL/);
  });

  it("rejects a corpus split across two models even if one is current", () => {
    // A half-re-indexed resume: some chunks re-embedded, some not. The current
    // model being present is not enough — the rows that disagree are still
    // being ranked against the same query vector.
    const problem = embeddingMismatch([CURRENT, "text-embedding-ada-002"], CURRENT);
    assert.ok(problem);
  });
});
