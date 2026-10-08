import type { RetrievalCase } from "../src/eval/dataset";

/**
 * The labelled retrieval set, against `eval/fixtures/resume.txt`.
 *
 * Every case is a failure this codebase actually shipped, not a synthetic one.
 * The fixture resume is built to contain the same trap the real one did: a
 * 400-character SKILLS wall that matches almost every keyword query and
 * contains no system, no number and no decision.
 *
 * The job description is held constant across all cases on purpose. If the JD
 * were varied, a rise in the score could be explained by the JD lens alone —
 * and "the JD lens is doing all the work" is precisely the defect the persona
 * lenses were introduced to fix.
 */
/** The title of the role applied to, held apart from the description because
 *  retrieval and reranking now weight it separately — see
 *  `extractRoleKeywords`. */
export const JOB_TITLE = "Senior Backend Engineer, Payments Platform";

export const JOB_DESCRIPTION = `
Senior Backend Engineer, Payments Platform.
You will own event-driven services that move money: Kafka consumers, idempotent
writes, reconciliation against the ledger, and the on-call that comes with it.
We care about correctness under partial failure more than raw throughput.
Stack: Go, Postgres, Kafka, Kubernetes, AWS.
`.trim();

export const RETRIEVAL_CASES: RetrievalCase[] = [
  {
    id: "hr-coordinator",
    // No employer in the title: Northwind is the candidate's own employer in the
    // fixture, and naming it here would let the headline lens match the resume's
    // role headers instead of the recipient's field of work.
    recipientTitle: "HR Coordinator, People Operations",
    persona: "Technical_Recruiter",
    relevantMarkers: [
      "PeopleSoft HCM payroll integrations",
      "benefits-enrolment reconciliation",
    ],
    forbiddenMarkers: ["Python, Go, TypeScript, Java"],
    rationale:
      "The case the whole three-lens design exists for. An HR coordinator and a " +
      "staff recruiter previously produced byte-identical queries, because the " +
      "recipient reached retrieval only as a five-value persona enum. Four years " +
      "of HCM payroll work — the one thing this person could actually talk about " +
      "— was unreachable from both legs.",
  },
  {
    id: "technical-recruiter",
    recipientTitle: "Technical Recruiter, Platform Engineering",
    persona: "Technical_Recruiter",
    relevantMarkers: [
      "technical interview loop",
      "median time-to-offer",
      "onboarding runbook",
    ],
    forbiddenMarkers: ["Python, Go, TypeScript, Java"],
    rationale:
      "PERSONA_CONCERNS.Technical_Recruiter was once `years, experience, engineer, " +
      "senior, degree, certified, stack` — a skills-section retriever word for " +
      "word. Both legs landed on the technology wall and the draft could only say " +
      "'I have experience with'. A recruiter should reach the hiring and " +
      "mentoring evidence instead.",
  },
  {
    id: "engineering-leader",
    recipientTitle: "VP of Engineering",
    persona: "Engineering_Leader",
    relevantMarkers: [
      "partition rebalancing strategy",
      "backpressure policy",
      "dead-letter topic",
    ],
    rationale:
      "A leader is judged on decisions and their consequences. This is the one " +
      "case where the JD lens and the persona lens should broadly agree, so a " +
      "score here that is no better than the others means the persona lens is " +
      "contributing nothing.",
  },
  {
    id: "peer-engineer",
    recipientTitle: "Senior Backend Engineer working on payments infrastructure",
    persona: "Peer_Engineer",
    relevantMarkers: [
      "Kafka consumer group",
      "idempotency keys",
      "partition rebalancing strategy",
    ],
    forbiddenMarkers: ["Python, Go, TypeScript, Java"],
    rationale:
      "A peer wants the mechanism, not the outcome. This case is the sparse " +
      "leg's canary: 'Kafka' and 'idempotency' are lexical matches that dense " +
      "retrieval alone can also find, so if the sparse leg is dead (see the " +
      "websearch_to_tsquery AND trap) this case still passes while the others " +
      "degrade. Read it next to the per-leg numbers, never alone.",
  },
  {
    id: "support-lead",
    recipientTitle: "Customer Support Operations Lead",
    persona: "Adjacent_Employee",
    relevantMarkers: [
      "refund-approval workflow",
      "average handle time on billing disputes",
      "top ten recurring contact reasons",
    ],
    forbiddenMarkers: [
      "Python, Go, TypeScript, Java",
      "partition rebalancing strategy",
    ],
    rationale:
      "The anti-criterion from the PRD, stated as a measurement: a support lead " +
      "and a CTO must not receive the same three bullets. Steering on the job " +
      "description alone gives this person the Kafka work, which she cannot " +
      "answer a single question about.",
  },
  {
    id: "founder",
    recipientTitle: "Co-founder and CEO",
    persona: "Founder_Executive",
    relevantMarkers: [
      "annual recurring revenue",
      "pricing migration",
      "Employee number three",
    ],
    forbiddenMarkers: ["Python, Go, TypeScript, Java"],
    rationale:
      "A founder reads for judgement under constraint and for commercial " +
      "outcome. The seed-stage evidence is the only part of this resume that " +
      "speaks to either, and it is the part furthest from the job description — " +
      "so this case fails loudly if the JD lens is dominating fusion.",
  },
];
