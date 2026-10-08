import type {
  CaptureContactRequest,
  CaptureContactResponse,
  Contact,
  EnrichContactRequest,
  Job,
} from "@crm/shared";
import { capProfileText } from "@crm/shared";
import { db, unwrap } from "../db";
import { companiesMatch, companyFromHeadline, normalizeCompany } from "./company-match";

/**
 * Decide whether a freshly-read profile replaces the stored one.
 *
 * Unlike headline and company, this is not "fill only when null": a later read
 * of the same profile is better data, and the profile the draft is built from
 * should be the current one.
 *
 * But only when it is *richer*. `reportProfileDetails` fires on a timer after
 * navigation, and LinkedIn hydrates About, Experience and Skills independently,
 * so an early read can legitimately return the headline alone. Without the
 * length test, opening someone's profile and navigating away a second later
 * would replace a complete profile with a one-liner — the exact failure this
 * whole column exists to prevent. A genuinely shortened profile therefore
 * sticks at its old length, which is the cheaper of the two mistakes.
 *
 * The cap is re-applied here rather than trusted from the wire: a content
 * script runs in the host page's world and is not a trusted writer.
 */
function profilePatch(
  existing: Contact,
  incoming: string | null | undefined,
): Record<string, string> {
  const text = incoming?.trim() ? capProfileText(incoming.trim()) : null;
  if (!text) return {};
  if (text.length <= (existing.profile_text?.length ?? 0)) return {};
  return { profile_text: text, profile_read_at: new Date().toISOString() };
}

/**
 * Feature 3: link a new contact to an application by fuzzy company match.
 *
 * Resolution follows the PRD: exactly one match auto-links, several require the
 * user to disambiguate, none falls back to General Networking. The contact row
 * is always created — losing the contact because matching was ambiguous would
 * be worse than leaving job_id null.
 *
 * **A second capture of a known contact never resets their state.** This was a
 * blanket upsert, so clicking Connect again on someone who had already accepted
 * — LinkedIn still renders the control, and the user has no way to know the
 * difference — wrote `status: "Pending"`, a fresh `connected_at`, and whatever
 * `job_id` the match happened to produce this time. The contact silently left
 * the Connected list, the follow-up clock restarted, and the link to the
 * application they were captured for was replaced by `null`, which is what
 * decides whose resume the next draft is written from.
 *
 * So the re-capture path behaves like `enrichContact`: fill blanks, touch
 * nothing that is already set. The one exception is an explicit `jobId`, which
 * only ever arrives because the user answered the disambiguation toast — that
 * is a decision, not an observation, and it outranks whatever is stored.
 */
export async function captureContact(
  input: CaptureContactRequest,
): Promise<CaptureContactResponse> {
  const company = input.company ?? companyFromHeadline(input.headline);

  // An explicit jobId means the user already answered the disambiguation toast.
  const candidates = !input.jobId && company ? await matchingJobs(company) : [];

  let jobId: string | null = input.jobId ?? null;
  let resolution: CaptureContactResponse["resolution"] = "general_networking";

  if (input.jobId) {
    resolution = "auto_linked";
  } else if (candidates.length === 1) {
    jobId = candidates[0]!.id;
    resolution = "auto_linked";
  } else if (candidates.length > 1) {
    // Leave job_id null until the user picks; a wrong link silently poisons
    // every future draft for that contact.
    resolution = "ambiguous";
  }

  const existing = (
    await db
      .from("contacts")
      .select("*")
      .eq("linkedin_url", input.linkedinUrl)
      .maybeSingle()
  ).data as Contact | null;

  if (existing) {
    const patch: Record<string, string> = profilePatch(existing, input.profileText);
    if (!existing.headline && input.headline?.trim()) patch.headline = input.headline.trim();
    if (!existing.company && company) patch.company = company;
    if (input.jobId) patch.job_id = input.jobId;
    else if (!existing.job_id && jobId) patch.job_id = jobId;

    const contact =
      Object.keys(patch).length === 0
        ? existing
        : (unwrap(
            await db.from("contacts").update(patch).eq("id", existing.id).select().single(),
            "Update captured contact",
          ) as Contact);

    // The stored link is the truth, not this call's match. Someone already
    // linked must not be reported as "general networking" just because their
    // employer happens to be ambiguous today.
    //
    // `candidateJobs` is narrowed to the one actually linked, because the toast
    // names `candidateJobs[0]` when the resolution is `auto_linked`. Handing it
    // the full ambiguous list would have it announce "linked to <the first
    // candidate>" for a contact linked to a different one.
    if (contact.job_id) {
      return {
        contact,
        resolution: "auto_linked",
        candidateJobs: candidates.filter((job) => job.id === contact.job_id),
      };
    }

    return { contact, resolution, candidateJobs: candidates };
  }

  // A Connect click from a people card carries no profile text — the card is a
  // name and one line — so this is usually null and filled by the first visit
  // to the person's own profile.
  const profileText = input.profileText?.trim()
    ? capProfileText(input.profileText.trim())
    : null;

  // `upsert` rather than `insert` purely to close the race between the read
  // above and this write: two Connect clicks in flight at once are both
  // creating the same brand-new contact, for whom Pending is correct anyway.
  const contact = unwrap(
    await db
      .from("contacts")
      .upsert(
        {
          name: input.name,
          linkedin_url: input.linkedinUrl,
          headline: input.headline ?? null,
          company: company ?? null,
          profile_text: profileText,
          profile_read_at: profileText ? new Date().toISOString() : null,
          job_id: jobId,
          status: "Pending",
          connected_at: new Date().toISOString(),
        },
        { onConflict: "linkedin_url" },
      )
      .select()
      .single(),
    "Upsert contact",
  ) as Contact;

  return { contact, resolution, candidateJobs: candidates };
}

/** Tracked applications whose employer fuzzy-matches this company name. */
async function matchingJobs(company: string): Promise<Job[]> {
  const { data, error } = await db.rpc("match_jobs_by_company", {
    p_company: normalizeCompany(company),
  });
  if (error) throw new Error(`match_jobs_by_company: ${error.message}`);
  return (data ?? []) as Job[];
}

/**
 * Fill in a known contact's missing details from a profile the user just
 * visited.
 *
 * Capture reads whatever surface the Connect button was on, and a people card
 * frequently renders no headline at all — it puts "Message" or "Pending" where
 * the headline would go, and the scraper correctly refuses to file that as one.
 * The contact is then stored with `headline: null`, the drafting agent sees
 * `recipientTitle: "employee"`, and every message written for that person is
 * aimed at nobody in particular.
 *
 * Only null columns are written, `profile_text` excepted — see `profilePatch`.
 * A headline the user has since corrected, or a company the server already
 * matched an application against, must not be clobbered by a later page read —
 * and `status` is deliberately not touched, which is the whole reason this is
 * not just another `captureContact` upsert.
 *
 * Unknown profiles are ignored rather than created: this fires on every profile
 * page the user opens, and turning that into contact creation would fill the
 * CRM with everyone they have ever looked at.
 */
export async function enrichContact(
  input: EnrichContactRequest,
): Promise<{ contact: Contact | null; updated: boolean }> {
  const existing = (
    await db
      .from("contacts")
      .select("*")
      .eq("linkedin_url", input.linkedinUrl)
      .maybeSingle()
  ).data as Contact | null;

  if (!existing) return { contact: null, updated: false };

  const patch: Record<string, string> = profilePatch(existing, input.profileText);
  if (!existing.headline && input.headline?.trim()) patch.headline = input.headline.trim();

  const company =
    input.company?.trim() || companyFromHeadline(patch.headline ?? null) || null;
  if (!existing.company && company) patch.company = company;

  // Learning where someone works is also the missing half of the company match:
  // the contact was filed as general networking only because their employer was
  // unknown at capture time. Same single-match rule as everywhere else — two
  // open applications at one company is the case we refuse to guess at.
  if (!existing.job_id && patch.company) {
    const candidates = await matchingJobs(patch.company);
    if (candidates.length === 1) patch.job_id = candidates[0]!.id;
  }

  if (Object.keys(patch).length === 0) return { contact: existing, updated: false };

  const contact = unwrap(
    await db.from("contacts").update(patch).eq("id", existing.id).select().single(),
    "Enrich contact",
  ) as Contact;

  return { contact, updated: true };
}

/**
 * Feature 3, the other direction: link contacts the user met *before* they
 * applied.
 *
 * Matching only ever ran when a contact was created, so it could only see
 * applications that already existed. Connecting with five people at Vector AI
 * and applying afterwards — the normal order, since a job posting is what sends
 * you looking for people in the first place — left all five filed as "general
 * networking" with a dropdown the user had to work through by hand. The PRD's
 * claim that ordering is irrelevant only holds if the match runs on both
 * events, so it now also runs when an application appears.
 *
 * A contact is linked only when this job is the *single* application matching
 * their employer. Two open applications at one company is exactly the case
 * `captureContact` refuses to guess at, and a wrong link silently poisons every
 * draft written for that person afterwards.
 */
export async function linkContactsForJob(job: Job): Promise<number> {
  const [contacts, jobs] = await Promise.all([
    db.from("contacts").select("*").is("job_id", null),
    db.from("jobs").select("id, company"),
  ]);

  const unlinked = unwrap(contacts, "List unlinked contacts") as Contact[];
  const allJobs = unwrap(jobs, "List jobs for backfill") as Array<{
    id: string;
    company: string;
  }>;

  const ids = unlinked
    .filter((contact) => {
      const employer = contact.company ?? companyFromHeadline(contact.headline);
      const matches = allJobs.filter((candidate) =>
        companiesMatch(candidate.company, employer),
      );
      return matches.length === 1 && matches[0]!.id === job.id;
    })
    .map((contact) => contact.id);

  if (ids.length === 0) return 0;

  unwrap(
    await db.from("contacts").update({ job_id: job.id }).in("id", ids).select("id"),
    "Link contacts to job",
  );
  return ids.length;
}
