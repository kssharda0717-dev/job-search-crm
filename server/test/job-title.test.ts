import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { looksLikeJobTitle } from "@crm/shared/job-title";

describe("looksLikeJobTitle", () => {
  it("refuses the three labels that reached the live database", () => {
    // Three applications were filed under these. A title is not cosmetic — it
    // feeds extractRoleKeywords, the concern lens and the rerank rubric — so
    // every ranking signal for those rows was steered by a button label.
    assert.equal(looksLikeJobTitle("Share negative feedback"), null);
    assert.equal(looksLikeJobTitle("Remote"), null);
  });

  it("keeps a real title that starts with a filter pill's word", () => {
    // Why the rules are exact matches rather than prefixes. "Remote" alone is
    // the filter pill; "Remote Data Entry Administrator" is somebody's job.
    assert.equal(
      looksLikeJobTitle("Remote Data Entry Administrator"),
      "Remote Data Entry Administrator",
    );
    assert.equal(looksLikeJobTitle("Hybrid Cloud Architect"), "Hybrid Cloud Architect");
  });

  it("refuses the rest of LinkedIn's furniture", () => {
    for (const label of [
      "Easy Apply",
      "Dismiss",
      "Undo",
      "Saved",
      "On-site",
      "Onsite",
      "Job dismissed",
      "Job saved to your list",
      "We won't show you this job again",
    ]) {
      assert.equal(looksLikeJobTitle(label), null, label);
    }
  });

  it("trims, and treats a blank as nothing read rather than as a title", () => {
    assert.equal(looksLikeJobTitle("  Staff Engineer  "), "Staff Engineer");
    assert.equal(looksLikeJobTitle("   "), null);
    assert.equal(looksLikeJobTitle(null), null);
    assert.equal(looksLikeJobTitle(undefined), null);
  });

  it("is case-insensitive, because the DOM is not consistent about it", () => {
    assert.equal(looksLikeJobTitle("SHARE NEGATIVE FEEDBACK"), null);
    assert.equal(looksLikeJobTitle("remote"), null);
  });
});
