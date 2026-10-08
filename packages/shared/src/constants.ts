/**
 * Plain values shared by the server and the extension.
 *
 * This module must stay free of runtime imports — `./types` is imported for
 * types only. The extension reaches these through `@crm/shared/constants`
 * precisely so that bundling it never drags zod into a content script; see the
 * note on the `./constants` subpath in package.json.
 */
import type { MessageType, Persona } from "./types";

// ---------------------------------------------------------------------------
// Drafting limits
// ---------------------------------------------------------------------------

/**
 * LinkedIn's own cap on a connection note is 300 characters. We enforce it
 * client- and server-side so a truncated draft never reaches the user.
 */
export const CHAR_LIMITS: Record<MessageType, number> = {
  connection_note: 280,
  initial_outreach: 600,
  follow_up: 400,
};

export const PERSONA_GUIDANCE: Record<Persona, string> = {
  Engineering_Leader:
    "Speak to business and team-level outcomes. Lead with scale, reliability, " +
    "or delivery metrics. Avoid framework name-dropping; they care about impact " +
    "and judgement, not tooling trivia.",
  Technical_Recruiter:
    "Be concrete and skimmable. Map experience directly onto the requisition's " +
    "stated requirements, including years of experience and named technologies. " +
    "Make it effortless to slot you against the role.",
  Peer_Engineer:
    "Be collegial and specific about the technical problem. Reference an actual " +
    "implementation detail or trade-off. Ask a genuine question about how their " +
    "team handles something. No pitch, no flattery.",
  Adjacent_Employee:
    "They do not build the product and cannot answer an engineering question. " +
    "Do not ask one. Their value is what they see that engineers do not: which " +
    "customer problems recur, what the team is actually like, who owns the role. " +
    "Say plainly that you applied, ask one question only they could answer from " +
    "their own day, and keep it under four sentences.",
  Founder_Executive:
    "They decide, they do not evaluate. Two or three sentences, no preamble, no " +
    "technology names. Frame yourself as someone who moves a number they own — " +
    "revenue, retention, cost, speed — and ask one question about where the " +
    "business is going, not about the hiring process.",
};

/**
 * What each persona measures the world by.
 *
 * This exists because retrieval was steered entirely by the job description.
 * The dense query was a fixed template and the sparse query was always the
 * JD's technology keywords, so a support lead and a CTO at the same company
 * got the same three resume bullets — the most technical ones. The bullet that
 * would actually have landed with a support lead ("held CSAT above 9.5/10 for
 * nine consecutive months") was invisible to both legs.
 *
 * `caresAbout` is prose because it is embedded for the dense leg.
 * `terms` are single words because they go through `websearch_to_tsquery`, and
 * they are deliberately words a *resume* would use, not words a job posting
 * would use.
 */
export interface PersonaConcerns {
  caresAbout: string;
  terms: string[];
}

export const PERSONA_CONCERNS: Record<Persona, PersonaConcerns> = {
  Engineering_Leader: {
    caresAbout:
      "delivery under deadline, reliability, incident load, scale, cost of " +
      "ownership, what a new hire would take off their plate",
    terms: [
      "reliability", "uptime", "incident", "outage", "latency", "throughput",
      "scale", "migration", "ownership", "mentored", "led", "on-call",
      "reduced", "cost", "deadline", "shipped",
    ],
  },
  Founder_Executive: {
    caresAbout:
      "revenue, retention, churn, cost, speed to market, customer outcomes " +
      "and risk to the business",
    terms: [
      "revenue", "retention", "churn", "conversion", "cost", "savings",
      "customers", "growth", "adoption", "launched", "shipped", "reduced",
      "increased", "users",
    ],
  },
  Technical_Recruiter: {
    // The obvious phrasing — "years of experience, named technologies,
    // seniority" — is a description of a SKILLS section, and that is exactly
    // what it retrieved: the dense leg landed on the resume's comma-separated
    // technology wall and the sparse terms below ("years", "experience",
    // "degree", "certified", "stack") only lived in the summary and
    // certifications blocks. A recruiter cannot open a message with a keyword
    // list. What they are actually checking is whether someone has already
    // done this job somewhere real, and the resume says that in verbs.
    caresAbout:
      "whether the candidate has already done this job somewhere real — what " +
      "they shipped, who used it, at what scale, and how long they owned it",
    terms: [
      "built", "shipped", "delivered", "owned", "launched", "migrated",
      "production", "clients", "users", "led", "scale", "supported",
    ],
  },
  Peer_Engineer: {
    caresAbout:
      "implementation detail, architecture trade-offs, debugging, test " +
      "strategy, tooling and failure modes",
    terms: [
      "architecture", "trade-off", "debug", "failure", "edge", "tests",
      "pipeline", "refactor", "implemented", "built", "designed", "benchmark",
    ],
  },
  Adjacent_Employee: {
    caresAbout:
      "customer tickets, churn, onboarding, CSAT, escalations, support load, " +
      "and making a technical product legible to people who are not technical",
    terms: [
      "csat", "support", "customer", "user", "ticket", "onboarding",
      "escalation", "documentation", "churn", "retention", "training",
      "non-technical", "clarity", "explained",
    ],
  },
};

// ---------------------------------------------------------------------------
// Anti-ban / rate limiting (PRD section 6)
// ---------------------------------------------------------------------------

/**
 * Background polling must look human. We schedule the next sweep at a random
 * point in this window rather than on a fixed cadence.
 */
export const POLL_MIN_MINUTES = 30;
export const POLL_MAX_MINUTES = 90;

/** Local hours during which polling is suspended entirely. */
export const QUIET_HOURS_START = 22; // 22:00
export const QUIET_HOURS_END = 7; // 07:00

/**
 * Contacts reconciled per sweep.
 *
 * This is no longer a traffic limit. Acceptance is read from the user's own
 * "Sent invitations" and "Connections" pages — two page loads that say
 * something about every pending invitation at once — rather than by opening
 * each contact's profile. Visiting a profile registers as a profile view and
 * notifies that person, which is unacceptable for a background check, and it
 * made the cost of a sweep grow with the size of the network.
 */
export const MAX_CONTACTS_PER_SWEEP = 100;

/** Handshakes older than this are considered abandoned and swept. */
export const HANDSHAKE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Largest resume the vault will accept, in decoded bytes.
 *
 * There was no ceiling at all. The PDF arrives base64-encoded inside a JSON
 * body, is decoded into a Buffer, and is then walked page by page by pdf.js —
 * all of it resident in the proxy's heap at once, on a process that is also
 * serving the side panel. One scanned 60MB CV is enough to take that process
 * down, and it takes every other feature with it.
 *
 * 10MB is far above any real resume (typical is well under 1MB) and far below
 * what hurts. Enforced in the contract so the extension is told why, rather
 * than the request dying somewhere inside pdf.js.
 */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/**
 * The same ceiling expressed in base64 characters, which is what the request
 * body actually carries: 4 characters per 3 bytes, rounded up for padding.
 */
export const MAX_RESUME_BASE64_CHARS = Math.ceil(MAX_RESUME_BYTES / 3) * 4;

/** Default days of silence before a contact is marked Follow_Up_Required. */
export const DEFAULT_FOLLOW_UP_DAYS = 5;

/**
 * Bounds on the user-editable follow-up window.
 *
 * The floor is not cosmetic: at 0 every accepted contact the user has ever
 * messaged goes stale on the very next sweep, and the engine drafts a follow-up
 * to all of them at once. The ceiling keeps a typo like `500` from switching
 * follow-ups off in a way that looks like the feature is broken.
 */
export const MIN_FOLLOW_UP_DAYS = 1;
export const MAX_FOLLOW_UP_DAYS = 90;

/**
 * Coerce whatever a number input produced into a usable follow-up window.
 *
 * `<input type="number">` yields a string, and an empty one yields `""`, which
 * `Number` turns into 0 — the one value that would make the next sweep declare
 * every accepted contact overdue. The server rejects out-of-range values, so
 * without this the user could save a setting the panel then promised and the
 * server refused.
 */
export function clampFollowUpDays(value: string | number): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed === 0) return DEFAULT_FOLLOW_UP_DAYS;
  return Math.min(MAX_FOLLOW_UP_DAYS, Math.max(MIN_FOLLOW_UP_DAYS, parsed));
}

/** Returns a jittered delay in minutes for the next polling sweep. */
export function nextPollDelayMinutes(random: () => number = Math.random): number {
  const span = POLL_MAX_MINUTES - POLL_MIN_MINUTES;
  return POLL_MIN_MINUTES + Math.floor(random() * (span + 1));
}

/** True when `date` falls inside the configured quiet hours. */
export function isQuietHours(date: Date = new Date()): boolean {
  const hour = date.getHours();
  // Window wraps midnight, so it is a union rather than a range.
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
export const DRAFTING_MODEL = "gpt-4o-mini";

/**
 * Model that reranks retrieved chunks before they reach the drafting agent.
 *
 * Same model as drafting, and deliberately the cheap one: reranking is a
 * short-answer judgement over a handful of passages, not a generation task, and
 * it runs once per draft against an agent loop that already costs several
 * calls.
 */
export const RERANK_MODEL = "gpt-4o-mini";

/**
 * How many fused chunks are shown to the reranker before it cuts down to the
 * requested limit.
 *
 * Must be comfortably larger than the limit or there is nothing to rerank. It
 * is bounded because every candidate is a ~700-character chunk in the prompt,
 * and because a reranker asked to sort the entire corpus is doing retrieval's
 * job with none of retrieval's speed.
 */
export const RERANK_CANDIDATES = 8;

/** Reciprocal Rank Fusion smoothing constant; 60 is the value from the paper. */
export const RRF_K = 60;

/** Resume chunking, tuned so a chunk is roughly one bullet or role block. */
export const CHUNK_TARGET_CHARS = 700;
export const CHUNK_OVERLAP_CHARS = 100;

/**
 * Ceiling on the recipient profile text carried on the wire and stored.
 *
 * A long LinkedIn profile runs to thousands of words of endorsements and
 * repeated titles, and all of it would land in the retrieval query and the
 * agent's prompt. The scraper already takes only About + Experience + Skills;
 * this is the backstop, so one unusual profile cannot blow the prompt budget or
 * dilute the dense query vector into an average of everything the person has
 * ever done.
 *
 * It lives here rather than beside the schemas that enforce it because
 * `profile-text.ts` needs it, `profile-text.ts` is imported by a content
 * script, and importing it from `./api` pulled zod into that content script —
 * which crashed it outright. See the note at the top of this file.
 */
export const MAX_PROFILE_TEXT_CHARS = 4000;

/*
 * The remaining input ceilings.
 *
 * Every limit above this block was added in response to one specific outage,
 * and none of them was generalised afterwards — so `fileBase64` was bounded to
 * 10MB with two paragraphs of justification while `extractedText`, on the same
 * request, could carry fifty megabytes straight past the parser and into the
 * embedding loop. The schema had become a list of past incidents rather than a
 * description of the boundary.
 *
 * These are deliberately generous. The point is not to second-guess a real
 * value; it is that no field reaches the database, a regex or a billed API call
 * without *some* ceiling.
 */

/**
 * Job description text.
 *
 * Only `JD_PROMPT_CHARS` (3000) of this ever reaches the model, but the whole
 * string is stored and `extractRoleKeywords` tokenises all of it through five
 * regex passes on every draft. 20k characters is a long advert read twice over.
 */
export const MAX_JD_TEXT_CHARS = 20_000;

/**
 * Pre-extracted resume text, when the caller does the parsing.
 *
 * This is the one field that bypasses both `MAX_RESUME_BYTES` and pdf.js, so it
 * needs its own ceiling: it is chunked, embedded and stored, and the embedding
 * bill is linear in its length. 400k characters is far more text than a 10MB
 * PDF of a resume can hold.
 */
export const MAX_RESUME_TEXT_CHARS = 400_000;

/**
 * Names, titles, companies, locations, file names.
 *
 * `title` is the one that mattered: it is split into words and compiled into a
 * regex by `mentionsRole`, so it is the only short field that reaches a regex
 * engine rather than just a column.
 */
export const MAX_SHORT_TEXT_CHARS = 300;

/** URLs. The de-facto browser ceiling, and far past any real posting link. */
export const MAX_URL_CHARS = 2048;

/**
 * A free-text steer from the user ("rewrite this, shorter").
 *
 * This goes into the drafting prompt verbatim, so it is the user's own
 * deliberate prompt-injection surface. Bounded so it cannot become the prompt.
 */
export const MAX_INSTRUCTION_CHARS = 2000;

/**
 * The text the user actually sent, recorded after the fact.
 *
 * Generous relative to `CHAR_LIMITS` because the user edits the draft by hand
 * before sending and this is a record of what happened, not a thing to enforce
 * — but a record is still not a place to put a megabyte.
 */
export const MAX_SENT_TEXT_CHARS = 10_000;

/** A retrieval query. Longer than this is not a query, it is a document. */
export const MAX_SEARCH_QUERY_CHARS = 2000;

/**
 * A ceiling on the whole request body, enforced at the socket.
 *
 * The per-field limits above all run *after* the body has been received and
 * `JSON.parse`d, so on their own they bound what is stored, not what is
 * allocated. This bounds the allocation.
 *
 * Sized off the largest legitimate request — a resume upload, which carries
 * `MAX_RESUME_BASE64_CHARS` (~13.4MB of base64) — plus room for the JSON
 * envelope, the escaping, and `extractedText` riding along on the same body.
 */
export const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
