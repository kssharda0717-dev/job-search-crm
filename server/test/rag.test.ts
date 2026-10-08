import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkResumeText, sectionHeader } from "../src/rag/chunk";
import { extractRoleKeywords, toOrQuery } from "../src/rag/keywords";
import {
  companiesMatch,
  companyFromHeadline,
  normalizeCompany,
} from "../src/services/company-match";
import { canonicalResumeName } from "../src/rag/resume-name";
import { critiqueDraft } from "../src/agent/critique";
import { personaFromHeadline } from "../src/agent/persona";
import { isQuietHours, nextPollDelayMinutes, POLL_MAX_MINUTES, POLL_MIN_MINUTES } from "@crm/shared";

describe("critiqueDraft", () => {
  /** The draft the agent actually produced for a Support Team Lead. */
  const REAL_BAD_DRAFT =
    "I noticed that Clearwater Labs is making strides in AI-LLM technologies. As " +
    "someone who's passionate about AI systems, I'm curious about how your team " +
    "approaches model optimization, especially in balancing performance and " +
    "resource efficiency. What strategies have you found effective in managing " +
    "this trade-off? Looking forward to hearing your insights!";

  it("catches every failure in the draft that shipped", () => {
    const { problems } = critiqueDraft(REAL_BAD_DRAFT, {
      recipientFirstName: "Omar",
      roleTitle: "AI/LLM Systems Engineer",
    });

    const all = problems.join(" | ");
    assert.match(all, /making strides/);
    assert.match(all, /passionate about/);
    assert.match(all, /as someone who/i);
    assert.match(all, /Looking forward to hearing/);
    assert.match(all, /exclamation/);
    assert.match(all, /first name, Omar/);
    // "AI-LLM technologies" gestures at the subject area; it does not tell Omar
    // which job the sender applied to.
    assert.match(all, /Name the role/);
  });

  it("flags a draft that interrogates the recipient with several questions", () => {
    const { problems } = critiqueDraft(
      "Hi Omar — I applied to the Systems role. How big is the team? " +
        "What does support see most? Who owns Clearwater day to day?",
      { recipientFirstName: "Omar", roleTitle: "AI/LLM Systems Engineer" },
    );
    assert.match(problems.join(" | "), /3 questions/);
  });

  it("passes a draft that names the person, the role and one concrete fact", () => {
    const good =
      "Hi Omar — I applied to the AI/LLM Systems Engineer role last week, so I " +
      "have been poking at Clearwater. You see the student questions before anyone " +
      "else does: which ones come back most often? I spent the last year on a " +
      "retrieval system where the hard part was never the retrieval, it was " +
      "what to do when it returned nothing useful.";

    assert.deepEqual(
      critiqueDraft(good, {
        recipientFirstName: "Omar",
        roleTitle: "AI/LLM Systems Engineer",
      }).problems,
      [],
    );
  });

  it("accepts a paraphrased role rather than demanding the literal title", () => {
    const { problems } = critiqueDraft(
      "Hi Dana — I put in for the Kafka platform role on Tuesday. What broke first?",
      { recipientFirstName: "Dana", roleTitle: "Senior Engineer, Kafka Platform" },
    );
    assert.deepEqual(problems, []);
  });

  it("does not demand the team qualifier that follows the role", () => {
    // Found by eval:drafting. Requiring every distinctive word of
    // "Senior Backend Engineer, Payments Platform" made the rule unsatisfiable
    // inside a 300-character note: the repair pass rewrote the draft, the rule
    // fired again, and the rewrite was discarded for not reducing the count.
    const { problems } = critiqueDraft(
      "Eval, I applied for the Senior Backend Engineer role at Meridian Pay. " +
        "At Brightfold I chose managed Postgres over a self-hosted cluster so " +
        "one engineer could run the stack. How does your team weigh that?",
      {
        recipientFirstName: "Eval",
        roleTitle: "Senior Backend Engineer, Payments Platform",
      },
    );
    assert.deepEqual(problems, []);
  });

  it("still demands the qualifier when the head of the title is generic", () => {
    // "Software Engineer" carries no signal, so accepting on the head alone
    // would switch the check off for the most common title shape there is.
    const { problems } = critiqueDraft(
      "Priya, I applied for the Software Engineer role last week. How does your " +
        "team decide what to build next?",
      {
        recipientFirstName: "Priya",
        roleTitle: "Software Engineer, Payments Platform",
      },
    );
    assert.match(problems.join(" | "), /Name the role/);
  });

  it("does not treat a hyphenated role name as a qualifier boundary", () => {
    // Splitting on a bare hyphen would reduce "Full-Stack Engineer, Payments"
    // to the single word "full".
    const { problems } = critiqueDraft(
      "Sam, I applied for the engineering role at Northwind. How does your team " +
        "split work across the stack?",
      { recipientFirstName: "Sam", roleTitle: "Full-Stack Engineer, Payments" },
    );
    assert.match(problems.join(" | "), /Name the role/);
  });

  it("catches every failure in the AKASA draft", () => {
    const { problems } = critiqueDraft(
      "Daniel, I recently applied for the Software Engineer, Applied AI role at " +
        "AKASA. In my previous experience as an Applied AI Engineer, I designed " +
        "LLM-driven solutions that improved revenue reconciliation processes, " +
        "which I believe aligns well with AKASA's mission to enhance clinical " +
        "documentation. I'm curious about how your team measures the success of " +
        "AI implementations in improving operational efficiencies for healthcare " +
        "providers.",
      {
        recipientFirstName: "Daniel",
        roleTitle: "Software Engineer, Applied AI",
        persona: "Technical_Recruiter",
      },
    );

    const all = problems.join(" | ");
    assert.match(all, /In my previous experience/);
    assert.match(all, /I believe/);
    assert.match(all, /aligns well with/);
    // The question is the real failure: an HR coordinator cannot answer it.
    assert.match(all, /implementations/);
    assert.match(all, /outside a Technical Recruiter's job/);
  });

  it("leaves the same question alone when it is aimed at an engineer", () => {
    const { problems } = critiqueDraft(
      "Hi Priya — I applied to the Applied AI role last week. How does the team " +
        "measure whether a retrieval change actually helped?",
      {
        recipientFirstName: "Priya",
        roleTitle: "Software Engineer, Applied AI",
        persona: "Peer_Engineer",
      },
    );
    assert.deepEqual(problems, []);
  });

  it("does not demand a role mention when the title is entirely generic", () => {
    const { problems } = critiqueDraft(
      "Hi Sam — I applied on Tuesday. What does the first month look like?",
      { recipientFirstName: "Sam", roleTitle: "Senior Software Engineer" },
    );
    assert.deepEqual(problems, []);
  });

  it("catches a figure that was rounded away from the evidence", () => {
    const { problems } = critiqueDraft(
      "Hi Sam — I applied on Tuesday. I reconcile over 30,000 brokerage lines a " +
        "month against 1,283 holdings. What does the first month look like?",
      {
        recipientFirstName: "Sam",
        roleTitle: "Senior Software Engineer",
        evidence: [
          "Reconciled 32,330 brokerage lines a month to the paisa against 1,283 " +
            "holdings at a 98.9% match rate.",
        ],
      },
    );
    // 1,283 is in the evidence and must not be flagged; 30,000 is not.
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /30000/);
  });

  it("accepts figures reproduced exactly, separators and all", () => {
    const { problems } = critiqueDraft(
      "Hi Sam — I applied on Tuesday. I reconcile 32,330 brokerage lines a month " +
        "at a 98.9% match rate. What does the first month look like?",
      {
        recipientFirstName: "Sam",
        roleTitle: "Senior Software Engineer",
        evidence: [
          "Reconciled 32,330 brokerage lines a month to the paisa against 1,283 " +
            "holdings at a 98.9% match rate.",
        ],
      },
    );
    assert.deepEqual(problems, []);
  });

  it("does not invent a style problem when there is no evidence to check against", () => {
    const { problems } = critiqueDraft(
      "Hi Sam — I applied for the Senior Software Engineer role on Tuesday. " +
        "What does the first month look like?",
      { recipientFirstName: "Sam", roleTitle: "Senior Software Engineer" },
    );
    assert.deepEqual(problems, []);
  });

  it("flags a figure when nothing was retrieved to support it", () => {
    // An empty corpus is the strictest case, not an exemption: with no chunks
    // retrieved the model had no source for this number, so it invented it.
    const { problems } = critiqueDraft(
      "Hi Sam — I applied for the Senior Software Engineer role and cut " +
        "payroll errors by 30%. What does the first month look like?",
      { recipientFirstName: "Sam", roleTitle: "Senior Software Engineer", evidence: [] },
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /figure 30/);
  });

  it("rejects naming the company's mission back to it", () => {
    // Observed verbatim: "aligns well with AKASA's mission to enhance clinical
    // documentation" — inferred entirely from the job ad.
    const { problems } = critiqueDraft(
      "Hi Sam — I applied on Tuesday, and the work speaks to AKASA's mission to " +
        "enhance clinical documentation. What does the first month look like?",
      { recipientFirstName: "Sam", roleTitle: "Senior Software Engineer" },
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /mission to/);
  });
});

describe("personaFromHeadline", () => {
  it("reads the headline that produced the AKASA draft", () => {
    // Classified Engineering_Leader by the model, which is what aimed a
    // question about measuring AI implementations at an HR coordinator. The
    // second form is the literal headline on the profile.
    assert.equal(
      personaFromHeadline("HR Coordinator at AKASA"),
      "Technical_Recruiter",
    );
    assert.equal(
      personaFromHeadline("Human Resources Coordinator at AKASA"),
      "Technical_Recruiter",
    );
  });

  it("keeps engineering leaders out of the executive bucket", () => {
    assert.equal(personaFromHeadline("VP of Engineering at Ramp"), "Engineering_Leader");
    assert.equal(personaFromHeadline("Engineering Manager, Payments"), "Engineering_Leader");
    assert.equal(personaFromHeadline("Head of AI @ Scale"), "Engineering_Leader");
  });

  it("treats company owners as executives", () => {
    assert.equal(personaFromHeadline("Co-Founder & CTO"), "Founder_Executive");
    assert.equal(personaFromHeadline("CEO at Acme"), "Founder_Executive");
  });

  it("separates people who build from people who work beside them", () => {
    assert.equal(personaFromHeadline("Senior Backend Developer"), "Peer_Engineer");
    assert.equal(personaFromHeadline("Research Scientist, NLP"), "Peer_Engineer");
    // Forcing this person into Peer_Engineer is what made the agent ask a
    // support lead about inference latency.
    assert.equal(personaFromHeadline("Support Team Lead"), "Adjacent_Employee");
    assert.equal(personaFromHeadline("Account Executive at Stripe"), "Adjacent_Employee");
  });

  it("returns nothing rather than guessing at a contentless headline", () => {
    assert.equal(personaFromHeadline("Building things"), null);
    assert.equal(personaFromHeadline(""), null);
    assert.equal(personaFromHeadline(null), null);
  });
});

describe("canonicalResumeName", () => {
  it("files a resume under name, company and role regardless of its own name", () => {
    assert.equal(
      canonicalResumeName({
        userName: "Arjun Nair",
        company: "Clearwater Labs",
        title: "AI/LLM Systems Engineer",
        fallback: "resume (3).pdf",
      }),
      "Arjun-Nair_Clearwater-Labs_AI-LLM-Systems-Engineer.pdf",
    );
  });

  it("still renames when the user's name is not configured", () => {
    // The setting is one most people never open, and returning the fallback
    // here meant every vault file kept whatever the ATS called it.
    assert.equal(
      canonicalResumeName({
        userName: "",
        company: "Acme",
        title: "Engineer",
        fallback: "cv.pdf",
      }),
      "Acme_Engineer.pdf",
    );
  });

  it("keeps the original name when the role or company is unknown", () => {
    assert.equal(
      canonicalResumeName({
        userName: "Arjun Nair",
        company: "",
        title: "Engineer",
        fallback: "cv.pdf",
      }),
      "cv.pdf",
    );
  });

  it("strips punctuation that would be unsafe in a storage path", () => {
    const name = canonicalResumeName({
      userName: "Ana Ruiz-López",
      company: "Foo & Bar, Inc.",
      title: "Sr. Engineer (Platform)",
      fallback: "x.pdf",
    });
    assert.match(name, /^[A-Za-z0-9\-_.]+$/);
    assert.equal(name, "Ana-Ruiz-Lopez_Foo-Bar-Inc_Sr-Engineer-Platform.pdf");
  });
});

describe("chunkResumeText", () => {
  it("returns nothing for empty input", () => {
    assert.deepEqual(chunkResumeText(""), []);
    assert.deepEqual(chunkResumeText("   \n\n  "), []);
  });

  it("keeps a short resume as a single chunk", () => {
    const text = "Jane Doe\nSenior Engineer\nBuilt a thing.";
    assert.equal(chunkResumeText(text).length, 1);
  });

  it("splits long text into multiple chunks under the target size", () => {
    const line = "Reduced p99 latency by 40% by sharding the write path.";
    const text = Array.from({ length: 60 }, () => line).join("\n");
    const chunks = chunkResumeText(text, 300, 50);

    assert.ok(chunks.length > 1);
    // Allow one line of slack: packing appends before checking the next line.
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 300 + line.length, `chunk too long: ${chunk.length}`);
    }
  });

  it("never splits mid-line", () => {
    const text = ["alpha line", "beta line", "gamma line", "delta line"].join("\n");
    for (const chunk of chunkResumeText(text, 20, 5)) {
      for (const line of chunk.split("\n")) {
        assert.ok(
          ["alpha line", "beta line", "gamma line", "delta line"].includes(line),
          `unexpected fragment: ${line}`,
        );
      }
    }
  });

  it("hard-splits a single line longer than the target", () => {
    const chunks = chunkResumeText("x".repeat(1000), 300, 50);
    assert.ok(chunks.length >= 4);
    for (const chunk of chunks) assert.ok(chunk.length <= 300);
  });

  it("preserves every line somewhere in the output", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `Achievement number ${i} with detail`);
    const joined = chunkResumeText(lines.join("\n"), 200, 40).join("\n");
    for (const line of lines) assert.ok(joined.includes(line), `lost: ${line}`);
  });

  // The real resume: chunk 1 held three unrelated facts plus the CORE SKILLS
  // wall, and was cited by every draft the system had ever written.
  it("never packs a skills wall into the same chunk as an achievement", () => {
    const text = [
      "ORACLE CORPORATION — Principal Consultant",
      "Cut payroll run time from 6 hours to 40 minutes across 12 legal entities.",
      "CORE SKILLS",
      "Oracle HCM, Fusion, Taleo, OTBI, BI Publisher, Fast Formula, HDL, HCM Extracts",
    ].join("\n");

    const wall = chunkResumeText(text).find((c) => c.includes("BI Publisher"));
    assert.ok(wall, "the skills wall vanished");
    assert.ok(!wall.includes("40 minutes"), `wall welded to an achievement: ${wall}`);
  });

  it("labels every chunk with the section it came from", () => {
    assert.deepEqual(chunkResumeText("CORE SKILLS\nOracle HCM, Fusion, Taleo, OTBI"), [
      "CORE SKILLS\nOracle HCM, Fusion, Taleo, OTBI",
    ]);
  });

  it("does not carry overlap across a section boundary", () => {
    const text = [
      "ACME CORPORATION — Engineer",
      "Raised checkout conversion from 2.1% to 3.4%.",
      "EDUCATION",
      "B.E. Computer Science, 2013",
    ].join("\n");

    const education = chunkResumeText(text, 120, 80).find((c) => c.includes("B.E."));
    assert.ok(education);
    assert.ok(
      !education.includes("checkout conversion"),
      `overlap leaked across the boundary: ${education}`,
    );
  });
});

describe("sectionHeader", () => {
  it("reads a shouted section name and an employer line as headers", () => {
    assert.equal(sectionHeader("CORE SKILLS"), "CORE SKILLS");
    assert.equal(sectionHeader("Professional Experience"), "Professional Experience");
    assert.equal(
      sectionHeader("NORTHWIND LOGISTICS — Staff Engineer, Platform (2021—present)"),
      "NORTHWIND LOGISTICS — Staff Engineer, Platform (2021—present)",
    );
  });

  it("strips a trailing colon so one resume's 'Skills:' is another's 'Skills'", () => {
    assert.equal(sectionHeader("Skills:"), "Skills");
  });

  // A bullet opening with an acronym passes a naive uppercase test, which would
  // turn every such line into its own section and shatter the block.
  it("does not read a bullet as a header", () => {
    assert.equal(sectionHeader("AWS — migrated the fleet to Graviton"), null);
    assert.equal(sectionHeader("Senior Software Engineer — Bengaluru, India"), null);
    assert.equal(sectionHeader("Replaced a nightly batch job with a Kafka consumer group."), null);
  });

  it("does not read the skills wall itself as a header", () => {
    assert.equal(
      sectionHeader("Python, Go, TypeScript, Java, Kotlin, Rust, Scala, Ruby, C++, Bash, SQL"),
      null,
    );
  });
});

describe("extractRoleKeywords", () => {
  it("returns empty string for null input", () => {
    assert.equal(extractRoleKeywords(null), "");
  });

  it("pulls known technologies out of a job description", () => {
    const jd = `We are hiring a backend engineer. You will work with Python,
      Kubernetes and PostgreSQL, deploying to AWS. Experience with Kafka is a plus.`;
    const keywords = extractRoleKeywords(jd).split(" ");

    for (const expected of ["python", "kubernetes", "postgresql", "aws", "kafka"]) {
      assert.ok(keywords.includes(expected), `missing ${expected}`);
    }
  });

  it("ignores generic filler words", () => {
    const keywords = extractRoleKeywords("A passionate team player who loves collaboration");
    assert.equal(keywords, "");
  });

  it("ranks more frequent terms first", () => {
    const jd = "Rust. Rust. Rust. We also touch Java once.";
    assert.equal(extractRoleKeywords(jd).split(" ")[0], "rust");
  });

  it("strips tsquery operator characters", () => {
    const keywords = extractRoleKeywords("We use Node.js and C++ here");
    assert.ok(!keywords.includes("("));
    assert.ok(!keywords.includes('"'));
  });

  it("respects the limit", () => {
    const jd = "python java rust go ruby scala kotlin swift php elixir react vue";
    assert.equal(extractRoleKeywords(jd, null, 3).split(" ").length, 3);
  });

  /**
   * The regression that motivated the rewrite, with the real posting's shape.
   *
   * Under the closed technology allow-list this exact job description — 2,714
   * characters, Oracle Fusion HCM Functional Consultant — returned the empty
   * string. Not a worse ranking: the job the user applied to contributed
   * *nothing* to retrieval, so the sparse leg ranked on persona vocabulary
   * alone ("clients", "supported") and the draft that shipped to a recruiter
   * led with a client-satisfaction score from an unrelated project.
   */
  it("works for a role outside software engineering", () => {
    const jd = `We are seeking an experienced Oracle Fusion HCM Functional
      Consultant. You will configure Core HR, Absence Management and Payroll
      modules, write Fast Formula, manage Flexfields, and support UAT through
      go-live. Oracle Fusion certification preferred. Payroll experience
      essential.`;
    const keywords = extractRoleKeywords(jd, "Oracle Fusion HCM Functional Consultant");

    assert.notEqual(keywords, "", "a non-software posting must still yield terms");
    for (const expected of ["oracle", "fusion", "hcm", "payroll"]) {
      assert.ok(keywords.split(" ").includes(expected), `missing ${expected}`);
    }
  });

  it("ranks title terms above body terms", () => {
    // The title is the densest sentence in a posting and the only one certain
    // to be about the work rather than about the employer, so a word that
    // appears in it outranks one merely repeated in the prose.
    const jd = "Payroll payroll payroll. We also mention Oracle once.";
    const keywords = extractRoleKeywords(jd, "Oracle Consultant").split(" ");

    assert.equal(keywords[0], "oracle");
  });

  it("drops prose the posting used only once", () => {
    // An OR query is a ranking signal, not a filter: a word used once in two
    // thousand characters makes chunks match for no reason. The first run of
    // the open-vocabulary version returned "want", "after" and "stay".
    const jd = "We want you to stay. Payroll. Payroll.";
    const keywords = extractRoleKeywords(jd).split(" ").filter(Boolean);

    assert.deepEqual(keywords, ["payroll"]);
  });
});

describe("toOrQuery", () => {
  /**
   * The bug this exists to prevent: bare words are ANDed by
   * websearch_to_tsquery, so the whole sparse leg silently matched nothing.
   */
  it("joins terms with or, not whitespace", () => {
    assert.equal(toOrQuery(["csat support churn"]), "csat or support or churn");
  });

  it("flattens several sources and drops duplicates", () => {
    assert.equal(
      toOrQuery([["csat", "support"].join(" "), "support python"]),
      "csat or support or python",
    );
  });

  it("strips characters websearch_to_tsquery would read as operators", () => {
    // A leading "-" means NOT, which would exclude the very chunks we want.
    assert.equal(toOrQuery(['-churn "rag" (aws)']), "churn or rag or aws");
  });

  it("never emits a bare operator word", () => {
    assert.equal(toOrQuery(["python or java and go"]), "python or java or go");
  });

  it("returns empty string when there is nothing to search for", () => {
    assert.equal(toOrQuery([""]), "");
    assert.equal(toOrQuery([]), "");
  });
});

describe("normalizeCompany", () => {
  it("drops legal suffixes so variants agree", () => {
    assert.equal(normalizeCompany("Stripe, Inc."), normalizeCompany("Stripe"));
    assert.equal(normalizeCompany("Acme LLC"), normalizeCompany("Acme"));
  });

  it("handles null and empty input", () => {
    assert.equal(normalizeCompany(null), "");
    assert.equal(normalizeCompany(undefined), "");
  });
});

describe("companiesMatch", () => {
  it("matches the spellings a headline and a job posting actually use", () => {
    assert.equal(companiesMatch("Vector AI", "Scaleai"), false);
    assert.equal(companiesMatch("Vector AI", "Vector AI"), true);
    assert.equal(companiesMatch("Stripe, Inc.", "Stripe"), true);
    assert.equal(companiesMatch("Clearwater Labs", "Clearwater Labs LLC"), true);
  });

  it("refuses to link on a scrap of a name", () => {
    // Linking every contact at any company containing "AI" to one application
    // would be worse than leaving them unlinked.
    assert.equal(companiesMatch("AI", "Vector AI"), false);
    assert.equal(companiesMatch("Co", "Cognitive"), false);
  });

  it("treats missing data as no match rather than a wildcard", () => {
    assert.equal(companiesMatch(null, "Stripe"), false);
    assert.equal(companiesMatch("Stripe", ""), false);
    assert.equal(companiesMatch(null, null), false);
  });
});

describe("companyFromHeadline", () => {
  it("extracts the employer after 'at'", () => {
    assert.equal(companyFromHeadline("Senior SWE at Stripe | ex-Google"), "Stripe");
  });

  it("extracts the employer after '@'", () => {
    assert.equal(companyFromHeadline("Engineering Manager @ Ramp"), "Ramp");
  });

  it("returns null when there is no employer marker", () => {
    assert.equal(companyFromHeadline("Just a software engineer"), null);
    assert.equal(companyFromHeadline(null), null);
  });
});

describe("polling cadence", () => {
  it("stays inside the human-like window", () => {
    for (const r of [0, 0.5, 0.999]) {
      const delay = nextPollDelayMinutes(() => r);
      assert.ok(delay >= POLL_MIN_MINUTES && delay <= POLL_MAX_MINUTES, `got ${delay}`);
    }
  });

  it("treats late night and early morning as quiet", () => {
    assert.equal(isQuietHours(new Date(2026, 0, 1, 23, 0)), true);
    assert.equal(isQuietHours(new Date(2026, 0, 1, 3, 0)), true);
    assert.equal(isQuietHours(new Date(2026, 0, 1, 14, 0)), false);
  });
});
