import type {
  CaptureContactRequest,
  CaptureContactResponse,
  Contact,
  CreateJobRequest,
  DraftRequest,
  DraftResponse,
  EnrichContactRequest,
  Job,
  Message,
  MessageType,
  Resume,
  SyncObservationsRequest,
  SyncObservationsResponse,
  UploadResumeRequest,
  UploadResumeResponse,
} from "@crm/shared";
import { getSettings, isConfigured } from "./settings";

/**
 * Typed client for the proxy server.
 *
 * Only the background service worker should call this. Content scripts run in
 * the page's origin, so their requests would be subject to LinkedIn's CORS
 * policy and would leak the auth token into page context; they go through
 * runtime messaging instead (see lib/messaging.ts).
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail?: string,
  ) {
    super(message);
  }
}

/**
 * Every request is bounded.
 *
 * `fetch` has no timeout of its own, and the two callers here are both places
 * where hanging is invisible: the side panel shows a button stuck on "Drafting…"
 * forever, and the background alarm leaves a promise pending until MV3 kills the
 * worker mid-flight — which loses the sweep with no error recorded anywhere.
 *
 * The default is generous because the proxy talks to Supabase and OpenAI on the
 * user's behalf; the two routes that run a whole agent loop or push a PDF
 * through server-side extraction get their own, longer budget.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 120_000;

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const settings = await getSettings();
  if (!isConfigured(settings)) {
    throw new ApiError("Extension is not configured. Open the side panel settings.", 0);
  }

  let res: Response;
  try {
    res = await fetch(`${settings.apiBaseUrl}/api${path}`, {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
        "x-crm-token": settings.authToken,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout and a refused connection both arrive here as a bare TypeError
    // or DOMException, whose messages ("Failed to fetch") say nothing the user
    // can act on. Name the two cases apart.
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiError(`The server did not respond in time (${path}).`, 0);
    }
    throw new ApiError(
      `Could not reach the server at ${settings.apiBaseUrl}. Is it running?`,
      0,
    );
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.detail);
  }

  return (await res.json()) as T;
}

export const api = {
  listJobs: () => request<{ jobs: Job[] }>("/jobs").then((r) => r.jobs),

  createJob: (body: CreateJobRequest) =>
    request<{ job: Job }>("/jobs", { method: "POST", body }).then((r) => r.job),

  updateJob: (id: string, body: { status?: Job["status"] }) =>
    request<{ job: Job }>(`/jobs/${id}`, { method: "PATCH", body }).then((r) => r.job),

  uploadResume: (body: UploadResumeRequest) =>
    request<UploadResumeResponse>("/resumes", {
      method: "POST",
      body,
      // PDF extraction, chunking and an embedding call, all server-side.
      timeoutMs: LONG_TIMEOUT_MS,
    }),

  listResumes: () => request<{ resumes: Resume[] }>("/resumes").then((r) => r.resumes),

  resumeDownloadUrl: (id: string) =>
    request<{ url: string; fileName: string }>(`/resumes/${id}/download`),

  listContacts: () => request<{ contacts: Contact[] }>("/contacts").then((r) => r.contacts),

  captureContact: (body: CaptureContactRequest) =>
    request<CaptureContactResponse>("/contacts/capture", { method: "POST", body }),

  enrichContact: (body: EnrichContactRequest) =>
    request<{ contact: Contact | null; updated: boolean }>("/contacts/enrich", {
      method: "POST",
      body,
    }),

  updateContact: (id: string, body: { jobId?: string | null; status?: Contact["status"] }) =>
    request<{ contact: Contact }>(`/contacts/${id}`, { method: "PATCH", body }).then(
      (r) => r.contact,
    ),

  listMessages: (pendingOnly = false) =>
    request<{ messages: Message[] }>(`/messages${pendingOnly ? "?pending=true" : ""}`).then(
      (r) => r.messages,
    ),

  draft: (body: DraftRequest) =>
    request<DraftResponse>("/drafts", {
      method: "POST",
      body,
      // A full ReAct loop plus critique, repair and shorten passes. Routinely
      // 10-30s; the budget is for the pathological run, not the normal one.
      timeoutMs: LONG_TIMEOUT_MS,
    }),

  markSent: (id: string, sentText: string) =>
    request<{ message: Message }>(`/messages/${id}/sent`, {
      method: "POST",
      body: { sentText },
    }).then((r) => r.message),

  discardDraft: (id: string) =>
    request<{ discarded: boolean }>(`/messages/${id}`, { method: "DELETE" }),

  watchlist: (limit: number) =>
    request<{
      contacts: Array<{
        id: string;
        name: string;
        linkedin_url: string;
        status: Contact["status"];
        last_checked_at: string | null;
      }>;
    }>(`/sync/watchlist?limit=${limit}`).then((r) => r.contacts),

  /**
   * `followUpDays` is attached here rather than by the caller. There are three
   * call sites (the alarm sweep, OBSERVE_ACCEPTED and OBSERVE_REPLY), all of
   * which trigger the server's stale-contact sweep, and a caller that forgot to
   * pass it would silently fall back to the default while the side panel
   * displayed the user's own number — which is the exact mismatch this replaced.
   */
  syncObservations: async (
    body: Omit<SyncObservationsRequest, "followUpDays">,
  ): Promise<SyncObservationsResponse> => {
    const { followUpDays } = await getSettings();
    return request<SyncObservationsResponse>("/sync/observations", {
      method: "POST",
      body: { ...body, followUpDays },
    });
  },
};

export type { MessageType };
