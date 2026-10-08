import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  echoesJobDescription,
  isSummaryChunk,
  summaryOnlyFigures,
} from "../src/agent/critique";

/**
 * The message sent to Nadia Haddad on 2026-10-03, and the inputs it was built
 * from, taken verbatim from the live rows.
 *
 * It is the reason both of these checks exist. Every guard in `critique.ts`
 * passed it — `review` recorded `problems: [], ungroundedFigures: []` — and it
 * told an agency recruiter the candidate had five years of AI experience he
 * does not have, in wording she had written herself.
 */
const RAMYA_DRAFT =
  "Nadia, I recently applied for the AI Specialist position at Vantage Staffing " +
  "Middle East. I have over 5 years of experience developing and deploying AI " +
  "solutions in production environments, including designing and shipping LLM " +
  "applications end to end. I'm particularly skilled in Python and SQL, and " +
  "have built systems that maintain client satisfaction above 9.5/10 for nine " +
  "consecutive months. What specific challenges do you see for this role at " +
  "Vantage Staffing?";

const LANCESOFT_JD =
  "Job Title: AI Specialist\nLocation: Dubai\nDuration: Permanent\n" +
  "Years & nature of experience\n" +
  "3-5 years of experience developing and deploying AI or machine-learning " +
  "solutions in production environments.\n" +
  "Core Competencies\n" +
  "Strong programming skills in Python and SQL, with sound software-engineering " +
  "practice (version control, testing, API design).\n" +
  "Experience in regulated or service-oriented environments such as government, " +
  "free zones, healthcare, or financial services is preferred.";

/** Chunk 1 of the resume filed for this application. */
const SUMMARY_CHUNK =
  "PROFESSIONAL SUMMARY\n" +
  "AI specialist with 5+ years running production enterprise systems for " +
  "Fortune 500 clients in US healthcare and aerospace, now designing and " +
  "shipping LLM applications end to end. I work in Python, SQL and TypeScript, " +
  "ship with Docker and CI/CD, and explain technical trade-offs to " +
  "non-technical stakeholders (client satisfaction above 9.5/10 for nine " +
  "consecutive months).";

/** Chunk 17, which the retriever did not return. */
const PAYROLL_CHUNK =
  "PROFESSIONAL EXPERIENCE\n" +
  "Led weekly stakeholder reviews through six weeks of go-live support, " +
  "explaining SQR / PeopleCode logic in plain language; sustained client " +
  "satisfaction above 9.5/10 for nine consecutive months.";

const PROJECT_CHUNK =
  "AI PROJECTS\n" +
  "Designed two-lens hybrid retrieval: each lens fuses pgvector cosine and " +
  "Postgres full-text rankings with Reciprocal Rank Fusion, and an LLM " +
  "reranker then drops resume evidence the reader has no reason to reply to.";

const CONTEXT = {
  evidence: [SUMMARY_CHUNK, PROJECT_CHUNK],
  roleTitle: "AI Specialist",
  company: "Vantage Staffing Middle East",
};

describe("echoesJobDescription", () => {
  it("catches the advert being read back to the person who posted it", () => {
    const problems = echoesJobDescription(RAMYA_DRAFT, LANCESOFT_JD, CONTEXT);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /experience developing deploying/);
    assert.match(problems[0]!, /lifted from the job description/);
  });

  it("reports one problem however many runs matched", () => {
    // `repairDraft` ranks rewrites by problem count. Three fragments of one
    // sentence would let a rewrite that deleted a clause outscore one that
    // rephrased the claim.
    assert.equal(echoesJobDescription(RAMYA_DRAFT, LANCESOFT_JD, CONTEXT).length, 1);
  });

  it("allows a phrase the resume genuinely contains", () => {
    // The ad and the CV both say this, because it is what the work is called.
    // Flagging it would push the model off its own evidence.
    const draft =
      "Priya, I applied for the role. I built retrieval augmented generation " +
      "pipelines with hybrid vector search and release-blocking evaluation gates.";
    const jd =
      "You will build retrieval augmented generation pipelines with hybrid " +
      "vector search and release-blocking evaluation gates.";
    const evidence = [
      "AI PROJECTS\nBuilt retrieval augmented generation pipelines with hybrid " +
        "vector search and release-blocking evaluation gates.",
    ];
    assert.deepEqual(
      echoesJobDescription(draft, jd, { evidence, roleTitle: null, company: null }),
      [],
    );
  });

  it("does not count the role and the employer, which RULE 2 requires", () => {
    const draft =
      "Nadia, I recently applied for the AI Specialist position at Vantage Staffing " +
      "Middle East, which is a permanent role in Dubai.";
    assert.deepEqual(
      echoesJobDescription(draft, LANCESOFT_JD, {
        evidence: [],
        roleTitle: "AI Specialist",
        company: "Vantage Staffing Middle East",
      }),
      [],
    );
  });

  it("leaves the closing question alone", () => {
    // Quoting the advert back as a question is the draft proving it read the
    // thing, which is what RULE 6 asks for. The damage is in the claims.
    const draft =
      "Nadia, one fact about me. You list experience in regulated or " +
      "service-oriented environments as preferred — is that a hard filter here?";
    assert.deepEqual(
      echoesJobDescription(draft, LANCESOFT_JD, {
        evidence: [],
        roleTitle: null,
        company: null,
      }),
      [],
    );
  });

  it("has no opinion when the job description is absent", () => {
    assert.deepEqual(echoesJobDescription(RAMYA_DRAFT, null, CONTEXT), []);
    assert.deepEqual(echoesJobDescription(RAMYA_DRAFT, "   ", CONTEXT), []);
  });

  it("does not fire on two texts that merely share a subject", () => {
    const draft =
      "Ravi, I applied for the role. I ship LLM features and keep the evals green.";
    assert.deepEqual(
      echoesJobDescription(draft, LANCESOFT_JD, {
        evidence: [],
        roleTitle: null,
        company: null,
      }),
      [],
    );
  });
});

describe("isSummaryChunk", () => {
  it("recognises the headers a summary is written under", () => {
    for (const header of [
      "PROFESSIONAL SUMMARY",
      "SUMMARY",
      "Profile",
      "About Me",
      "CAREER OBJECTIVE",
    ]) {
      assert.equal(isSummaryChunk(`${header}\nsome text`), true, header);
    }
  });

  it("does not treat a section that records work as a summary", () => {
    assert.equal(isSummaryChunk(PAYROLL_CHUNK), false);
    assert.equal(isSummaryChunk(PROJECT_CHUNK), false);
  });

  it("says nothing about a chunk indexed before headers existed", () => {
    // Thirteen of sixteen resumes are still old line-break chunks. They must get
    // no opinion rather than a wrong one.
    assert.equal(
      isSummaryChunk("improving tax-calculation accuracy by about 20% and cutting"),
      false,
    );
  });
});

describe("summaryOnlyFigures", () => {
  it("flags a figure the evidence can locate but cannot vouch for", () => {
    // The live case. 9.5/10 is in the summary and nowhere else that was
    // retrieved, so nothing in the evidence says it was earned by explaining
    // PeopleCode rather than by the systems the draft credits it to.
    assert.deepEqual(summaryOnlyFigures(RAMYA_DRAFT, [SUMMARY_CHUNK, PROJECT_CHUNK]), [
      "5",
      "9.5",
      "10",
    ]);
  });

  it("stays quiet once the work that earned the figure was retrieved too", () => {
    const flagged = summaryOnlyFigures(RAMYA_DRAFT, [
      SUMMARY_CHUNK,
      PAYROLL_CHUNK,
      PROJECT_CHUNK,
    ]);
    assert.ok(!flagged.includes("9.5"), "9.5 is vouched for by the payroll chunk");
    assert.ok(!flagged.includes("10"), "10 is vouched for by the payroll chunk");
  });

  it("ignores a figure that is not in the draft", () => {
    assert.deepEqual(summaryOnlyFigures("Nadia, no numbers here.", [SUMMARY_CHUNK]), []);
  });

  it("has no opinion when no summary chunk was retrieved", () => {
    assert.deepEqual(summaryOnlyFigures(RAMYA_DRAFT, [PAYROLL_CHUNK, PROJECT_CHUNK]), []);
    assert.deepEqual(summaryOnlyFigures(RAMYA_DRAFT, []), []);
  });
});
