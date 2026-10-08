import { MAX_RESUME_BYTES } from "@crm/shared/constants";
import { arrayBufferToBase64 } from "./encoding";
import { type StashResumeResult, sendToBackground } from "./messaging";
import { showToast } from "./toast";

/**
 * Feature 2, capture side.
 *
 * Any page can ask for a resume — LinkedIn's Easy Apply modal, an ATS form, a
 * company's own careers page — and they all do it through a file input. So this
 * listens for the file being *chosen* rather than for anything about the site,
 * and hands the bytes to the background worker immediately.
 *
 * Handing them over at once, instead of holding them here until the submission
 * is confirmed, is the whole point: this script dies on the next navigation,
 * and the confirmation page is almost always a new document.
 *
 * `isJobApplication` is what keeps "any page can ask for a resume" from meaning
 * "any page". Both callers are injected far more broadly than the feature needs
 * — one into every http(s) page, one into all of linkedin.com — and this used
 * to be armed unconditionally in both, so choosing a PDF in a mortgage form or
 * attaching one to a LinkedIn message read the file and sent it to the vault.
 *
 * It is a callback rather than a boolean because both callers run inside single-
 * page apps: the decision has to be made when the file is chosen, not when the
 * script loaded, or arriving at a job posting from the feed answers it wrongly
 * for the rest of the session.
 */
export function captureResumeUploads(isJobApplication: () => boolean): void {
  document.addEventListener(
    "change",
    (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.type !== "file") return;

      const file = input.files?.[0];
      if (!file) return;
      if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return;

      // Before anything reads the bytes.
      if (!isJobApplication()) return;

      // Checked here, before the bytes are read, base64-expanded by a third and
      // parked in chrome.storage.local. The server rejects the same size, but
      // by then the browser has already done all of that work — and said
      // nothing to the user, because the stash is silent until an application
      // is tracked.
      if (file.size > MAX_RESUME_BYTES) {
        showToast({
          title: "Resume too large to file",
          body: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)}MB. The vault accepts up to ${Math.round(MAX_RESUME_BYTES / 1024 / 1024)}MB. Your application is unaffected.`,
          timeoutMs: 8000,
        });
        return;
      }

      void stash(file);
    },
    // Capture phase: a page that calls stopPropagation on its own file input
    // would otherwise hide the event from us entirely.
    true,
  );
}

async function stash(file: File): Promise<void> {
  try {
    const buffer = await file.arrayBuffer();
    const res = await sendToBackground<StashResumeResult>({
      kind: "STASH_RESUME",
      payload: { fileName: file.name, fileBase64: arrayBufferToBase64(buffer) },
    });

    if (!res.ok) {
      showToast({ title: "Could not capture resume", body: res.error, timeoutMs: 8000 });
      return;
    }

    showToast(
      res.data.uploaded
        ? { title: "Resume saved to vault", body: file.name }
        : {
            title: "Resume captured",
            body: "It will be filed in the vault once this application is tracked.",
          },
    );
  } catch (err) {
    console.warn("[crm] resume capture failed:", err);
  }
}
