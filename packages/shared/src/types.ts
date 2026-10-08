import { z } from "zod";

/**
 * Canonical domain model, shared by the extension and the proxy server.
 * Mirrors the Supabase schema in supabase/migrations.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const JobStatus = z.enum([
  "Pending", // ATS handshake started, submission not yet confirmed
  "Applied",
  "Interviewing",
  "Offer",
  "Rejected",
  "Ghosted",
]);
export type JobStatus = z.infer<typeof JobStatus>;

/**
 * Contact lifecycle. `Pending` -> `Accepted` -> `Replied` is the happy path.
 * `Follow_Up_Required` is set by the follow-up engine when an accepted contact
 * has gone quiet past the configured threshold.
 */
export const ContactStatus = z.enum([
  "Pending",
  "Accepted",
  "Replied",
  "Follow_Up_Required",
]);
export type ContactStatus = z.infer<typeof ContactStatus>;

export const Persona = z.enum([
  "Engineering_Leader",
  "Technical_Recruiter",
  "Peer_Engineer",
  /**
   * Someone at a target company whose job is not engineering: support, success,
   * operations, sales. The PRD lists three personas, but forcing a Support Team
   * Lead into "Peer_Engineer" produced a draft that asked him about inference
   * latency — a question he has no way to answer, from a stranger. They are
   * worth writing to; they are not worth writing to as if they were engineers.
   */
  "Adjacent_Employee",
  /**
   * Founder, CEO, CTO, VP — someone who owns the business rather than a team
   * inside it. Kept separate from Engineering_Leader because they measure a
   * candidate in revenue, retention and risk rather than in delivery
   * throughput, and because they answer in two lines or not at all.
   */
  "Founder_Executive",
]);
export type Persona = z.infer<typeof Persona>;

export const MessageType = z.enum([
  "connection_note",
  "initial_outreach",
  "follow_up",
]);
export type MessageType = z.infer<typeof MessageType>;

export const ApplySource = z.enum(["linkedin_easy_apply", "external_ats"]);
export type ApplySource = z.infer<typeof ApplySource>;

export const AtsVendor = z.enum([
  "greenhouse",
  "lever",
  "workday",
  "ashby",
  "rippling",
  "hibob",
  "unknown",
]);
export type AtsVendor = z.infer<typeof AtsVendor>;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const Job = z.object({
  id: z.string().uuid(),
  company: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  location: z.string().nullable(),
  jd_text: z.string().nullable(),
  status: JobStatus,
  source: ApplySource,
  external_job_id: z.string().nullable(),
  applied_at: z.string().nullable(),
  created_at: z.string(),
});
export type Job = z.infer<typeof Job>;

export const Resume = z.object({
  id: z.string().uuid(),
  job_id: z.string().uuid(),
  file_name: z.string(),
  /** Supabase Storage object path. The bytes live in the `resumes` bucket. */
  storage_path: z.string(),
  extracted_text: z.string(),
  uploaded_at: z.string(),
});
export type Resume = z.infer<typeof Resume>;

export const ResumeChunk = z.object({
  id: z.string().uuid(),
  resume_id: z.string().uuid(),
  job_id: z.string().uuid(),
  chunk_index: z.number().int(),
  chunk_text: z.string(),
});
export type ResumeChunk = z.infer<typeof ResumeChunk>;

export const Contact = z.object({
  id: z.string().uuid(),
  job_id: z.string().uuid().nullable(),
  name: z.string(),
  linkedin_url: z.string(),
  headline: z.string().nullable(),
  company: z.string().nullable(),
  /**
   * A condensed read of the recipient's About, Experience and Skills sections.
   *
   * The headline is one line the person wrote once and forgot; this is what they
   * actually do. It steers which resume evidence is retrieved and gives the
   * agent something specific to open with. `.nullish()` rather than `.nullable()`
   * because rows written before migration 0010 have no such key at all.
   */
  profile_text: z.string().nullish(),
  /** When the profile was last read. Distinguishes "never looked" from "thin". */
  profile_read_at: z.string().nullish(),
  persona: Persona.nullable(),
  status: ContactStatus,
  connected_at: z.string().nullable(),
  accepted_at: z.string().nullable(),
  last_checked_at: z.string().nullable(),
  created_at: z.string(),
});
export type Contact = z.infer<typeof Contact>;

/**
 * What the critique still said about the draft at the moment it was saved.
 *
 * Recorded on the message rather than returned from `POST /draft`, because the
 * side panel renders drafts from the stored list: a response-only field is gone
 * the moment the panel reloads, and a background sweep writes most drafts with
 * nobody watching. Without it the panel showed a draft carrying a surviving
 * problem exactly as it showed a clean one, and two such messages were approved
 * and sent on that basis.
 */
export const DraftReview = z.object({
  /** Resume chunks the draft was built from. Zero means nothing in it is backed. */
  evidenceCount: z.number().int(),
  /** Critique problems the repair passes could not fix. */
  problems: z.array(z.string()),
  /** Figures with no source in the retrieved evidence. */
  ungroundedFigures: z.array(z.string()),
  /**
   * Figures whose only source in the retrieved evidence is a summary section.
   *
   * Not a fault — the figure is the user's own. But a summary restates results
   * stripped of the work that produced them, so the evidence cannot say whether
   * the claim the draft wrapped around it is the claim the resume made. Nadia
   * Haddad's draft took a CSAT the resume earns under "led weekly stakeholder
   * reviews… explaining SQR / PeopleCode logic" and wrote "built systems that
   * maintain client satisfaction above 9.5/10". Every check passed it, and each
   * was right on its own terms: the figure *is* in the evidence, and the single
   * chunk holding it is also the chunk the sentence most resembles.
   *
   * `.default([])` so a row written before this field existed parses to an empty
   * list instead of failing, and the panel never tests for undefined.
   */
  summaryOnlyFigures: z.array(z.string()).default([]),
  /** Model repair calls spent. Two with problems left is a run that did not converge. */
  repairPasses: z.number().int(),
});
export type DraftReview = z.infer<typeof DraftReview>;

export const Message = z.object({
  id: z.string().uuid(),
  contact_id: z.string().uuid(),
  job_id: z.string().uuid().nullable(),
  type: MessageType,
  draft_text: z.string(),
  sent_text: z.string().nullable(),
  sent_at: z.string().nullable(),
  /** `.nullish()`: rows written before migration 0012 have no such key at all. */
  review: DraftReview.nullish(),
  created_at: z.string(),
});
export type Message = z.infer<typeof Message>;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** One fused result from the hybrid (dense + sparse) retrieval step. */
export const HybridSearchHit = z.object({
  chunk_id: z.string().uuid(),
  resume_id: z.string().uuid(),
  /**
   * Position of this chunk within its resume. Stable across re-indexing because
   * `chunkResumeText` is deterministic, which is what lets the eval set label
   * relevant chunks by index — a database-generated `chunk_id` cannot be
   * written down in a committed fixture.
   */
  chunk_index: z.number(),
  chunk_text: z.string(),
  dense_rank: z.number().nullable(),
  sparse_rank: z.number().nullable(),
  rrf_score: z.number(),
});
export type HybridSearchHit = z.infer<typeof HybridSearchHit>;

// ---------------------------------------------------------------------------
// Pending handshake (Feature 1, external ATS flow)
// ---------------------------------------------------------------------------

/**
 * Written to chrome.storage.local when the user leaves LinkedIn for an external
 * ATS, and committed to the database once that ATS reports a successful submit.
 */
export const PendingApplication = z.object({
  handshakeId: z.string(),
  company: z.string(),
  title: z.string(),
  location: z.string().nullable(),
  jdText: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  externalJobId: z.string().nullable(),
  /** Tab that was opened for the ATS, used to scope the handshake. */
  tabId: z.number().nullable(),
  createdAt: z.number(),
});
export type PendingApplication = z.infer<typeof PendingApplication>;
