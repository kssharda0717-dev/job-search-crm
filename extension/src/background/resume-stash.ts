import { HANDSHAKE_TTL_MS } from "@crm/shared/constants";
// The subpath, never the barrel: this module is reachable from the content
// script's message types and the barrel re-exports zod.
import {
  type DeliveryTarget,
  NOTHING_DELIVERED,
  acceptsDelivery,
  documentRank,
} from "@crm/shared/vault";

/**
 * Feature 2, holding area.
 *
 * A tailored resume is only meaningful attached to an application, and the
 * application is not real until a submission is confirmed — which can be
 * minutes later, after several navigations, and sometimes only when the user
 * presses "I applied" in the side panel. So the bytes are parked here between
 * the file picker and the commit.
 *
 * chrome.storage.local rather than a variable in either context: the content
 * script dies on every navigation (the confirmation page is usually a new
 * document), and MV3 kills the service worker after ~30s idle. Both of the
 * obvious places to keep this are empty by the time it is needed, which is
 * exactly the failure this module exists to remove.
 */

const RESUME_KEY = "stashedResumes";
const TAB_JOB_KEY = "tabJobs";
const LAST_JOB_KEY = "lastTrackedJob";

export interface StashedResume {
  fileName: string;
  fileBase64: string;
  createdAt: number;
}

type ResumeMap = Record<string, StashedResume>;
type TabJobMap = Record<string, DeliveryTarget>;

async function read<T>(key: string): Promise<T> {
  const stored = await chrome.storage.local.get(key);
  return (stored[key] as T | undefined) ?? ({} as T);
}

/** Same window as a handshake: past it, the user has evidently moved on. */
function fresh(map: ResumeMap): ResumeMap {
  const cutoff = Date.now() - HANDSHAKE_TTL_MS;
  return Object.fromEntries(
    Object.entries(map).filter(([, value]) => value.createdAt >= cutoff),
  );
}

export async function stashResume(
  tabId: number | undefined,
  resume: Omit<StashedResume, "createdAt">,
): Promise<void> {
  const map = fresh(await read<ResumeMap>(RESUME_KEY));
  const key = String(tabId ?? "unknown");

  const existing = map[key];
  if (existing && documentRank(resume.fileName) < documentRank(existing.fileName)) {
    console.info(
      `[crm] keeping ${existing.fileName} over ${resume.fileName} for the vault`,
    );
    return;
  }

  map[key] = { ...resume, createdAt: Date.now() };
  await chrome.storage.local.set({ [RESUME_KEY]: map });
}

/**
 * Claim the resume belonging to a tab, removing it so it cannot be uploaded
 * twice.
 *
 * Falls back to the most recent stash when the tab does not match. ATS flows
 * routinely move the user between tabs — Workday's "Apply with Workday" opens
 * one, Greenhouse submits from an iframe — and a resume attached two minutes
 * ago is far more likely to belong to the application being committed now than
 * to nothing at all.
 */
export async function claimResume(
  tabId: number | undefined,
): Promise<StashedResume | null> {
  const map = fresh(await read<ResumeMap>(RESUME_KEY));

  let key = tabId === undefined ? undefined : String(tabId);
  if (key === undefined || !map[key]) {
    key = Object.keys(map).reduce<string | undefined>(
      (newest, candidate) =>
        newest === undefined || map[candidate]!.createdAt > map[newest]!.createdAt
          ? candidate
          : newest,
      undefined,
    );
  }

  if (key === undefined) return null;

  const claimed = map[key]!;
  delete map[key];
  await chrome.storage.local.set({ [RESUME_KEY]: map });
  return claimed;
}

/** Put a resume back after a failed upload, so a later commit can retry. */
export async function returnResume(
  tabId: number | undefined,
  resume: StashedResume,
): Promise<void> {
  const map = fresh(await read<ResumeMap>(RESUME_KEY));
  map[String(tabId ?? "unknown")] = resume;
  await chrome.storage.local.set({ [RESUME_KEY]: map });
}

/**
 * The job most recently tracked from a tab, so a resume attached *after* the
 * confirmation page (the user re-uploads, or the ATS asks for it last) still
 * lands on the right application.
 *
 * Also recorded tab-independently. `claimResume` already falls back to the most
 * recent stash when the tab does not match, but the job side had no such
 * fallback, and the asymmetry stranded resumes: press "I applied" in the side
 * panel *before* uploading — which is what a user does when the ATS asks for
 * the file on a later step — and the only remaining delivery trigger is
 * `STASH_RESUME` finding an exact tab match. Workday opening a second tab, a
 * Greenhouse iframe, or simply confirming from the panel with no pending tabId
 * was enough to lose the document with no symptom other than an empty vault.
 */
export async function rememberJobForTab(
  tabId: number | undefined,
  jobId: string,
): Promise<void> {
  const tracked: DeliveryTarget = {
    jobId,
    at: Date.now(),
    deliveredRank: NOTHING_DELIVERED,
  };
  await chrome.storage.local.set({ [LAST_JOB_KEY]: tracked });

  if (tabId === undefined) return;
  const map = await read<TabJobMap>(TAB_JOB_KEY);
  map[String(tabId)] = tracked;
  await chrome.storage.local.set({ [TAB_JOB_KEY]: map });
}

/**
 * The application a file just picked in this tab should be filed against, or
 * null if there isn't one and it should wait in the stash instead.
 *
 * Null is the safe answer and is now returned far more often. A binding used to
 * survive until the tab closed, and the tab-independent fallback for two hours,
 * so the *next* application's CV — picked in the apply form before that
 * application is tracked, which is the normal order — resolved to the
 * *previous* job and was filed there. Waiting in the stash costs nothing: the
 * commit a few seconds later claims it.
 */
export async function jobForTab(
  tabId: number | undefined,
  fileName: string,
): Promise<string | null> {
  const now = Date.now();
  const accepts = (target: DeliveryTarget | undefined): string | null =>
    target && acceptsDelivery(target, fileName, now) ? target.jobId : null;

  if (tabId !== undefined) {
    const mapped = accepts((await read<TabJobMap>(TAB_JOB_KEY))[String(tabId)]);
    if (mapped) return mapped;
  }

  // Tab-independent fallback: pressing "I applied" in the side panel has no tab
  // of its own, and ATS flows move the user between tabs.
  const stored = await chrome.storage.local.get(LAST_JOB_KEY);
  return accepts(stored[LAST_JOB_KEY] as DeliveryTarget | undefined);
}

/**
 * Record that a job now holds a document, so it stops claiming the next one.
 *
 * Called after the upload succeeds rather than before it, so a rejected or
 * failed delivery leaves the job still able to accept one.
 */
export async function markResumeDelivered(jobId: string, fileName: string): Promise<void> {
  const rank = documentRank(fileName);

  const stored = await chrome.storage.local.get(LAST_JOB_KEY);
  const last = stored[LAST_JOB_KEY] as DeliveryTarget | undefined;
  if (last?.jobId === jobId && rank > last.deliveredRank) {
    await chrome.storage.local.set({
      [LAST_JOB_KEY]: { ...last, deliveredRank: rank } satisfies DeliveryTarget,
    });
  }

  const map = await read<TabJobMap>(TAB_JOB_KEY);
  // Every tab bound to this job, not just the one that delivered: a Workday
  // flow spans several, and any of them could otherwise claim the next file.
  let changed = false;
  for (const [key, tracked] of Object.entries(map)) {
    if (tracked.jobId === jobId && rank > tracked.deliveredRank) {
      map[key] = { ...tracked, deliveredRank: rank };
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [TAB_JOB_KEY]: map });
}

export async function forgetTab(tabId: number): Promise<void> {
  const [resumes, jobs] = await Promise.all([
    read<ResumeMap>(RESUME_KEY),
    read<TabJobMap>(TAB_JOB_KEY),
  ]);
  delete jobs[String(tabId)];
  // The resume is deliberately kept: closing the ATS tab right after submitting
  // is normal, and the side panel's "I applied" still needs those bytes.
  await chrome.storage.local.set({ [RESUME_KEY]: fresh(resumes), [TAB_JOB_KEY]: jobs });
}
