import { z } from "zod";
import {
  DEFAULT_FOLLOW_UP_DAYS,
  MAX_FOLLOW_UP_DAYS,
  MAX_INSTRUCTION_CHARS,
  MAX_JD_TEXT_CHARS,
  MAX_PROFILE_TEXT_CHARS,
  MAX_RESUME_BASE64_CHARS,
  MAX_RESUME_BYTES,
  MAX_RESUME_TEXT_CHARS,
  MAX_SEARCH_QUERY_CHARS,
  MAX_SENT_TEXT_CHARS,
  MAX_SHORT_TEXT_CHARS,
  MAX_URL_CHARS,
  MIN_FOLLOW_UP_DAYS,
} from "./constants";
import {
  ApplySource,
  Contact,
  ContactStatus,
  HybridSearchHit,
  Job,
  JobStatus,
  Message,
  MessageType,
  Persona,
  Resume,
} from "./types";

/** Request/response contracts for the proxy server. */

// --- Jobs ------------------------------------------------------------------

export const CreateJobRequest = z.object({
  company: z.string().min(1).max(MAX_SHORT_TEXT_CHARS),
  title: z.string().min(1).max(MAX_SHORT_TEXT_CHARS),
  url: z.string().max(MAX_URL_CHARS).nullish(),
  location: z.string().max(MAX_SHORT_TEXT_CHARS).nullish(),
  jdText: z.string().max(MAX_JD_TEXT_CHARS).nullish(),
  source: ApplySource,
  externalJobId: z.string().max(MAX_SHORT_TEXT_CHARS).nullish(),
  status: JobStatus.default("Applied"),
  appliedAt: z.string().max(MAX_SHORT_TEXT_CHARS).nullish(),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequest>;

export const UpdateJobRequest = z.object({
  status: JobStatus.optional(),
  title: z.string().max(MAX_SHORT_TEXT_CHARS).optional(),
  company: z.string().max(MAX_SHORT_TEXT_CHARS).optional(),
  jdText: z.string().max(MAX_JD_TEXT_CHARS).optional(),
});
export type UpdateJobRequest = z.infer<typeof UpdateJobRequest>;

// --- Resumes ---------------------------------------------------------------

/**
 * The extension uploads the raw PDF bytes; the server extracts text, chunks and
 * embeds it.
 *
 * The PRD specifies in-browser parsing with pdf.js, which we deliberately do
 * not do. MV3 content scripts run in the host page's origin, so spawning
 * pdf.js's web worker is blocked by LinkedIn's and most ATS platforms' CSP.
 * More importantly, this deployment stores the PDF in Supabase anyway, so the
 * file already leaves the device and local parsing would buy no privacy — only
 * an offscreen-document workaround's worth of complexity.
 */
export const UploadResumeRequest = z.object({
  jobId: z.string().uuid(),
  fileName: z.string().min(1).max(MAX_SHORT_TEXT_CHARS),
  /**
   * base64-encoded PDF bytes.
   *
   * Bounded here rather than at the route, so the extension's own type says the
   * limit exists and a caller cannot build a request that is rejected for a
   * reason it never had to think about.
   */
  fileBase64: z
    .string()
    .min(1)
    .max(
      MAX_RESUME_BASE64_CHARS,
      `Resume must be under ${Math.round(MAX_RESUME_BYTES / 1024 / 1024)}MB.`,
    ),
  /**
   * Optional pre-extracted text; the server extracts when omitted.
   *
   * Bounded separately from `fileBase64` because supplying it *skips the PDF
   * parser entirely* (see the route). The 10MB ceiling above therefore does not
   * constrain this field at all, and whatever arrives here is chunked, embedded
   * and stored — so an unbounded value is an unbounded OpenAI bill.
   */
  extractedText: z.string().max(MAX_RESUME_TEXT_CHARS).nullish(),
  /**
   * The applicant's own name. The vault stores every resume as
   * `<Name>_<Company>_<Role>.pdf` regardless of what the file was called on
   * disk, because "resume(3).pdf" is indistinguishable from every other one.
   */
  userName: z.string().max(MAX_SHORT_TEXT_CHARS).nullish(),
  /**
   * Permission to overwrite the resume already filed against this job.
   *
   * Absent it the upload is refused, because replacement is destructive and
   * unrecoverable: the storage key is derived from the job, so a second upload
   * resolves to the same object and overwrites the bytes in place. On
   * 2026-10-01 that silently destroyed a tailored CV when a misrouted upload
   * landed on an application that already had one.
   */
  replace: z.boolean().optional(),
});
export type UploadResumeRequest = z.infer<typeof UploadResumeRequest>;

export const UploadResumeResponse = z.object({
  resume: Resume,
  chunkCount: z.number().int(),
});
export type UploadResumeResponse = z.infer<typeof UploadResumeResponse>;

// --- Contacts --------------------------------------------------------------

/**
 * Sent when the user clicks Connect on a profile. The server runs the fuzzy
 * company match; if it is ambiguous the extension is told to prompt the user.
 */

export const CaptureContactRequest = z.object({
  name: z.string().min(1).max(MAX_SHORT_TEXT_CHARS),
  linkedinUrl: z.string().min(1).max(MAX_URL_CHARS),
  headline: z.string().max(MAX_SHORT_TEXT_CHARS).nullish(),
  company: z.string().max(MAX_SHORT_TEXT_CHARS).nullish(),
  profileText: z.string().max(MAX_PROFILE_TEXT_CHARS).nullish(),
  /** Set when the user has already disambiguated via the toast. */
  jobId: z.string().uuid().nullish(),
});
export type CaptureContactRequest = z.infer<typeof CaptureContactRequest>;

export const CaptureContactResponse = z.object({
  contact: Contact,
  /** `ambiguous` means the UI must ask the user which job to link. */
  resolution: z.enum(["auto_linked", "ambiguous", "general_networking"]),
  candidateJobs: z.array(Job),
});
export type CaptureContactResponse = z.infer<typeof CaptureContactResponse>;

/**
 * Fill in details for a contact the extension already has.
 *
 * A contact captured from a people card, or created from the Sent invitations
 * page, often has no headline — the row simply does not render one. The
 * headline is what decides the recipient's persona, and therefore which resume
 * evidence a draft is built from, so a null one is not cosmetic: it produced a
 * message that asked an HR coordinator how her team measures AI work.
 *
 * Deliberately separate from capture: capture upserts `status` and
 * `connected_at`, which would reset an already-accepted contact to Pending.
 * This only ever fills columns that are currently null.
 */
export const EnrichContactRequest = z.object({
  linkedinUrl: z.string().min(1).max(MAX_URL_CHARS),
  headline: z.string().max(MAX_SHORT_TEXT_CHARS).nullish(),
  company: z.string().max(MAX_SHORT_TEXT_CHARS).nullish(),
  profileText: z.string().max(MAX_PROFILE_TEXT_CHARS).nullish(),
});
export type EnrichContactRequest = z.infer<typeof EnrichContactRequest>;

export const UpdateContactRequest = z.object({
  status: ContactStatus.optional(),
  jobId: z.string().uuid().nullish(),
  persona: Persona.optional(),
});
export type UpdateContactRequest = z.infer<typeof UpdateContactRequest>;

// --- Search ----------------------------------------------------------------

export const HybridSearchRequest = z.object({
  jobId: z.string().uuid(),
  /** Natural-language query, embedded for the dense leg. */
  query: z.string().min(1).max(MAX_SEARCH_QUERY_CHARS),
  /** Keyword query for the sparse leg. Defaults to `query` when omitted. */
  keywords: z.string().max(MAX_SEARCH_QUERY_CHARS).nullish(),
  limit: z.number().int().min(1).max(20).default(3),
});
export type HybridSearchRequest = z.infer<typeof HybridSearchRequest>;

export const HybridSearchResponse = z.object({
  hits: z.array(HybridSearchHit),
});
export type HybridSearchResponse = z.infer<typeof HybridSearchResponse>;

// --- Drafting --------------------------------------------------------------

export const DraftRequest = z.object({
  contactId: z.string().uuid(),
  type: MessageType,
  /** Optional steer from the user, e.g. "mention the Kafka migration". */
  instruction: z.string().max(MAX_INSTRUCTION_CHARS).nullish(),
});
export type DraftRequest = z.infer<typeof DraftRequest>;

export const DraftResponse = z.object({
  message: Message,
  persona: Persona,
  /** Resume bullets the model was given, surfaced for user transparency. */
  citations: z.array(HybridSearchHit),
  /** Tool calls the agent made, for debugging the ReAct loop. */
  trace: z.array(
    z.object({
      tool: z.string(),
      args: z.record(z.unknown()),
    }),
  ),
});
export type DraftResponse = z.infer<typeof DraftResponse>;

/** Records that the user actually sent a draft (they click Send themselves). */
export const MarkSentRequest = z.object({
  sentText: z.string().min(1).max(MAX_SENT_TEXT_CHARS),
});
export type MarkSentRequest = z.infer<typeof MarkSentRequest>;

// --- Polling ---------------------------------------------------------------

/**
 * The background worker scrapes connection/reply state from the DOM and
 * reconciles it here. The server decides which contacts now need a follow-up.
 */
export const SyncObservationsRequest = z.object({
  observations: z.array(
    z.object({
      linkedinUrl: z.string(),
      /** True when the profile now shows as a 1st-degree connection. */
      accepted: z.boolean().nullish(),
      /** True when an inbound message from this contact was seen. */
      replied: z.boolean().nullish(),
    }),
  ),
  /**
   * How many silent days make an accepted contact due a follow-up.
   *
   * It travels on the request because the extension owns settings — there is no
   * user table on the server to read it from. It used to be a server env var
   * while the side panel displayed the extension's own setting, so the two
   * could disagree and the countdown the user was shown was not the deadline
   * the sweep enforced.
   */
  followUpDays: z.coerce
    .number()
    .int()
    .min(MIN_FOLLOW_UP_DAYS)
    .max(MAX_FOLLOW_UP_DAYS)
    .default(DEFAULT_FOLLOW_UP_DAYS),
});
export type SyncObservationsRequest = z.infer<typeof SyncObservationsRequest>;

export const SyncObservationsResponse = z.object({
  updated: z.number().int(),
  /** Contacts that transitioned into a state needing a drafted message. */
  needsDraft: z.array(
    z.object({ contact: Contact, type: MessageType }),
  ),
});
export type SyncObservationsResponse = z.infer<typeof SyncObservationsResponse>;

export const ApiError = z.object({
  error: z.string(),
  detail: z.string().nullish(),
});
export type ApiError = z.infer<typeof ApiError>;
