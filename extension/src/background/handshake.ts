import type { PendingApplication } from "@crm/shared";
import { HANDSHAKE_TTL_MS } from "@crm/shared/constants";

/**
 * Feature 1, external ATS flow.
 *
 * When the user leaves LinkedIn for a company's own ATS, the JD they were
 * looking at exists only in that LinkedIn tab's DOM. We stash it here, keyed by
 * the tab that gets opened, and commit it once the ATS confirms a submission.
 *
 * chrome.storage.local rather than an in-memory map: MV3 terminates the service
 * worker after ~30s idle, and the user may take several minutes to fill out a
 * Workday form. An in-memory map would be empty by the time they finish.
 */

const KEY = "pendingApplications";

type PendingMap = Record<string, PendingApplication>;

async function readAll(): Promise<PendingMap> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as PendingMap | undefined) ?? {};
}

async function writeAll(map: PendingMap): Promise<void> {
  await chrome.storage.local.set({ [KEY]: map });
}

/** Drop handshakes the user evidently abandoned. */
function prune(map: PendingMap): PendingMap {
  const cutoff = Date.now() - HANDSHAKE_TTL_MS;
  return Object.fromEntries(
    Object.entries(map).filter(([, value]) => value.createdAt >= cutoff),
  );
}

export async function beginHandshake(
  data: Omit<PendingApplication, "handshakeId" | "tabId" | "createdAt">,
  tabId: number | null,
): Promise<PendingApplication> {
  const pending: PendingApplication = {
    ...data,
    handshakeId: crypto.randomUUID(),
    tabId,
    createdAt: Date.now(),
  };

  const map = prune(await readAll());
  map[pending.handshakeId] = pending;
  await writeAll(map);
  return pending;
}

/**
 * How recent a handshake must be to be committed by a tab that is not the one
 * it was opened against.
 *
 * The cross-tab fallback exists for Workday's "Apply with Workday", which opens
 * a further tab mid-flow — a matter of seconds. The full `HANDSHAKE_TTL_MS` is
 * for the side panel's pending list, where the user picks the application
 * explicitly, and applying it to an automatic commit was the wrong reading of
 * the same number: on 2026-10-01 an application submitted on one site was
 * recorded as a Trellis Digital posting the user had merely browsed and opened an
 * apply tab for earlier, because that abandoned handshake was simply the most
 * recent one in storage. There was no second row — the requisition id matched,
 * so `POST /jobs` updated the wrong one and the real application was lost.
 */
const CROSS_TAB_FALLBACK_MS = 10 * 60 * 1000;

/**
 * Find the handshake belonging to a submitting tab.
 *
 * Prefers an exact tab match, and only falls back to another tab's handshake
 * when it is recent *and* unambiguous. Two open handshakes mean we cannot tell
 * which posting this page belongs to, and guessing is worse than not recording:
 * a wrong guess silently files the application under someone else's job, where
 * the user has no reason to look for it.
 */
export async function resolveHandshake(
  tabId: number | undefined,
): Promise<PendingApplication | null> {
  const map = prune(await readAll());
  const entries = Object.values(map);
  if (entries.length === 0) return null;

  const exact = entries.find((entry) => entry.tabId !== null && entry.tabId === tabId);
  if (exact) return exact;

  const recent = entries.filter((entry) => Date.now() - entry.createdAt <= CROSS_TAB_FALLBACK_MS);
  return recent.length === 1 ? recent[0]! : null;
}

export async function clearHandshake(handshakeId: string): Promise<void> {
  const map = prune(await readAll());
  delete map[handshakeId];
  await writeAll(map);
}

export async function listPending(): Promise<PendingApplication[]> {
  return Object.values(prune(await readAll())).sort((a, b) => b.createdAt - a.createdAt);
}

/** Look up one handshake by id, or null if it has expired or been committed. */
export async function findPending(handshakeId: string): Promise<PendingApplication | null> {
  return prune(await readAll())[handshakeId] ?? null;
}
