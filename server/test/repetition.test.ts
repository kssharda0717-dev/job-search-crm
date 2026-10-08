import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askAnchors, critiqueDraft, repeatsThread } from "../src/agent/critique";

/**
 * The prompt asked nicely and the model said no.
 *
 * ADR-048 put the thread in the task prompt and told the model not to reuse the
 * opening, the evidence or the question. Every draft produced on 2026-10-01
 * after that change did at least one of the three. These tests are the real
 * messages, and they exist because this file is the only place in the system
 * where a quality rule is actually binding — everything in the system prompt
 * alone is a suggestion with a repair pass that never fires.
 */

const KRISTINA_OPENER =
  "Lena, I applied for the Product Manager of AI Applications role on your " +
  "Global Public Sector team. My recent experience involved taking loosely defined " +
  "problems from users and developing tested, working products quickly, including a " +
  "three-app platform built in just three days. I'm curious, how does your team " +
  "ensure that the AI solutions you build are aligned with the specific needs of " +
  "government clients?";

const KRISTINA_FOLLOW_UP =
  "Lena, I wanted to follow up on my application for the Product Manager of AI " +
  "Applications role. In my recent project, I maintained client satisfaction above " +
  "9.5/10 for nine straight months while developing tools to streamline complex data " +
  "for users. How does your team ensure the solutions you create are effectively " +
  "tailored to meet the unique needs of government clients?";

const STAVRI_OPENER =
  "Nikos, I applied for the AI Adoption and Transformation Lead role and wanted to " +
  "connect. I've spent over five years running enterprise systems where accuracy is " +
  "critical, including shipping LLM applications that are actively used by " +
  "non-technical operators. I'm curious about how your team approaches the " +
  "integration of AI in daily operations and any recurring challenges you see in " +
  "that process.";

const STAVRI_FOLLOW_UP =
  "Nikos, following up on my application for the AI Adoption and Transformation " +
  "Lead role. I've built LLM applications that non-technical operators use monthly, " +
  "including a commission reconciliation engine designed with strict auditing " +
  "controls. What qualities or experiences are you prioritizing in candidates for " +
  "this position?";

describe("repeatsThread", () => {
  it("says nothing when there is no thread — a first message cannot repeat one", () => {
    assert.deepEqual(repeatsThread(KRISTINA_FOLLOW_UP, []), []);
  });

  it("catches the same question reworded, which is what actually shipped", () => {
    // "how does your team ensure that the AI solutions you build are aligned with
    // the specific needs of government clients" became "how does your team ensure
    // the solutions you create are effectively tailored to meet the unique needs
    // of government clients". Six days apart, in one scroll.
    const problems = repeatsThread(KRISTINA_FOLLOW_UP, [KRISTINA_OPENER]);
    assert.ok(problems.some((p) => /question you already asked/.test(p)));
  });

  it("catches reused evidence even when the question is new", () => {
    // Nikos's follow-up asked something different and still recycled the
    // opener's one claim: "LLM applications that are actively used by
    // non-technical operators" → "LLM applications that non-technical operators
    // use monthly".
    const problems = repeatsThread(STAVRI_FOLLOW_UP, [STAVRI_OPENER]);
    assert.ok(problems.some((p) => /same claim you made/.test(p)));
  });

  it("catches a figure the recipient has already been sent", () => {
    const problems = repeatsThread(
      "Lena, client satisfaction stayed above 9.5/10 there.",
      ["Lena, I kept client satisfaction above 9.5/10 for nine straight months."],
    );
    assert.ok(problems.some((p) => /already told them 9.5/.test(p)));
  });

  it("does not count naming the role as repetition", () => {
    // RULE 2 requires the follow-up to name the role the opener named. Counting
    // that as a repeat would make the critique unsatisfiable — the repair pass
    // would rewrite forever and the rewrite would be discarded every time,
    // which is a failure this codebase has already shipped once.
    const problems = repeatsThread(
      "Nikos, on the AI Adoption and Transformation Lead role: the reconciliation " +
        "engine I built runs to the paisa against 424 tests.",
      [
        "Nikos, I applied for the AI Adoption and Transformation Lead role and " +
          "wanted to connect.",
      ],
      "AI Adoption and Transformation Lead",
    );
    assert.deepEqual(problems, []);
  });

  it("passes a follow-up that brings new evidence and a narrower question", () => {
    const problems = repeatsThread(
      "Lena, I asked a broad question last week — here is the narrower one. " +
        "The reconciliation tool I built flagged 19 holdings of dormant assets in " +
        "its first live month. Is procurement or evaluation the harder gate for a " +
        "tool like that on your side?",
      [KRISTINA_OPENER],
      "Product Manager of AI Applications",
    );
    assert.deepEqual(problems, []);
  });
});

describe("critiqueDraft — the closing question", () => {
  const context = { recipientFirstName: "Nikos", roleTitle: null, persona: null };

  function closers(draft: string, anchors: string[] = []): string[] {
    return critiqueDraft(draft, { ...context, anchors }).problems.filter((p) =>
      /category rather than a thing/.test(p),
    );
  }

  it("rejects the survey closers that shipped on 2026-10-01", () => {
    for (const ask of [
      "Do you have any insights on that?",
      "What tools or processes do you find most effective for this?",
      "What practices do you have in place to monitor performance over time?",
      "What qualities or experiences are you prioritizing in candidates for this position?",
      "What do you see as the key skills that contribute to success in this position?",
      "In your experience, what methods have you found most effective?",
    ]) {
      assert.equal(closers(`Nikos, one fact. ${ask}`).length, 1, ask);
    }
  });

  it("reports the closing line once, not once per overlapping pattern", () => {
    assert.equal(
      closers(
        "Nikos, one fact. In your experience, what methods have you found most effective?",
      ).length,
      1,
    );
  });

  it("accepts a question anchored to something only this recipient knows", () => {
    assert.deepEqual(
      closers(
        "Nikos, the reconciliation engine I built runs deterministically on the " +
          "client's own machine. For lumera's rollout, is the blocker getting " +
          "operators to trust the output or getting the data clean enough to feed it?",
      ),
      [],
    );
  });

  it("accepts a message with no question at all", () => {
    assert.deepEqual(
      closers(
        "Nikos, I built a reconciliation engine that flagged 19 dormant holdings " +
          "in its first live month. That is the kind of work the role describes.",
      ),
      [],
    );
  });

  it("is not defeated by an adjective, which is how the repair pass escaped", () => {
    // The 07:02 run on 2026-10-01: the critique flagged "What qualities or
    // experiences are you prioritizing in candidates for this position?", two
    // repair passes ran, and the draft that shipped said "What SPECIFIC skills
    // or experiences…". One word inserted between "what" and the noun defeated
    // the pattern and `critique_problems` was recorded as 0. `repairDraft`
    // minimises the problem count, so a deny-list of phrasings is something the
    // model is paid to walk around.
    assert.equal(
      closers(
        "Nikos, one fact. What specific skills or experiences are you " +
          "prioritizing in candidates for this position?",
      ).length,
      1,
    );
  });

  it("catches a survey question that is not phrased as 'what ...'", () => {
    // Daniel's follow-up, same run. No pattern in the old list began with "are".
    assert.equal(
      closers(
        "Daniel, I wanted to follow up. Are there specific skills or technologies " +
          "that you see in high demand right now?",
      ).length,
      1,
    );
  });

  it("does not let a category word in the recipient's own headline anchor the ask", () => {
    // Nikos Pallas's headline is "Recruitment Manager | Matching Skills to
    // Opportunities | FinTech". Treating every headline word as an anchor made
    // her own tagline excuse "What specific skills are you prioritizing in
    // candidates?" — the check would have gone quiet on the draft it was
    // written for.
    assert.equal(
      closers(
        "Nikos, one fact. What specific skills are you prioritizing in candidates?",
        askAnchors("Recruitment Manager | Matching Skills to Opportunities | FinTech", {
          roleTitle: "AI Adoption and Transformation Lead",
          company: "lumera",
        }),
      ).length,
      1,
    );
  });

  it("stays silent once the question names something only this recipient has", () => {
    assert.deepEqual(
      closers(
        "Lena, one fact. Which of those two is the harder gate for Vector AI's " +
          "public-sector deployments?",
        askAnchors(null),
      ),
      [],
    );
  });

  it("does not let the employer anchor a survey question", () => {
    // Nadia Haddad, live, 2026-10-03. "challenges" matched ABSTRACT_SUBJECT and
    // the word "Vantage Staffing" anchored it, so critique_problems was recorded as 0
    // and the message was shown as clean. RULE 2 puts the employer in every
    // opening message, so counting it as an anchor switched the check off for
    // the entire message type it was written for.
    assert.equal(
      closers(
        "Nadia, I applied for the AI Specialist position at Vantage Staffing Middle " +
          "East. What specific challenges do you see for this role at Vantage Staffing?",
        askAnchors("Recruiter @ Vantage Staffing UAE | IT Recruitment, Global Recruiting", {
          roleTitle: "AI Specialist",
          company: "Vantage Staffing Middle East",
        }),
      ).length,
      1,
    );
  });

  it("subtracts the employer from the headline, not just from the anchor list", () => {
    // The first attempt at the fix withheld the company as a direct anchor and
    // changed nothing on the live row: her headline *is* "Recruiter @ Vantage Staffing
    // UAE | …", so "lancesoft" came straight back as a headline word. Anything
    // the draft is obliged to say has to be removed wherever it appears.
    assert.ok(
      !askAnchors("Recruiter @ Vantage Staffing UAE | IT Recruitment, Global Recruiting", {
        roleTitle: "AI Specialist",
        company: "Vantage Staffing Middle East",
      }).includes("lancesoft"),
    );
  });

  it("does not let the role title anchor one either", () => {
    assert.equal(
      closers(
        "Nadia, one fact. What challenges come up most in the AI Specialist search?",
        askAnchors("Recruiter @ Vantage Staffing UAE | IT Recruitment", {
          roleTitle: "AI Specialist",
          company: "Vantage Staffing Middle East",
        }),
      ).length,
      1,
    );
  });

  it("accepts an anchor the recipient put in their own headline", () => {
    // "sourcing" is hers, not ours, and it is not a category noun — so the
    // question could not have been sent to anyone else.
    assert.deepEqual(
      closers(
        "Nadia, one fact. Of the two, which causes more sourcing trouble for you?",
        askAnchors("Recruiter @ Vantage Staffing UAE | IT Recruitment, Sourcing", {
          roleTitle: "AI Specialist",
          company: "Vantage Staffing Middle East",
        }),
      ),
      [],
    );
  });
});

describe("repeatsThread — the 2026-10-01 07:02 follow-ups", () => {
  it("catches a reworded question that shares only three words with the original", () => {
    // The follow-up that shipped after ADR-049. "…how does your team ensure
    // that the AI solutions you build are aligned with the specific needs of
    // government clients?" came back as "How does your team approach gathering
    // feedback during the development of AI solutions for government clients?"
    // Same question, same object, 3 of 8 content words shared — under the 50%
    // ratio the check used, so it shipped.
    const problems = repeatsThread(
      "Lena, I wanted to follow up regarding my application for the Product " +
        "Manager of AI Applications role. How does your team approach gathering " +
        "feedback during the development of AI solutions for government clients?",
      [KRISTINA_OPENER],
      "Product Manager of AI Applications",
      "Vector AI",
    );
    assert.ok(problems.some((p) => /question you already asked/.test(p)));
  });

  it("does not count naming the employer as repetition", () => {
    // The draft is required to name the company, so sharing it with the opener
    // is compliance. Counting it would push every follow-up a word closer to an
    // unsatisfiable critique.
    assert.deepEqual(
      repeatsThread(
        "Nikos, the reconciliation engine I built runs to the paisa against 424 " +
          "tests. Is lumera's harder gate the data or the sign-off?",
        ["Nikos, I applied for the lumera AI Adoption and Transformation Lead role."],
        "AI Adoption and Transformation Lead",
        "lumera",
      ),
      [],
    );
  });
});
