import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { draftPredatesProfile, isOncePerContact } from "../src/agent/draft";

/**
 * A draft is written the moment an acceptance is detected, which is normally
 * before the user has opened that person's profile. `generateDraft` hands back
 * a waiting unsent draft rather than writing a second one — correct, except
 * that it made reading the profile afterwards do nothing the user could see.
 *
 * Observed live: Sandra Ragaiey's draft was created at 11:00:41.087564+00:00
 * and her profile was read at 11:01:03.101+00:00, twenty-two seconds later.
 * She was linked to the Oracle application and had 583 characters of profile
 * text on file, and the message the panel kept showing her was still the
 * headline-only one that named neither.
 */
describe("draftPredatesProfile", () => {
  it("supersedes a draft written before the profile was read", () => {
    assert.equal(
      draftPredatesProfile(
        "2026-09-30T11:01:03.101+00:00",
        "2026-09-30T11:00:41.087564+00:00",
      ),
      true,
    );
  });

  it("keeps a draft written after the profile was read", () => {
    assert.equal(
      draftPredatesProfile(
        "2026-09-30T11:00:41.087564+00:00",
        "2026-09-30T11:01:03.101+00:00",
      ),
      false,
    );
  });

  // Why this is a function and not a `>` between two strings. PostgREST renders
  // `timestamptz` in whatever offset the connection asks for, and a string
  // compare reads the wall clock rather than the instant. Here the profile read
  // (11:00 UTC) genuinely comes after the draft (08:30 UTC), but as text
  // "11:00" sorts before "14:00" — so a string compare keeps serving the stale
  // draft. The same mistake already shipped once in services/followup.ts.
  it("compares instants, not wall-clock text", () => {
    const readAt = "2026-09-30T11:00:00.000+00:00";
    const draftedAt = "2026-09-30T14:00:00.000+05:30";
    assert.equal(readAt > draftedAt, false, "string order disagrees with time order");
    assert.equal(draftPredatesProfile(readAt, draftedAt), true);
  });

  it("treats the same instant in different zones as equal", () => {
    assert.equal(
      draftPredatesProfile("2026-09-30T11:00:00.000+00:00", "2026-09-30T16:30:00.000+05:30"),
      false,
    );
  });

  // Never read, or a timestamp we cannot parse, is not evidence of staleness.
  // Returning true here would regenerate on every click of Draft ready and burn
  // a full agent run each time.
  it("keeps the waiting draft when the profile has never been read", () => {
    assert.equal(draftPredatesProfile(null, "2026-09-30T11:00:41.087564+00:00"), false);
    assert.equal(draftPredatesProfile(undefined, "2026-09-30T11:00:41.087564+00:00"), false);
  });

  it("keeps the waiting draft on an unparseable timestamp", () => {
    assert.equal(draftPredatesProfile("not a date", "2026-09-30T11:00:41.087+00:00"), false);
    assert.equal(draftPredatesProfile("2026-09-30T11:01:03.101+00:00", "not a date"), false);
  });
});

/**
 * Observed live: Hassan Amr's initial outreach was created 08:51:06, marked
 * sent 09:08:17, and then written again at 10:48:47 — a hundred minutes after
 * it had gone out. The reuse check queried only unsent drafts, so a sent
 * message was invisible to it and every acceptance sweep and profile visit was
 * another chance to re-introduce the user to someone they had already written
 * to.
 */
describe("isOncePerContact", () => {
  it("treats an introduction as final", () => {
    assert.equal(isOncePerContact("initial_outreach"), true);
    assert.equal(isOncePerContact("connection_note"), true);
  });

  it("leaves follow-ups repeatable", () => {
    // Chasing twice is a legitimate thing to want, and it is the one message
    // type whose whole purpose is to be sent again.
    assert.equal(isOncePerContact("follow_up"), false);
  });
});
