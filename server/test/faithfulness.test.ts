import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreFaithfulness } from "../src/eval/faithfulness";

const EVIDENCE = [
  "Maintained PeopleSoft HCM payroll integrations covering 32,330 hourly " +
    "employees across 41 states.",
  "Cut median time-to-offer from 31 days to 12 by collapsing four sequential " +
    "interviews into a single panel day.",
];

describe("scoreFaithfulness", () => {
  it("scores an exactly-quoted figure as fully grounded", () => {
    const score = scoreFaithfulness(
      "Priya, I maintained the payroll integrations for 32,330 hourly employees.",
      EVIDENCE,
    );

    assert.equal(score.figures, 1);
    assert.equal(score.numeric, 1);
    assert.deepEqual(score.ungrounded, []);
  });

  it("catches a rounded figure, which is the realistic failure", () => {
    // The model asked for a short message turns 32,330 into "over 30,000". The
    // recipient can hold the message next to the resume on the same
    // application, so this is the one failure the user cannot recover from.
    const score = scoreFaithfulness("I ran payroll for over 30,000 employees.", EVIDENCE);

    assert.deepEqual(score.ungrounded, ["30000"]);
    assert.equal(score.numeric, 0);
  });

  it("ignores thousands separators when matching", () => {
    const score = scoreFaithfulness("I covered 32330 hourly employees.", EVIDENCE);
    assert.equal(score.numeric, 1);
  });

  it("scores a qualitative draft as faithful rather than as empty", () => {
    // No figure is not a faithfulness failure. Scoring an empty numerator as 0
    // would push the model towards inventing numbers to raise the score.
    const score = scoreFaithfulness("I rebuilt the payroll integrations.", EVIDENCE);
    assert.equal(score.figures, 0);
    assert.equal(score.numeric, 1);
  });

  it("scores partial grounding proportionally", () => {
    const score = scoreFaithfulness("I covered 32,330 employees across 9 states.", EVIDENCE);
    assert.equal(score.figures, 2);
    assert.deepEqual(score.ungrounded, ["9"]);
    assert.equal(score.numeric, 0.5);
  });

  it("does not penalise a question about the recipient's own work", () => {
    // A question is not supposed to be supported by the sender's resume, and
    // scoring it as unsupported would mark every correctly targeted draft down
    // for being correctly targeted.
    const withQuestion = scoreFaithfulness(
      "I rebuilt the payroll integrations. How does your enrolment season run?",
      EVIDENCE,
    );
    const withoutQuestion = scoreFaithfulness("I rebuilt the payroll integrations.", EVIDENCE);

    assert.equal(withQuestion.lexical, withoutQuestion.lexical);
  });

  it("scores lexical support below 1 for vocabulary the evidence never used", () => {
    const grounded = scoreFaithfulness("I maintained PeopleSoft payroll integrations.", EVIDENCE);
    const invented = scoreFaithfulness("I architected quantum blockchain telemetry.", EVIDENCE);

    assert.ok(grounded.lexical > invented.lexical);
    assert.equal(invented.lexical, 0);
  });

  it("scores every figure ungrounded when there was no evidence at all", () => {
    // This used to assert the opposite, on the reasoning that "an unverifiable
    // claim is not the same as a false one". That reasoning is backwards. With
    // zero retrieved chunks the model had no source for any figure, so every
    // figure it produced was necessarily invented — which is exactly how a
    // message to a technical recruiter came to claim the sender had "improved
    // time-to-fill by 30%", a line lifted from her own job, scored as perfect.
    const score = scoreFaithfulness("I shipped 42 things.", []);
    assert.equal(score.numeric, 0);
    assert.deepEqual(score.ungrounded, ["42"]);
  });

  it("still scores a figure-free claim as faithful with no evidence", () => {
    // The numeric leg only judges figures. A qualitative sentence has none, so
    // an empty corpus must not drag it to zero.
    const score = scoreFaithfulness("I have worked on payroll systems.", []);
    assert.equal(score.numeric, 1);
    assert.deepEqual(score.ungrounded, []);
  });
});
