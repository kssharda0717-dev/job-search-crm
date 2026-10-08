import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMeter, recordUsage } from "../src/observability/meter";

describe("UsageMeter", () => {
  it("starts at zero on every axis", () => {
    assert.deepEqual(createMeter(), { promptTokens: 0, completionTokens: 0, calls: 0 });
  });

  it("sums across the calls a single run makes", () => {
    // A run is the ReAct turns plus the reranker plus the repair passes. Only
    // the total is the cost of the run.
    const meter = createMeter();
    recordUsage(meter, { prompt_tokens: 1200, completion_tokens: 80 });
    recordUsage(meter, { prompt_tokens: 900, completion_tokens: 40 });
    recordUsage(meter, { prompt_tokens: 1500, completion_tokens: 120 });

    assert.equal(meter.promptTokens, 3600);
    assert.equal(meter.completionTokens, 240);
    assert.equal(meter.calls, 3);
  });

  it("counts a call whose usage the API omitted", () => {
    // This is the rule the whole module exists for. A call with unknown token
    // cost was still billed; skipping it would report the run as cheaper than
    // it was, silently. Counting it leaves a visible discrepancy instead —
    // calls high, tokens low.
    const meter = createMeter();
    recordUsage(meter, undefined);
    recordUsage(meter, null);
    recordUsage(meter, {});

    assert.equal(meter.calls, 3);
    assert.equal(meter.promptTokens, 0);
    assert.equal(meter.completionTokens, 0);
  });

  it("does not let a missing field zero out the running total", () => {
    const meter = createMeter();
    recordUsage(meter, { prompt_tokens: 500, completion_tokens: 25 });
    recordUsage(meter, { prompt_tokens: 300 });

    assert.equal(meter.promptTokens, 800);
    assert.equal(meter.completionTokens, 25);
    assert.equal(meter.calls, 2);
  });
});
