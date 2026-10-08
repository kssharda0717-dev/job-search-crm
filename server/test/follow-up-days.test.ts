import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SyncObservationsRequest } from "@crm/shared";
import {
  clampFollowUpDays,
  DEFAULT_FOLLOW_UP_DAYS,
  MAX_FOLLOW_UP_DAYS,
  MIN_FOLLOW_UP_DAYS,
} from "@crm/shared/constants";

describe("clampFollowUpDays", () => {
  it("keeps an in-range number", () => {
    assert.equal(clampFollowUpDays(12), 12);
    assert.equal(clampFollowUpDays("12"), 12);
  });

  it("falls back to the default on an empty field", () => {
    // `<input type="number">` reports "" while the user is clearing it, and
    // Number("") is 0 — the one value that makes the next sweep call every
    // accepted contact overdue at once.
    assert.equal(clampFollowUpDays(""), DEFAULT_FOLLOW_UP_DAYS);
    assert.equal(clampFollowUpDays("abc"), DEFAULT_FOLLOW_UP_DAYS);
  });

  it("clamps to the bounds rather than rejecting", () => {
    assert.equal(clampFollowUpDays(-3), MIN_FOLLOW_UP_DAYS);
    assert.equal(clampFollowUpDays(9999), MAX_FOLLOW_UP_DAYS);
  });

  it("rounds, because the server contract requires an integer", () => {
    assert.equal(clampFollowUpDays(3.6), 4);
  });
});

describe("SyncObservationsRequest.followUpDays", () => {
  it("defaults when the field is absent", () => {
    // Older builds of the extension post without it. Defaulting here keeps the
    // sweep running rather than 400-ing the request that drives it.
    const parsed = SyncObservationsRequest.parse({ observations: [] });
    assert.equal(parsed.followUpDays, DEFAULT_FOLLOW_UP_DAYS);
  });

  it("carries the user's value through", () => {
    const parsed = SyncObservationsRequest.parse({
      observations: [],
      followUpDays: 14,
    });
    assert.equal(parsed.followUpDays, 14);
  });

  it("refuses a value the panel would not have produced", () => {
    // The clamp above is the panel's job; this is the boundary check. A 0 here
    // would mark every accepted contact Follow_Up_Required on the next sweep.
    for (const bad of [0, -1, MAX_FOLLOW_UP_DAYS + 1, 2.5]) {
      assert.throws(() =>
        SyncObservationsRequest.parse({ observations: [], followUpDays: bad }),
      );
    }
  });
});
