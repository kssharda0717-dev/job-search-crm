import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { misattributedFigures, repairFigures } from "../src/agent/critique";

/**
 * Lifted verbatim from `eval/fixtures/resume.txt`, with the section prefix the
 * chunker now attaches. Every figure below is one the real resume states, which
 * is the point: these checks only ever fire on numbers that are genuinely in
 * the corpus, so a synthetic fixture would prove nothing about either of them.
 */
const PARTITIONS =
  "EXPERIENCE\nOwned the partition rebalancing strategy during a migration " +
  "from 12 to 96 partitions, holding p99 consumer lag under 30 seconds " +
  "through the cutover.";

const STARTUP =
  "EXPERIENCE\nTook the product from zero to 1,200 paying customers and " +
  "840,000 dollars of annual recurring revenue before the Series A.";

const PAYROLL =
  "EXPERIENCE\nMaintained PeopleSoft HCM payroll integrations covering " +
  "32,330 hourly employees across 41 states, including the retroactive " +
  "pay-adjustment pipeline.";

describe("misattributedFigures", () => {
  it("catches a real figure welded onto work it did not come from", () => {
    // The failure this exists for: every grounding check in the system passed
    // the sentence, because 840,000 *is* in the evidence. What the resume never
    // said is that the Kafka work produced the revenue — the agent invented the
    // link, and the recipient reads one sentence asserting it.
    const problems = misattributedFigures(
      "I owned the partition rebalancing strategy during a migration from 12 " +
        "to 96 partitions, which supported 840,000 dollars of annual recurring revenue.",
      [PARTITIONS, STARTUP],
    );

    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /840000/);
    assert.match(problems[0]!, /belongs to a different piece of work/);
  });

  it("leaves a sentence alone when every figure came from the work described", () => {
    const problems = misattributedFigures(
      "I owned the partition rebalancing strategy during a migration from 12 " +
        "to 96 partitions, holding p99 consumer lag under 30 seconds.",
      [PARTITIONS, STARTUP],
    );

    assert.deepEqual(problems, []);
  });

  it("stays quiet when the sentence draws on both passages about equally", () => {
    // A deliberate limit, not an oversight. This sentence is half one job and
    // half another, so there is no passage it is clearly *about*, and firing
    // here would mean firing on honest drafts that summarise two roles. A
    // critique that cannot be satisfied burns both repair passes and discards
    // every rewrite, so the margin is set to let this one through.
    const problems = misattributedFigures(
      "I ran the platform team's technical interview loop for two years, " +
        "along with holding p99 consumer lag under 30 seconds.",
      [
        PARTITIONS,
        "EXPERIENCE\nRan the platform team's technical interview loop for two " +
          "years, interviewing 96 candidates and rewriting the take-home exercise.",
      ],
    );

    assert.deepEqual(problems, []);
  });

  it("cannot judge attribution from a single passage", () => {
    // With one chunk there is no "different piece of work" to move a figure
    // from, and the margin comparison is meaningless.
    const problems = misattributedFigures(
      "I owned the rollout, which supported 840,000 dollars of revenue.",
      [PARTITIONS],
    );

    assert.deepEqual(problems, []);
  });
});

describe("repairFigures", () => {
  it("restores the exact figure the draft rounded off", () => {
    // Faithfulness sat at 0.833 on exactly this: asked for a short message, the
    // model writes "over 32,000" for 32,330. Prompting and critique have both
    // failed to stop it, and the recipient can hold the message next to the
    // resume on the same application.
    const repaired = repairFigures(
      "I maintained the payroll integrations for over 32,000 hourly employees.",
      [PAYROLL],
    );

    assert.equal(
      repaired,
      "I maintained the payroll integrations for 32,330 hourly employees.",
    );
  });

  it("leaves the hedge in place when the figure is already exact", () => {
    // "nearly 1,200" understates a figure the resume states exactly, which is
    // sloppy but not ungrounded. This repairs figures, not wording — the repair
    // loop owns the sentence, and widening this to edit prose would put a
    // deterministic rewriter in competition with it.
    const draft = "We reached nearly 1,200 customers.";
    assert.equal(repairFigures(draft, [STARTUP]), draft);
  });

  it("leaves a figure of a different magnitude alone", () => {
    // "nearly 1 million" from 840,000 is a rewrite, not a rounding. Repairing
    // it to 840,000 would be guesswork about what the model meant; the figure
    // is left for `ungroundedNumbers` to flag instead.
    const draft = "We reached nearly 1 million dollars of annual recurring revenue.";
    assert.equal(repairFigures(draft, [STARTUP]), draft);
  });

  it("never rewrites a year", () => {
    // 2020 is one trailing zero away from the resume's 2021 and passes every
    // rounding test, so without the year guard this quietly moves a date.
    const draft = "I have worked on payroll systems since 2020.";
    assert.equal(repairFigures(draft, [PAYROLL, "Senior Engineer, 2021 to present."]), draft);
  });

  it("refuses to choose when two figures could both be the source", () => {
    // 90 is a plausible rounding of both 96 and 99, and the chunk contains
    // both. Picking one would be inventing a claim with more confidence than
    // the draft had.
    const draft = "I ran the cutover across about 90 partitions.";
    assert.equal(repairFigures(draft, [PARTITIONS]), draft);
  });

  it("leaves an exact quotation untouched", () => {
    const draft = "I covered 32,330 hourly employees across 41 states.";
    assert.equal(repairFigures(draft, [PAYROLL]), draft);
  });

  it("refuses to move a figure between two different units", () => {
    // The one way this function can invent a claim instead of merely failing to
    // fix one. "about 30 seconds" against the resume's "31 days" satisfies every
    // numeric test — a single candidate, 3% apart, two digits each, both leading
    // 3, and rounder — so before the unit guard it wrote "31 seconds": a precise
    // figure imported from an unrelated claim, under the user's name.
    const draft = "I cut the turnaround to about 30 seconds.";
    assert.equal(
      repairFigures(draft, ["EXPERIENCE\nReduced onboarding from 31 days to 9 days."]),
      draft,
    );
  });

  it("still un-rounds a ratio, where the denominator is the only shared unit", () => {
    // The unit guard must not be so strict that it blocks the repairs this
    // exists for. "9 out of 10" and "9.5/10" share no prose at all; the "10" is
    // the whole of the evidence that they measure the same thing.
    assert.equal(
      repairFigures("I kept client satisfaction above 9 out of 10.", [
        "SUMMARY\nSustained client satisfaction of 9.5/10 over nine months.",
      ]),
      "I kept client satisfaction above 9.5 out of 10.",
    );
  });

  it("changes nothing when there was no evidence at all", () => {
    // An empty corpus is the strictest grounding case, but it is not a case
    // repair can do anything about: there is no source figure to restore.
    const draft = "I shipped 42 things.";
    assert.equal(repairFigures(draft, []), draft);
  });
});
