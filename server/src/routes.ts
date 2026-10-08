import { Hono, type Context } from "hono";
import {
  CaptureContactRequest,
  DraftRequest,
  EnrichContactRequest,
  HybridSearchRequest,
  MarkSentRequest,
  CreateJobRequest,
  type Job,
  type Message,
  type Resume,
  SyncObservationsRequest,
  UpdateContactRequest,
  UpdateJobRequest,
  UploadResumeRequest,
} from "@crm/shared";
import { MAX_CONTACTS_PER_SWEEP } from "@crm/shared/constants";
import { looksLikeJobTitle } from "@crm/shared/job-title";
import { z } from "zod";
import { RESUME_BUCKET, db, unwrap } from "./db";
import { indexResume } from "./rag/index-resume";
import { extractPdfText } from "./rag/pdf";
import { hybridSearch } from "./rag/search";
import { captureContact, enrichContact, linkContactsForJob } from "./services/contacts";
import { syncObservations } from "./services/followup";
import { generateDraft } from "./agent/draft";

export const api = new Hono();

/** Parse a JSON body against a zod schema, returning a 400 on failure. */
async function parseBody<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => null);
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new HttpError(400, "Invalid request body", result.error.message);
  }
  return result.data;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: string,
  ) {
    super(message);
  }
}

// --- Jobs ------------------------------------------------------------------

api.get("/jobs", async (c) => {
  const data = unwrap(
    await db.from("jobs").select("*").order("created_at", { ascending: false }),
    "List jobs",
  );
  return c.json({ jobs: data });
});

api.post("/jobs", async (c) => {
  const body = await parseBody(c, CreateJobRequest);
  const title = assertJobTitle(body.title);

  const row = {
    company: body.company,
    title,
    url: body.url ?? null,
    location: body.location ?? null,
    jd_text: body.jdText ?? null,
    source: body.source,
    external_job_id: body.externalJobId ?? null,
    status: body.status,
    applied_at: body.appliedAt ?? new Date().toISOString(),
  };

  const existingId = body.externalJobId
    ? await findJobId(body.company, body.externalJobId)
    : null;

  const query = existingId
    ? db.from("jobs").update(row).eq("id", existingId)
    : db.from("jobs").insert(row);

  // The insert and update branches have different row types, which PostgREST
  // narrows to `never`; the row shape is the same either way.
  const job = unwrap(await query.select().single(), "Create job") as Job;

  // Contacts already captured at this employer were matched against the
  // applications that existed at the time, which did not include this one.
  const linked = await linkContactsForJob(job);
  if (linked > 0) console.info(`[crm] linked ${linked} existing contact(s) to ${job.company}`);

  return c.json({ job, linkedContacts: linked }, 201);
});

/**
 * Refuse a title that is a LinkedIn control's label rather than a job.
 *
 * The scraper already drops these, but it is not the only way a title reaches
 * this table: the manual "I applied" flow and the ATS scrapers both post here.
 * And a bad title is not a cosmetic data-entry problem — it feeds
 * `extractRoleKeywords`, the concern lens and the rerank rubric, so every
 * retrieval decision for that application is steered by a button's text. Three
 * rows were filed as "Share negative feedback" and "Remote" and nothing
 * complained.
 */
function assertJobTitle(title: string): string {
  const valid = looksLikeJobTitle(title);
  if (!valid) {
    throw new HttpError(
      400,
      "That is not a job title",
      `"${title}" is a LinkedIn control's label, not a role. Open the job posting ` +
        "itself and track it from there, or enter the title by hand.",
    );
  }
  return valid;
}

/**
 * Find an already-tracked row for the same requisition, so re-applying updates
 * instead of duplicating.
 *
 * Deliberately a read-then-write rather than an upsert: the guarding unique
 * index is on `(lower(company), external_job_id)` and is partial, while
 * PostgREST's `on_conflict` can only name plain columns. Postgres then finds no
 * arbiter matching `(company, external_job_id)` and rejects the whole statement
 * with "no unique or exclusion constraint matching the ON CONFLICT
 * specification" — every insert fails, not just the conflicting ones.
 *
 * Matching on `external_job_id` alone and comparing the company here keeps the
 * case-insensitivity of the index without pushing `lower()` through PostgREST.
 */
async function findJobId(company: string, externalJobId: string): Promise<string | null> {
  const rows = unwrap(
    await db.from("jobs").select("id, company").eq("external_job_id", externalJobId),
    "Find tracked job",
  );

  const target = company.toLowerCase();
  return rows.find((row) => row.company.toLowerCase() === target)?.id ?? null;
}

api.patch("/jobs/:id", async (c) => {
  const body = await parseBody(c, UpdateJobRequest);
  const patch: Record<string, unknown> = {};
  if (body.status) patch.status = body.status;
  if (body.title) patch.title = assertJobTitle(body.title);
  if (body.company) patch.company = body.company;
  if (body.jdText) patch.jd_text = body.jdText;

  const job = unwrap(
    await db.from("jobs").update(patch).eq("id", c.req.param("id")).select().single(),
    "Update job",
  ) as Job;

  // Same invariant as on create: whenever a job row is written, contacts at
  // that employer are reconciled against it. Without this, applications tracked
  // before the fix existed would stay unlinked forever.
  const linked = await linkContactsForJob(job);

  return c.json({ job, linkedContacts: linked });
});

// --- Resumes (Document Vault) ----------------------------------------------

api.post("/resumes", async (c) => {
  const body = await parseBody(c, UploadResumeRequest);
  const fileBytes = Buffer.from(body.fileBase64, "base64");

  // Replacement is destructive and unrecoverable: indexResume deletes the old
  // object once the new one is committed, and Supabase Storage keeps no version
  // of what was there. A misrouted upload must therefore fail rather than
  // overwrite — the extension puts a rejected resume back in its stash, so the
  // application it actually belongs to can still claim it. Overwriting instead
  // destroyed a tailored CV on 2026-10-01.
  if (!body.replace) {
    // Not `unwrap`: a null row is the happy path here, not a failure. An actual
    // query error still throws, because a guard that fails open is no guard.
    const lookup = await db
      .from("resumes")
      .select("file_name")
      .eq("job_id", body.jobId)
      .maybeSingle();
    if (lookup.error) throw new Error(`Check for an existing resume: ${lookup.error.message}`);
    const existing = lookup.data as { file_name: string } | null;

    if (existing) {
      throw new HttpError(
        409,
        "That application already has a resume",
        `${existing.file_name} is already filed against it. Replacing it would destroy the original, so this upload was refused.`,
      );
    }
  }

  const extractedText = body.extractedText?.trim()
    ? body.extractedText
    : await extractPdfText(fileBytes);

  if (!extractedText.trim()) {
    // Almost always a scanned/image-only PDF. Storing it with no text would
    // create a resume the drafting agent can never cite from.
    throw new HttpError(
      422,
      "No text could be extracted from that PDF",
      "It is likely a scan or image-only export. Upload a text-based PDF so outreach can cite it.",
    );
  }

  const result = await indexResume({
    jobId: body.jobId,
    fileName: body.fileName,
    fileBytes,
    extractedText,
    userName: body.userName,
  });
  return c.json(result, 201);
});

api.get("/resumes", async (c) => {
  const data = unwrap(
    await db
      .from("resumes")
      .select("id, job_id, file_name, storage_path, uploaded_at")
      .order("uploaded_at", { ascending: false }),
    "List resumes",
  );
  return c.json({ resumes: data });
});

/** Short-lived signed URL so the side panel can offer the original PDF back. */
api.get("/resumes/:id/download", async (c) => {
  const resume = unwrap(
    await db.from("resumes").select("storage_path, file_name").eq("id", c.req.param("id")).single(),
    "Load resume",
  ) as Pick<Resume, "storage_path" | "file_name">;

  // `download` sets Content-Disposition on the signed URL, so the browser saves
  // the vault's canonical name instead of guessing one from the storage path.
  // Without it the panel's `window.open(url)` produced whatever the object key
  // happened to be.
  const { data, error } = await db.storage
    .from(RESUME_BUCKET)
    .createSignedUrl(resume.storage_path, 60, { download: resume.file_name });

  if (error) throw new HttpError(500, "Could not sign resume URL", error.message);
  return c.json({ url: data.signedUrl, fileName: resume.file_name });
});

// --- Contacts --------------------------------------------------------------

api.get("/contacts", async (c) => {
  const data = unwrap(
    await db.from("contacts").select("*").order("created_at", { ascending: false }),
    "List contacts",
  );
  return c.json({ contacts: data });
});

api.post("/contacts/capture", async (c) => {
  const body = await parseBody(c, CaptureContactRequest);
  return c.json(await captureContact(body), 201);
});

/**
 * Fill in details for a contact we already have. Unknown profiles are a no-op,
 * not a 404: the extension calls this on every profile page the user opens and
 * most of them are strangers.
 */
api.post("/contacts/enrich", async (c) => {
  const body = await parseBody(c, EnrichContactRequest);
  return c.json(await enrichContact(body));
});

api.patch("/contacts/:id", async (c) => {
  const body = await parseBody(c, UpdateContactRequest);
  const patch: Record<string, unknown> = {};
  if (body.status) patch.status = body.status;
  if (body.persona) patch.persona = body.persona;
  if (body.jobId !== undefined) patch.job_id = body.jobId;

  const contact = unwrap(
    await db.from("contacts").update(patch).eq("id", c.req.param("id")).select().single(),
    "Update contact",
  );
  return c.json({ contact });
});

// --- Search ----------------------------------------------------------------

api.post("/search/hybrid", async (c) => {
  const body = await parseBody(c, HybridSearchRequest);
  const hits = await hybridSearch({
    jobId: body.jobId,
    query: body.query,
    keywords: body.keywords,
    limit: body.limit,
  });
  return c.json({ hits });
});

// --- Messages / drafting ---------------------------------------------------

api.get("/messages", async (c) => {
  const pendingOnly = c.req.query("pending") === "true";
  let query = db.from("messages").select("*").order("created_at", { ascending: false });
  if (pendingOnly) query = query.is("sent_at", null);

  const data = unwrap(await query, "List messages");
  return c.json({ messages: data });
});

api.post("/drafts", async (c) => {
  const body = await parseBody(c, DraftRequest);
  const result = await generateDraft({
    contactId: body.contactId,
    type: body.type,
    instruction: body.instruction,
  });
  return c.json(result, 201);
});

/**
 * Records that the user sent a draft. The extension never clicks Send itself
 * (PRD section 6.3); this is called after the user confirms they sent it.
 *
 * Sending also clears `Follow_Up_Required`. `sweepStaleContacts` sets that
 * status to mean "this person is owed a follow-up", and nothing used to take it
 * off again — so on 2026-10-01 four follow-ups were written, approved and sent,
 * and all four contacts still read "No reply for 5+ days — a follow-up is due"
 * with a "Draft follow-up" button next to them. The panel was describing work
 * the user had already done.
 *
 * This is the same invariant the company matcher learned: *any write that
 * changes what the system should do next has to reconcile the state that
 * decides it.* Leaving the status to a later sweep is not equivalent — the
 * sweep runs every 30–90 minutes, and a system that tells you to redo a task
 * you just finished has stopped being autonomous.
 *
 * Scoped `.eq("status", "Follow_Up_Required")` rather than written
 * unconditionally: a `Replied` contact must not be demoted to `Accepted`
 * because the user sent them something, and a `Pending` one has not accepted
 * the invitation yet. The follow-up clock then restarts from this `sent_at`,
 * so the sweep re-flags them in `followUpDays` if they stay quiet — bounded by
 * `MAX_FOLLOW_UPS_PER_CONTACT`, which counts messages *sent*.
 */
api.post("/messages/:id/sent", async (c) => {
  const body = await parseBody(c, MarkSentRequest);
  const message = unwrap(
    await db
      .from("messages")
      .update({ sent_text: body.sentText, sent_at: new Date().toISOString() })
      .eq("id", c.req.param("id"))
      .select()
      .single(),
    "Mark message sent",
  ) as Message;

  if (message.contact_id) {
    unwrap(
      await db
        .from("contacts")
        .update({ status: "Accepted" })
        .eq("id", message.contact_id)
        .eq("status", "Follow_Up_Required")
        .select(),
      "Clear follow-up flag",
    );
  }

  return c.json({ message });
});

/**
 * Throw away a draft the user does not want to send.
 *
 * Without this there was no way to say no. The panel offered Insert, Copy and
 * "Mark as sent", so a draft the user rejected sat in "Needs your approval"
 * permanently, kept the Drafts badge lit, and made the stale-contact sweep skip
 * that contact forever — the sweep's "don't stack follow-up drafts" guard reads
 * an unsent draft as work in progress. Declining is a normal outcome and it
 * needs a control.
 *
 * A *sent* message is not deletable here. `sent_at` is the record of something
 * the recipient has actually read; it is what the follow-up clock runs from and
 * what stops the same introduction being written twice, so deleting it would
 * not tidy the panel, it would make the system forget a conversation happened.
 */
api.delete("/messages/:id", async (c) => {
  const id = c.req.param("id");

  const lookup = await db.from("messages").select("sent_at").eq("id", id).maybeSingle();
  if (lookup.error) throw new Error(`Load message: ${lookup.error.message}`);
  if (!lookup.data) throw new HttpError(404, "No such draft", "It may already be discarded.");

  if ((lookup.data as { sent_at: string | null }).sent_at) {
    throw new HttpError(
      409,
      "That message was already sent",
      "Sent messages are the record of the conversation and cannot be discarded.",
    );
  }

  unwrap(
    await db.from("messages").delete().eq("id", id).is("sent_at", null).select().single(),
    "Discard draft",
  );
  return c.json({ discarded: true });
});

// --- Polling / follow-up engine --------------------------------------------

api.post("/sync/observations", async (c) => {
  const body = await parseBody(c, SyncObservationsRequest);
  return c.json(await syncObservations(body));
});

/** Profiles the background worker should check on its next sweep. */
api.get("/sync/watchlist", async (c) => {
  const requested = Number(c.req.query("limit"));
  // The ceiling was 10 while the worker asks for MAX_CONTACTS_PER_SWEEP, so a
  // sweep silently reconciled the 10 least-recently-checked contacts and never
  // said the other 30 went unread. A sweep costs two page loads regardless of
  // how many contacts it reconciles, so there is nothing to protect here.
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), MAX_CONTACTS_PER_SWEEP)
    : MAX_CONTACTS_PER_SWEEP;
  const data = unwrap(
    await db
      .from("contacts")
      .select("id, name, linkedin_url, status, last_checked_at")
      .in("status", ["Pending", "Accepted"])
      // Least-recently-checked first, so attention spreads evenly.
      .order("last_checked_at", { ascending: true, nullsFirst: true })
      .limit(limit),
    "Load watchlist",
  );
  return c.json({ contacts: data });
});
