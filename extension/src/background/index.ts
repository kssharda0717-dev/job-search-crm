import type { CreateJobRequest, Job, PendingApplication } from "@crm/shared";
import { MAX_CONTACTS_PER_SWEEP } from "@crm/shared/constants";
import { ApiError, api } from "../lib/api";
import {
  type BgRequest,
  type BgResponse,
  type CsRequest,
  type HasOpenHandshakeResult,
  type RunSweepResult,
  type ScrapeJobResult,
  type StashResumeResult,
  broadcastToPanel,
} from "../lib/messaging";
import { getSettings } from "../lib/settings";
import {
  beginHandshake,
  clearHandshake,
  findPending,
  listPending,
  resolveHandshake,
} from "./handshake";
import {
  ALARM_NAME,
  draftFor,
  ensureSweepScheduled,
  runSweep,
  sweepOnPanelOpen,
} from "./poller";
import {
  claimResume,
  forgetTab,
  jobForTab,
  markResumeDelivered,
  rememberJobForTab,
  returnResume,
  stashResume,
} from "./resume-stash";

/**
 * Background service worker: the only context that holds the auth token and
 * talks to the proxy. Content scripts request everything through messages.
 */

chrome.runtime.onInstalled.addListener(() => {
  void ensureSweepScheduled();
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  void ensureSweepScheduled();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void runSweep();
});

chrome.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId));

const LINKEDIN_JOB_URL = /^https:\/\/www\.linkedin\.com\/jobs\//;

/**
 * Open a handshake when the user leaves a LinkedIn job page for a company's own
 * ATS.
 *
 * This is driven from the worker rather than from a click listener in the page
 * because LinkedIn's apply button has no stable id, class or label across their
 * UI variants — matching it wrongly fails silently, which is indistinguishable
 * from the extension being broken. "A new tab was opened from a LinkedIn job
 * page" is a far more durable signal, and it is the event we already depended
 * on to bind the handshake to the ATS tab.
 */
chrome.tabs.onCreated.addListener((tab) => {
  const openerId = tab.openerTabId;
  if (tab.id === undefined || openerId === undefined) return;

  // Opening a LinkedIn link in a new tab is not an application. The URL is
  // usually still pending at creation time, hence pendingUrl.
  const destination = tab.pendingUrl ?? tab.url ?? "";
  if (destination.includes("linkedin.com")) return;

  void startHandshakeFromOpener(openerId, tab.id);
});

async function startHandshakeFromOpener(openerId: number, atsTabId: number): Promise<void> {
  const opener = await chrome.tabs.get(openerId).catch(() => null);
  if (!opener?.url || !LINKEDIN_JOB_URL.test(opener.url)) return;

  // The JD lives only in that tab's DOM, so ask it before the user navigates.
  const res = (await chrome.tabs
    .sendMessage(openerId, { kind: "SCRAPE_JOB" } satisfies CsRequest)
    .catch((err: unknown) => {
      // Almost always "Receiving end does not exist": the content script is not
      // in that tab, usually because it was open before the extension loaded.
      console.warn("[crm] LinkedIn tab did not answer SCRAPE_JOB — reload it:", err);
      return null;
    })) as BgResponse<ScrapeJobResult> | null;

  if (!res) return;

  if (!res.ok || !res.data.job) {
    console.warn("[crm] LinkedIn tab answered but could not scrape the job (selectors stale?)");
    return;
  }

  const pending = await beginHandshake(res.data.job, atsTabId);
  console.info(`[crm] handshake started: ${pending.title} -> tab ${atsTabId}`);
  broadcastToPanel({ kind: "DATA_CHANGED" });
}

chrome.runtime.onMessage.addListener((message: BgRequest, sender, sendResponse) => {
  // Panel events are broadcast on the same channel; ignore anything unrecognised.
  if (!message || typeof message.kind !== "string") return false;

  handle(message, sender)
    .then((data) => sendResponse({ ok: true, data } satisfies BgResponse))
    .catch((err: unknown) => {
      console.error(`[crm] ${message.kind} failed:`, err);
      sendResponse({ ok: false, error: describe(err) } satisfies BgResponse);
    });

  // Keeps the message channel open for the async response above.
  return true;
});

/**
 * The proxy's top-level `error` is often just "Internal error"; the cause it
 * actually reports lives in `detail`. Dropping it leaves the user staring at a
 * message that says nothing about what went wrong.
 */
function describe(err: unknown): string {
  if (err instanceof ApiError && err.detail) return `${err.message}: ${err.detail}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turn a pending handshake into a tracked application. Shared by the automatic
 * ATS path and the side panel's manual confirmation so both produce an
 * identical record.
 */
async function commitPending(
  pending: PendingApplication,
  url: string | null,
  tabId: number | undefined,
): Promise<Job> {
  const payload: CreateJobRequest = {
    company: pending.company,
    title: pending.title,
    url,
    location: pending.location,
    jdText: pending.jdText,
    source: "external_ats",
    externalJobId: pending.externalJobId,
    status: "Applied",
    appliedAt: new Date().toISOString(),
  };

  const job = await api.createJob(payload);
  await clearHandshake(pending.handshakeId);
  // The side panel has no tab of its own, so fall back to the tab the handshake
  // was opened against — otherwise confirming manually never finds the resume.
  await onJobTracked(job, tabId ?? pending.tabId ?? undefined);
  return job;
}

/**
 * Everything that must happen once an application becomes real: bind it to the
 * tab for later uploads, deliver any resume already waiting, and refresh the
 * panel.
 */
async function onJobTracked(job: Job, tabId: number | undefined): Promise<void> {
  await rememberJobForTab(tabId, job.id);
  await deliverResume(job.id, tabId);
  broadcastToPanel({ kind: "DATA_CHANGED" });
}

/**
 * Move a stashed resume into the vault. Never throws: the application is
 * already tracked by this point, and losing that to a resume failure would be a
 * far worse outcome than a resume the user can re-attach.
 */
async function deliverResume(jobId: string, tabId: number | undefined): Promise<boolean> {
  const stashed = await claimResume(tabId);
  if (!stashed) return false;

  try {
    const { userName } = await getSettings();
    await api.uploadResume({
      jobId,
      fileName: stashed.fileName,
      fileBase64: stashed.fileBase64,
      userName: userName || null,
    });
    await markResumeDelivered(jobId, stashed.fileName);
    return true;
  } catch (err) {
    // Includes the 409 the proxy returns when this application already holds a
    // resume. Putting it back is the point: the upload was misrouted, and the
    // job it belongs to is usually tracked seconds later and claims it.
    console.warn("[crm] resume upload failed, keeping it stashed:", err);
    await returnResume(tabId, stashed);
    return false;
  }
}

async function handle(
  message: BgRequest,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  const tabId = sender.tab?.id;

  switch (message.kind) {
    // --- Feature 1: LinkedIn Easy Apply --------------------------------------
    case "TRACK_APPLICATION": {
      const job = await api.createJob(message.payload);
      await onJobTracked(job, tabId);
      return { job };
    }

    // --- Feature 1: external ATS handshake -----------------------------------
    case "COMMIT_HANDSHAKE": {
      const pending = await resolveHandshake(tabId);
      if (!pending) return { job: null, committed: false };

      const job = await commitPending(pending, message.payload.url, tabId);
      return { job, committed: true } satisfies { job: Job; committed: boolean };
    }

    // Manual confirmation from the side panel. Only the supported ATSs can
    // detect a submit on their own; every other career site relies on this.
    case "LIST_PENDING":
      return { pending: await listPending() };

    case "CONFIRM_PENDING": {
      const pending = await findPending(message.payload.handshakeId);
      if (!pending) throw new Error("That pending application has expired");
      return { job: await commitPending(pending, pending.linkedinUrl, tabId) };
    }

    case "DISCARD_PENDING": {
      await clearHandshake(message.payload.handshakeId);
      broadcastToPanel({ kind: "DATA_CHANGED" });
      return { discarded: true };
    }

    /**
     * Asked by the universal apply watcher before it arms itself. An open
     * handshake means the user reached this page from a LinkedIn job posting,
     * which is reason enough to watch it whatever site it turns out to be.
     */
    case "HAS_OPEN_HANDSHAKE":
      return { open: (await resolveHandshake(tabId)) !== null } satisfies HasOpenHandshakeResult;

    // --- Feature 2: Document Vault -------------------------------------------
    case "STASH_RESUME": {
      await stashResume(tabId, message.payload);

      // Usually the resume arrives first and waits for the submission. When the
      // order is reversed — a confirmation page that asks for the file, or the
      // user re-attaching afterwards — upload it straight away.
      const jobId = await jobForTab(tabId, message.payload.fileName);
      const uploaded = jobId ? await deliverResume(jobId, tabId) : false;
      if (uploaded) broadcastToPanel({ kind: "DATA_CHANGED" });
      return { uploaded } satisfies StashResumeResult;
    }

    // --- Feature 3: entity mapping -------------------------------------------
    case "CAPTURE_CONTACT": {
      const result = await api.captureContact(message.payload);
      broadcastToPanel({ kind: "DATA_CHANGED" });
      return result;
    }

    case "ENRICH_CONTACT": {
      const result = await api.enrichContact(message.payload);
      // Only when something actually changed: this fires on every profile page
      // the user opens, and most of those are strangers or already complete.
      if (result.updated) broadcastToPanel({ kind: "DATA_CHANGED" });
      return result;
    }

    case "LINK_CONTACT": {
      const contact = await api.updateContact(message.payload.contactId, {
        jobId: message.payload.jobId,
      });
      broadcastToPanel({ kind: "DATA_CHANGED" });
      return { contact };
    }

    // --- Feature 4: drafting --------------------------------------------------
    case "REQUEST_DRAFT": {
      const draft = await api.draft({
        contactId: message.payload.contactId,
        type: message.payload.type,
      });
      broadcastToPanel({ kind: "DRAFT_READY", draft });
      return draft;
    }

    case "LOOKUP_CONTACT_BY_URL": {
      const contacts = await api.listContacts();
      const contact =
        contacts.find((c) => c.linkedin_url === message.payload.linkedinUrl) ?? null;
      return { contact };
    }

    case "MARK_SENT": {
      const sent = await api.markSent(message.payload.messageId, message.payload.sentText);
      await chrome.action.setBadgeText({ text: "" });
      broadcastToPanel({ kind: "DATA_CHANGED" });
      return { message: sent };
    }

    // --- Feature 5: connection and reply detection ----------------------------

    /**
     * Evidence of acceptance that the user's own browsing walked into: a
     * tracked profile that now reads 1st-degree, or every name on their
     * Connections page. Identical to what the background sweep collects, but
     * free and immediate — waiting 30-90 minutes for a fact already on screen
     * is what makes the panel feel broken.
     *
     * The watchlist is intersected here rather than in the page, so a 1,400-row
     * Connections list becomes a request about the handful of people actually
     * being tracked.
     */
    case "OBSERVE_ACCEPTED": {
      const seen = new Set(message.payload.linkedinUrls);
      if (seen.size === 0) return { updated: 0, needsDraft: [] };

      const watchlist = await api.watchlist(MAX_CONTACTS_PER_SWEEP);
      const observations = watchlist
        .filter((contact) => contact.status === "Pending" && seen.has(contact.linkedin_url))
        .map((contact) => ({ linkedinUrl: contact.linkedin_url, accepted: true }));

      // Sent even when `observations` is empty: syncObservations also runs the
      // server's stale-contact sweep, which is what produces follow-up drafts
      // after N days of silence. Gating that on having something to report
      // meant it never ran once every invitation had been accepted.
      const result = await api.syncObservations({ observations });
      // `updated` counts only the observed transitions; the stale sweep's
      // Accepted → Follow_Up_Required moves arrive in `needsDraft` alone.
      if (result.needsDraft.length > 0) await draftFor(result.needsDraft);
      if (result.updated > 0 || result.needsDraft.length > 0) {
        broadcastToPanel({ kind: "DATA_CHANGED" });
      }
      return result;
    }

    /** User-initiated "check now", so it ignores the quiet-hours pause. */
    case "RUN_SWEEP":
      return (await runSweep({ force: true })) satisfies RunSweepResult;

    /**
     * The panel was opened or brought back to the foreground. Throttled inside
     * `sweepOnPanelOpen`, and it broadcasts its own DATA_CHANGED, so the panel
     * fires this and forgets it.
     */
    case "PANEL_OPENED":
      return (await sweepOnPanelOpen()) satisfies RunSweepResult;

    case "OBSERVE_REPLY": {
      const result = await api.syncObservations({
        observations: [{ linkedinUrl: message.payload.linkedinUrl, replied: true }],
      });
      if (result.updated > 0) broadcastToPanel({ kind: "DATA_CHANGED" });
      return result;
    }
  }
}
