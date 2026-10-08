import type {
  CaptureContactRequest,
  CaptureContactResponse,
  CreateJobRequest,
  DraftResponse,
  EnrichContactRequest,
  Job,
  MessageType,
  PendingApplication,
} from "@crm/shared";

/**
 * Content scripts cannot reach the proxy directly (page-origin CORS, and the
 * auth token must not enter page context), so every privileged action is a
 * message to the background worker. This union is the whole surface.
 */
export type BgRequest =
  | { kind: "TRACK_APPLICATION"; payload: CreateJobRequest }
  | { kind: "COMMIT_HANDSHAKE"; payload: { url: string; vendor: string } }
  | { kind: "LIST_PENDING" }
  | { kind: "CONFIRM_PENDING"; payload: { handshakeId: string } }
  | { kind: "DISCARD_PENDING"; payload: { handshakeId: string } }
  | { kind: "STASH_RESUME"; payload: { fileName: string; fileBase64: string } }
  | { kind: "HAS_OPEN_HANDSHAKE" }
  | { kind: "RUN_SWEEP" }
  | { kind: "PANEL_OPENED" }
  | { kind: "OBSERVE_ACCEPTED"; payload: { linkedinUrls: string[] } }
  | { kind: "CAPTURE_CONTACT"; payload: CaptureContactRequest }
  | { kind: "ENRICH_CONTACT"; payload: EnrichContactRequest }
  | { kind: "LINK_CONTACT"; payload: { contactId: string; jobId: string } }
  | { kind: "REQUEST_DRAFT"; payload: { contactId: string; type: MessageType } }
  | { kind: "LOOKUP_CONTACT_BY_URL"; payload: { linkedinUrl: string } }
  | { kind: "MARK_SENT"; payload: { messageId: string; sentText: string } }
  | { kind: "OBSERVE_REPLY"; payload: { linkedinUrl: string } };

export type BgResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** Everything needed to open a handshake, scraped from the LinkedIn JD panel. */
export type HandshakeSeed = Omit<
  PendingApplication,
  "handshakeId" | "tabId" | "createdAt"
>;

/**
 * Messages the background sends *into* a content script — the opposite
 * direction from BgRequest. Only the LinkedIn jobs script answers these.
 */
export type CsRequest = { kind: "SCRAPE_JOB" };

export interface ScrapeJobResult {
  job: HandshakeSeed | null;
}

export interface TrackApplicationResult {
  job: Job;
}
export interface ListPendingResult {
  pending: PendingApplication[];
}
export interface CommitHandshakeResult {
  job: Job | null;
  /** False when no pending handshake matched this tab; not an error. */
  committed: boolean;
}

export interface StashResumeResult {
  /**
   * True when the application was already tracked and the resume went straight
   * to the vault; false when it is held until the application is confirmed.
   */
  uploaded: boolean;
}

export interface HasOpenHandshakeResult {
  open: boolean;
}

export interface RunSweepResult {
  checked: number;
  updated: number;
  /**
   * Why the sweep learned nothing — a signed-out LinkedIn, an unreachable
   * server. Without this the panel reports "no change yet" for a sweep that
   * never actually looked, which is indistinguishable from a real result.
   */
  problem?: string;
}

/** Type-safe wrapper over chrome.runtime.sendMessage. */
export async function sendToBackground<T = unknown>(
  message: BgRequest,
): Promise<BgResponse<T>> {
  try {
    return (await chrome.runtime.sendMessage(message)) as BgResponse<T>;
  } catch (err) {
    // Fires when the worker is mid-restart; the caller decides whether to retry.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Messages the background pushes to the side panel. */
export type PanelEvent =
  | { kind: "DATA_CHANGED" }
  | { kind: "DRAFT_READY"; draft: DraftResponse }
  | { kind: "CONTACT_AMBIGUOUS"; response: CaptureContactResponse };

export function broadcastToPanel(event: PanelEvent): void {
  // No receiver when the panel is closed; that is expected, so swallow it.
  chrome.runtime.sendMessage(event).catch(() => {});
}
