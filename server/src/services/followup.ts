import type {
  Contact,
  MessageType,
  SyncObservationsRequest,
  SyncObservationsResponse,
} from "@crm/shared";
import { db } from "../db";

/**
 * Feature 5 state machine.
 *
 * The extension only reports what it observed in the DOM; all transitions are
 * decided here so the rules live in one place and the content scripts stay dumb.
 *
 *   Pending ──accepted──> Accepted ──replied──> Replied   (terminal)
 *                            │
 *                     no reply for N days
 *                            ▼
 *                   Follow_Up_Required ──replied──> Replied
 */
export async function syncObservations(
  input: SyncObservationsRequest,
): Promise<SyncObservationsResponse> {
  const needsDraft: Array<{ contact: Contact; type: MessageType }> = [];
  let updated = 0;

  for (const obs of input.observations) {
    const { data: contact } = await db
      .from("contacts")
      .select("*")
      .eq("linkedin_url", obs.linkedinUrl)
      .maybeSingle();

    if (!contact) continue;
    const current = contact as Contact;

    const patch: Record<string, unknown> = {
      last_checked_at: new Date().toISOString(),
    };

    // A reply is terminal and outranks an acceptance seen in the same sweep.
    if (obs.replied && current.status !== "Replied") {
      patch.status = "Replied";
    } else if (obs.accepted && current.status === "Pending") {
      patch.status = "Accepted";
      patch.accepted_at = new Date().toISOString();
    }

    const { data } = await db
      .from("contacts")
      .update(patch)
      .eq("id", current.id)
      .select()
      .single();

    if (!data) continue;
    const next = data as Contact;

    if (next.status !== current.status) {
      updated++;
      // A fresh acceptance is the trigger for the Feature 4 drafting flow.
      if (next.status === "Accepted") {
        needsDraft.push({ contact: next, type: "initial_outreach" });
      }
    }
  }

  needsDraft.push(...(await sweepStaleContacts(input.followUpDays)));

  return { updated, needsDraft };
}

/**
 * How many follow-ups one contact may be chased with.
 *
 * Unbounded is not an option now that the sweep revisits a contact who is
 * already in `Follow_Up_Required`: someone who never replies would be nudged
 * every `followUpDays` forever, under the user's name, which costs them more
 * than the contact is worth. Two chases after the opener is the point where a
 * reasonable person stops.
 */
const MAX_FOLLOW_UPS_PER_CONTACT = 2;

/**
 * Find contacts we messaged who never replied, past the silence threshold, and
 * make sure a follow-up is drafted and waiting.
 *
 * **`Follow_Up_Required` is swept too, and that is the whole point.** This read
 * `.eq("status", "Accepted")`, so a contact was eligible exactly once: the
 * sweep that moved them out of `Accepted` was the only sweep that could ever
 * return them. If that single drafting attempt did not happen — the worker was
 * asleep, the proxy was down, `draftFor` swallowed the error, the user had not
 * reloaded the extension — the contact was stranded in `Follow_Up_Required`
 * with no draft and no path back. On 2026-10-01 that was 3 of 4 such contacts,
 * the oldest stuck since 2026-09-24, and the panel told the user a follow-up
 * "will be drafted for you" the whole time. A promise that self-destructs on
 * its first failed attempt is worse than no promise.
 *
 * The existing "a draft is already waiting" guard below is what keeps the wider
 * selection from stacking duplicates, and the cutoff runs from the *last sent*
 * message, so sending a follow-up restarts the clock rather than retriggering.
 *
 * `followUpDays` arrives from the extension rather than from a server env var.
 * The side panel promises the user "follow-up in N days" using their own
 * setting, so any second source of truth here makes the product lie about when
 * it will act — and a tool that acts on your behalf is worth nothing if its
 * stated deadline is not the one it keeps.
 */
export async function sweepStaleContacts(
  followUpDays: number,
): Promise<Array<{ contact: Contact; type: MessageType }>> {
  const cutoff = Date.now() - followUpDays * 24 * 60 * 60 * 1000;

  const { data: accepted, error } = await db
    .from("contacts")
    .select("*")
    .in("status", ["Accepted", "Follow_Up_Required"]);

  if (error) throw new Error(`Sweep contacts: ${error.message}`);

  const stale: Array<{ contact: Contact; type: MessageType }> = [];

  for (const row of (accepted ?? []) as Contact[]) {
    const { data: sentMessages } = await db
      .from("messages")
      .select("sent_at, type")
      .eq("contact_id", row.id)
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false });

    const sent = (sentMessages ?? []) as Array<{ sent_at: string; type: MessageType }>;
    const lastSent = sent[0];

    // Nothing sent yet means the user still owes them a first message, not a
    // follow-up. Leave the state alone.
    if (!lastSent?.sent_at) continue;

    if (sent.filter((m) => m.type === "follow_up").length >= MAX_FOLLOW_UPS_PER_CONTACT) {
      continue;
    }

    // Compared as instants, not as strings. PostgREST renders a timestamptz in
    // the session's own format — microsecond precision and a numeric `+00:00`
    // offset — while a JS ISO string has milliseconds and a `Z`. Those sort
    // differently character by character, and under a non-UTC session timezone
    // they do not sort by time at all, so a contact who went silent for a month
    // could be read as messaged yesterday.
    const sentAt = new Date(lastSent.sent_at).getTime();
    if (!Number.isFinite(sentAt) || sentAt > cutoff) continue;

    // Don't stack follow-up drafts if one is already waiting for approval.
    const { count } = await db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("contact_id", row.id)
      .eq("type", "follow_up")
      .is("sent_at", null);

    if ((count ?? 0) > 0) continue;

    // Idempotent: for a contact already in `Follow_Up_Required` this writes the
    // value it already holds. It still has to run, because the returned row is
    // what the caller drafts from — and a contact who was moved here by an
    // earlier sweep that then failed to draft is exactly who this is for.
    const { data: updated } = await db
      .from("contacts")
      .update({ status: "Follow_Up_Required" })
      .eq("id", row.id)
      .select()
      .single();

    if (updated) stale.push({ contact: updated as Contact, type: "follow_up" });
  }

  return stale;
}
