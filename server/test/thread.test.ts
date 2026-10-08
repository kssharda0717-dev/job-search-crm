import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "@crm/shared";
import { priorThread, threadBlock } from "../src/agent/thread";

/**
 * A follow-up has to know what it is following.
 *
 * Replayed from the real thread with one contact on 2026-10-01: an opener sent
 * on 09-25 and a follow-up generated six days later that repeated its pitch and
 * re-asked its question, because `buildTaskPrompt` had never carried the
 * conversation.
 */

const NOW = Date.parse("2026-10-01T05:49:53Z");

function message(partial: Partial<Message>): Message {
  return {
    id: "m",
    contact_id: "c",
    job_id: "j",
    type: "initial_outreach",
    draft_text: "draft",
    sent_text: null,
    sent_at: null,
    created_at: "2026-09-25T02:14:51Z",
    ...partial,
  } as Message;
}

describe("priorThread", () => {
  it("drops unsent drafts — the recipient has never seen them", () => {
    const thread = priorThread([
      message({ id: "sent", sent_at: "2026-09-25T14:39:37Z", sent_text: "hello" }),
      message({ id: "waiting", type: "follow_up" }),
    ]);
    assert.deepEqual(thread.map((m) => m.id), ["sent"]);
  });

  it("orders oldest first, whatever order the rows arrive in", () => {
    const thread = priorThread([
      message({ id: "second", type: "follow_up", sent_at: "2026-09-28T09:00:00Z" }),
      message({ id: "first", sent_at: "2026-09-25T14:39:37Z" }),
    ]);
    assert.deepEqual(thread.map((m) => m.id), ["first", "second"]);
  });
});

describe("threadBlock", () => {
  it("returns null when nothing has been sent, so an empty thread is not rendered as one", () => {
    assert.equal(threadBlock([], NOW), null);
    assert.equal(threadBlock([message({})], NOW), null);
  });

  it("carries what the recipient actually read, not what was drafted", () => {
    const block = threadBlock(
      [
        message({
          draft_text: "the version the agent wrote",
          sent_text: "the version the user edited and sent",
          sent_at: "2026-09-25T14:39:37Z",
        }),
      ],
      NOW,
    );
    assert.ok(block);
    assert.ok(block.includes("the version the user edited and sent"));
    assert.ok(!block.includes("the version the agent wrote"));
  });

  it("falls back to the draft when a message was marked sent without its text", () => {
    const block = threadBlock(
      [message({ draft_text: "only a draft", sent_text: null, sent_at: "2026-09-25T14:39:37Z" })],
      NOW,
    );
    assert.ok(block?.includes("only a draft"));
  });

  it("dates each message so the model can see how stale the thread is", () => {
    const block = threadBlock(
      [message({ sent_at: "2026-09-25T14:39:37Z", sent_text: "opener" })],
      NOW,
    );
    assert.ok(block?.includes("initial outreach, sent 5 days ago"));
  });

  it("names the three ways a follow-up repeats itself", () => {
    const block = threadBlock(
      [message({ sent_at: "2026-09-25T14:39:37Z", sent_text: "opener" })],
      NOW,
    )!;
    // The real failure reused all three at once: same opening, same achievement,
    // same question reworded.
    assert.ok(/opening line/.test(block));
    assert.ok(/achievement or figure/.test(block));
    assert.ok(/same question/.test(block));
  });
});
