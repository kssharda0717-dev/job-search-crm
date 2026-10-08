import type { MessageType } from "@crm/shared";
import {
  MAX_CONTACTS_PER_SWEEP,
  isQuietHours,
  nextPollDelayMinutes,
} from "@crm/shared/constants";
import { api } from "../lib/api";
import { getSettings } from "../lib/settings";
import { broadcastToPanel } from "../lib/messaging";
import { type SentInvitation, scanNetwork } from "./network-scan";

/**
 * Feature 5: connection polling.
 *
 * Anti-ban posture (PRD section 6): no private APIs, DOM reads only, jittered
 * 30-90 minute intervals, and a full stop during quiet hours. A sweep reads two
 * of the user's own network pages and nobody else's, so it is invisible to the
 * people being tracked and costs the same whether they have three pending
 * invitations or three hundred.
 */

export const ALARM_NAME = "crm-poll";

export async function scheduleNextSweep(): Promise<void> {
  const delay = nextPollDelayMinutes();
  await chrome.alarms.create(ALARM_NAME, { delayInMinutes: delay });
  console.info(`[crm] next sweep in ~${delay}m`);
}

/**
 * Arm the alarm only if nothing is already armed.
 *
 * `onInstalled` fires on every reload from chrome://extensions, and creating
 * the alarm there unconditionally pushed the next sweep another 30-90 minutes
 * out each time. During a working session that alarm never fires at all, which
 * looks exactly like polling being broken.
 */
export async function ensureSweepScheduled(): Promise<void> {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (existing) return;
  await scheduleNextSweep();
}

export interface SweepResult {
  checked: number;
  updated: number;
  /** Set when the sweep could not read LinkedIn at all. */
  problem?: string;
}

const PANEL_SWEEP_KEY = "lastPanelSweepAt";

/**
 * How stale the data may be when the user opens the panel before it is worth
 * going and looking at LinkedIn again.
 *
 * Opening the panel is an attended, human action — the user has just been told
 * by LinkedIn that someone accepted, and the first thing they do is come here.
 * Until now the panel only ever re-read the database on open, and the database
 * knows nothing until a sweep runs, so the honest answer to "why is this
 * empty?" was "because nothing has looked yet" — which is invisible, and reads
 * as the extension being broken.
 *
 * Throttled rather than unconditional, because the panel remounts on every
 * open. Ten minutes caps this at six reads an hour even if the user opens the
 * panel constantly, which is strictly more conservative than the "Check now"
 * button they already have and can press without limit.
 */
const PANEL_SWEEP_THROTTLE_MS = 10 * 60 * 1000;

/**
 * A sweep triggered by the user opening the side panel.
 *
 * Quiet hours are honoured (unlike "Check now"): opening the panel is a weaker
 * signal of intent than pressing a button that says "check now", and the
 * anti-ban posture in PRD section 6 is the thing this system cannot afford to
 * get wrong.
 */
export async function sweepOnPanelOpen(): Promise<SweepResult> {
  const settings = await getSettings();
  if (!settings.pollingEnabled) return { checked: 0, updated: 0 };
  if (isQuietHours()) return { checked: 0, updated: 0 };

  const stored = await chrome.storage.local.get(PANEL_SWEEP_KEY);
  const last = (stored[PANEL_SWEEP_KEY] as number | undefined) ?? 0;
  if (Date.now() - last < PANEL_SWEEP_THROTTLE_MS) return { checked: 0, updated: 0 };

  // Written before the sweep, not after: a sweep that throws must still count
  // against the throttle, or a persistently failing LinkedIn read turns every
  // panel open into another attempt.
  await chrome.storage.local.set({ [PANEL_SWEEP_KEY]: Date.now() });

  // `force` here means "do not touch the alarm", which is the half of it that
  // matters: the panel remounts on every open, and re-arming from here would
  // push the unattended background sweep another 30-90 minutes out each time —
  // the same defect `ensureSweepScheduled` was written to fix. The quiet-hours
  // and polling-enabled checks that `force` also skips are done above instead,
  // so the anti-ban posture is unchanged.
  return runSweep({ force: true });
}

/**
 * @param force  Set by the side panel's "Check now". A user sitting in front of
 *   the panel asking for an update is a human action, so it runs during quiet
 *   hours and leaves the alarm schedule alone.
 */
export async function runSweep(options: { force?: boolean } = {}): Promise<SweepResult> {
  const settings = await getSettings();

  // Re-arm before any early return, or a single skipped sweep stops the engine.
  if (!options.force) await scheduleNextSweep();

  if (!settings.authToken) return { checked: 0, updated: 0, problem: "Not configured yet." };
  if (!options.force) {
    if (!settings.pollingEnabled) return { checked: 0, updated: 0 };
    if (isQuietHours()) {
      console.info("[crm] quiet hours, skipping sweep");
      return { checked: 0, updated: 0 };
    }
  }

  let watchlist: Awaited<ReturnType<typeof api.watchlist>>;
  try {
    watchlist = await api.watchlist(MAX_CONTACTS_PER_SWEEP);
  } catch (err) {
    console.warn("[crm] could not load watchlist:", err);
    return { checked: 0, updated: 0, problem: "Could not reach the CRM server." };
  }

  const pending = watchlist.filter((contact) => contact.status === "Pending");

  // The scan runs even with nothing pending: its other job is to find people
  // the user invited whom we never recorded at all.
  const snapshot = await scanNetwork();
  if (!snapshot.readable) {
    return {
      checked: 0,
      updated: 0,
      problem: "Could not read LinkedIn. Make sure you are signed in.",
    };
  }

  console.info(
    `[crm] scan: ${snapshot.sent.length} sent invitation(s), ` +
      `${snapshot.stillPending.size} pending row(s), ` +
      `${snapshot.connections.size} connection(s)`,
  );

  const added = await captureMissedInvitations(snapshot.sent);
  if (added > 0) broadcastToPanel({ kind: "DATA_CHANGED" });

  const observations = pending
    .map((contact) => ({
      linkedinUrl: contact.linkedin_url,
      accepted: snapshot.connections.has(normalize(contact.linkedin_url)),
    }))
    // An invitation that is neither still pending nor connected was withdrawn,
    // ignored or expired. Reporting `accepted: false` would be the same signal
    // as "still waiting", so say nothing and leave the contact where it is.
    .filter(
      (observation) =>
        observation.accepted || snapshot.stillPending.has(normalize(observation.linkedinUrl)),
    );

  // Deliberately NOT short-circuited on an empty list. The server runs the
  // stale-contact sweep — the thing that turns an accepted contact with no
  // reply after N days into Follow_Up_Required and drafts the follow-up —
  // inside syncObservations, and every caller used to return early when there
  // was nothing pending to report. That meant the follow-up engine switched
  // itself off the moment every invitation had been accepted, which is what
  // success looks like. An empty `observations` array is valid input.
  try {
    const result = await api.syncObservations({ observations });
    if (result.needsDraft.length > 0) {
      await draftFor(result.needsDraft);
      await notifyDraftsNeeded(result.needsDraft.length);
    }
    // `updated` counts observed transitions only; the stale sweep's
    // Accepted → Follow_Up_Required moves show up in `needsDraft` alone, and
    // the panel has to redraw for those too.
    if (result.updated > 0 || result.needsDraft.length > 0) {
      broadcastToPanel({ kind: "DATA_CHANGED" });
    }
    return { checked: pending.length, updated: result.updated };
  } catch (err) {
    console.warn("[crm] observation sync failed:", err);
    return { checked: pending.length, updated: 0, problem: "Could not save what was found." };
  }
}

/**
 * First run can face a long history of invitations. Trickling them in over a
 * few sweeps keeps the CRM from filling up in one go with people the user sent
 * requests to months ago and has forgotten about.
 */
const MAX_NEW_CONTACTS_PER_SWEEP = 20;

/**
 * Record people the user invited but the extension never captured.
 *
 * Capture has depended entirely on intercepting one click on markup LinkedIn
 * controls, which has failed twice in practice — silently, which is the worst
 * way for it to fail. The Sent invitations page is the user's own record of
 * who they meant to add, so anything on it that is not already a contact is a
 * miss, and this repairs it without the user doing anything.
 *
 * Company is left null on purpose: the server derives the employer from the
 * headline and fuzzy-matches it against tracked applications, which is the same
 * path a click-captured contact takes.
 */
async function captureMissedInvitations(sent: SentInvitation[]): Promise<number> {
  if (sent.length === 0) return 0;

  let known: Set<string>;
  try {
    known = new Set((await api.listContacts()).map((contact) => contact.linkedin_url));
  } catch (err) {
    console.warn("[crm] could not load contacts to reconcile invitations:", err);
    return 0;
  }

  const missed = sent
    .filter((person) => !known.has(person.linkedinUrl))
    .slice(0, MAX_NEW_CONTACTS_PER_SWEEP);

  let added = 0;
  for (const person of missed) {
    try {
      await api.captureContact({
        name: person.name,
        linkedinUrl: person.linkedinUrl,
        headline: person.headline,
        company: null,
      });
      added++;
    } catch (err) {
      // One unparseable row must not abandon the rest of the list.
      console.warn(`[crm] could not record ${person.name}:`, err);
    }
  }

  if (added > 0) console.info(`[crm] recovered ${added} contact(s) from sent invitations`);
  return added;
}

/** Contacts are stored canonically, but be defensive about trailing slashes. */
function normalize(url: string): string {
  const slug = url.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1];
  return slug ? `https://www.linkedin.com/in/${slug}/` : url;
}

/**
 * Write the drafts an acceptance calls for.
 *
 * The state transition alone was never enough: the PRD's promise is that a
 * message is waiting when a connection is accepted, and leaving the user to
 * press "Draft outreach" means noticing the acceptance first — the exact thing
 * they cannot do. Generating here still never sends anything; the draft waits
 * for approval in the panel.
 */
export async function draftFor(
  needsDraft: Array<{ contact: { id: string }; type: MessageType }>,
): Promise<void> {
  for (const { contact, type } of needsDraft) {
    try {
      await api.draft({ contactId: contact.id, type });
    } catch (err) {
      // A drafting failure must not cost us the status change we just recorded.
      console.warn(`[crm] could not draft for ${contact.id}:`, err);
    }
  }
}

async function notifyDraftsNeeded(count: number): Promise<void> {
  // Badge only. Drafts still require explicit user approval, so an interrupting
  // notification would be noise.
  await chrome.action.setBadgeText({ text: String(count) });
  await chrome.action.setBadgeBackgroundColor({ color: "#0a66c2" });
}
