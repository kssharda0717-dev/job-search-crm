import { useCallback, useEffect, useState } from "react";
import type { Contact, Job, Message, PendingApplication, Resume } from "@crm/shared";
import { DEFAULT_FOLLOW_UP_DAYS } from "@crm/shared/constants";
import { api } from "../lib/api";
import { type ListPendingResult, sendToBackground } from "../lib/messaging";
import { getSettings } from "../lib/settings";

export interface CrmData {
  jobs: Job[];
  contacts: Contact[];
  messages: Message[];
  resumes: Resume[];
}

const EMPTY: CrmData = { jobs: [], contacts: [], messages: [], resumes: [] };

/**
 * Loads the full CRM dataset and refreshes when the background worker signals a
 * change. The dataset is small (hundreds of rows at most for one job search),
 * so refetching everything is simpler and less bug-prone than cache patching.
 */
export function useCrmData() {
  const [data, setData] = useState<CrmData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [jobs, contacts, messages, resumes] = await Promise.all([
        api.listJobs(),
        api.listContacts(),
        api.listMessages(),
        api.listResumes(),
      ]);
      setData({ jobs, contacts, messages, resumes });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();

    // Reading the database is not the same as going and looking at LinkedIn.
    // Acceptances only exist in the CRM once a sweep has found them, so a user
    // who gets LinkedIn's "X accepted your invitation" notification, opens the
    // panel and sees nothing was being told the truth about the database and
    // nothing about reality — the only way to make it move was "Check now".
    // This asks the worker to look; the worker throttles and broadcasts
    // DATA_CHANGED if anything changed, so there is nothing to await here.
    const look = () => void sendToBackground({ kind: "PANEL_OPENED" });
    look();

    // The side panel is not unmounted when it loses focus, so mount alone
    // misses "left it open yesterday, came back this morning".
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void refresh();
        look();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    const listener = (message: { kind?: string }) => {
      if (message?.kind === "DATA_CHANGED" || message?.kind === "DRAFT_READY") {
        void refresh();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [refresh]);

  return { data, loading, error, refresh };
}

/**
 * Handshakes awaiting confirmation. These live in chrome.storage.local rather
 * than the database — the application is not real until the user says it is —
 * so they are fetched from the worker instead of the API.
 */
export function usePendingApplications() {
  const [pending, setPending] = useState<PendingApplication[]>([]);

  const refresh = useCallback(async () => {
    const res = await sendToBackground<ListPendingResult>({ kind: "LIST_PENDING" });
    setPending(res.ok ? res.data.pending : []);
  }, []);

  useEffect(() => {
    void refresh();

    const listener = (message: { kind?: string }) => {
      if (message?.kind === "DATA_CHANGED") void refresh();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [refresh]);

  return { pending, refresh };
}

/**
 * The user's follow-up window, for the sentences that promise when the system
 * will act.
 *
 * The panel used to render `DEFAULT_FOLLOW_UP_DAYS` directly, so a user who
 * changed the setting was still told "a follow-up will be drafted in 5 days".
 * Every string that states a deadline reads it from here; the same number is
 * sent to the server on `syncObservations`, so the promise and the sweep cannot
 * drift apart.
 */
export function useFollowUpDays(): number {
  const [days, setDays] = useState(DEFAULT_FOLLOW_UP_DAYS);

  useEffect(() => {
    void getSettings().then((s) => setDays(s.followUpDays));
  }, []);

  return days;
}

/** Wraps an async action with pending/error state for button handlers. */
export function useAction() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (key: string, fn: () => Promise<void>) => {
    setPending(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }, []);

  return { pending, error, run };
}
