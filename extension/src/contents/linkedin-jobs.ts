import type { PlasmoCSConfig } from "plasmo";
import { onClickNamed, waitForElement } from "../lib/dom";
import { currentJobId, scrapeJobPosting } from "../lib/scrapers/linkedin";
import {
  type BgResponse,
  type CsRequest,
  type ScrapeJobResult,
  sendToBackground,
} from "../lib/messaging";
import { captureResumeUploads } from "../lib/resume-capture";
import { showToast } from "../lib/toast";

export const config: PlasmoCSConfig = {
  // Broad on purpose, the same way linkedin-profile.ts is. Chrome injects only
  // on a real navigation, so a `/jobs/*` match meant arriving at a posting from
  // the feed or from search — the normal way anyone gets there — left this
  // script absent, and an Easy Apply submitted from that tab was never tracked.
  // The profile script kept working in the same tab, which made it look like
  // the extension was fine.
  matches: ["https://www.linkedin.com/*"],
  all_frames: false,
};

/**
 * Feature 1, LinkedIn side.
 *
 * Two paths diverge from the same page:
 *   - Easy Apply: the submission completes here, so we track it directly.
 *   - Apply on company website: the JD exists only in this DOM, so we hand it
 *     to the background worker before the user navigates away.
 *
 * Both read the DOM only. Nothing here calls a LinkedIn API or clicks anything
 * on the user's behalf.
 */

// Injection is the first thing to rule out when tracking silently does nothing:
// Chrome only injects on a real navigation, and LinkedIn is a SPA, so arriving
// at /jobs/ from the feed leaves this script absent with no other symptom.
console.info("[crm] linkedin-jobs content script loaded on", location.href);

// Easy Apply asks for a resume too, and the universal watcher is excluded from
// linkedin.com, so the vault would otherwise miss every Easy Apply upload.
//
// Narrowed to the jobs area, which `matches` above cannot do: this script has
// to load site-wide to survive LinkedIn's SPA navigation, but that meant a PDF
// attached to a LinkedIn *message* was read and sent to the vault as well. The
// path is re-read on each file choice rather than captured here, because
// arriving at a posting from the feed never reloads the script.
captureResumeUploads(() => location.pathname.startsWith("/jobs/"));

/**
 * The final button of the Easy Apply modal.
 *
 * This used to be `button[aria-label*='Submit application' i]`, which requires
 * LinkedIn to set that exact attribute. It no longer does on every variant —
 * the button's name is often just its visible text — so submitting an Easy
 * Apply recorded nothing, with no error anywhere. That is the third control in
 * this extension to fail that way, so match what the button *says* instead.
 *
 * `\bsubmit\b` with a short-name guard keeps this to a real action button and
 * away from prose. A false positive costs nothing: the submission is only
 * recorded once the page confirms it went through.
 */
function isEasyApplySubmit(name: string): boolean {
  return name.length <= 40 && /\bsubmit\b/i.test(name);
}

/**
 * The JD panel is the piece most likely to be gone by the time the user
 * submits — LinkedIn swaps it out when the apply modal opens. Cache on every
 * navigation so submission can read a snapshot instead of a stale DOM.
 */
let cachedJob: ReturnType<typeof scrapeJobPosting> = null;

/**
 * Keep the snapshot only while it still describes the posting on screen.
 *
 * Holding the last successful scrape unconditionally is what makes a failed
 * scrape dangerous rather than merely unhelpful: the user opens the next
 * posting, the scrape misses, and the cache still answers with the *previous*
 * job — title, company, URL and requisition id all belonging to something they
 * only browsed. That is not a degraded record, it is a confident wrong one, and
 * because the requisition id is wrong too it overwrites a real application
 * instead of creating its own row. An empty cache costs the user a toast asking
 * them to add the application by hand.
 */
function refreshCache(): void {
  const scraped = scrapeJobPosting();
  if (scraped) {
    cachedJob = scraped;
    return;
  }

  const onScreen = currentJobId();
  if (cachedJob && cachedJob.externalJobId !== onScreen) cachedJob = null;
}

onClickNamed(isEasyApplySubmit, () => {
  console.info("[crm] easy apply submit clicked");
  refreshCache();
  const job = cachedJob;
  if (!job) {
    console.warn("[crm] submit clicked but no job posting could be read");
    return;
  }

  // Fire and forget: blocking the click would interfere with LinkedIn's own
  // submit handler, and a tracking failure must never cost the user an apply.
  void (async () => {
    // Confirm the modal actually reported success before recording anything.
    const succeeded = await waitForSubmissionConfirmation();
    if (!succeeded) return;

    const res = await sendToBackground({
      kind: "TRACK_APPLICATION",
      payload: {
        company: job.company,
        title: job.title,
        url: job.url,
        location: job.location,
        jdText: job.jdText,
        source: "linkedin_easy_apply",
        externalJobId: job.externalJobId,
        status: "Applied",
        appliedAt: new Date().toISOString(),
      },
    });

    showToast(
      res.ok
        ? { title: "Application tracked", body: `${job.title} at ${job.company}` }
        : { title: "Could not track application", body: res.error },
    );
  })();
});

/**
 * Hand the JD to the worker, which asks for it the moment a tab opens from this
 * page. Answering from the cache is deliberate: LinkedIn tears the description
 * panel out of the DOM as the apply flow starts, so a fresh scrape at exactly
 * this moment often finds nothing.
 */
chrome.runtime.onMessage.addListener((message: CsRequest, _sender, sendResponse) => {
  // The worker also broadcasts panel events on this channel; ignore those.
  if (message?.kind !== "SCRAPE_JOB") return false;

  refreshCache();
  const job = cachedJob;

  sendResponse({
    ok: true,
    data: {
      job: job && {
        company: job.company,
        title: job.title,
        location: job.location,
        jdText: job.jdText,
        linkedinUrl: job.url,
        externalJobId: job.externalJobId,
      },
    },
  } satisfies BgResponse<ScrapeJobResult>);

  showToast(
    job
      ? {
          title: "Watching for your application",
          body: `${job.title} at ${job.company}. Submit on the company site and it will be tracked automatically.`,
          timeoutMs: 6000,
        }
      : {
          title: "Could not read this job posting",
          body: "Add it from the side panel after you apply.",
          timeoutMs: 6000,
        },
  );

  return false;
});

/** What LinkedIn says once the application is actually through. */
const APPLICATION_SENT = /application (was )?(sent|submitted)|your application was sent/i;

/** Containers the Easy Apply flow runs inside, across LinkedIn's variants. */
const APPLY_MODAL = ".jobs-easy-apply-modal, [data-test-modal], .artdeco-modal";

/**
 * Wait until the page says the application went through.
 *
 * This gate exists so that clicking Submit on an incomplete form — which yields
 * a validation error, not an application — is never recorded. It used to look
 * for four specific class names, all of which are LinkedIn build artefacts and
 * at least some of which no longer exist; when none matched it fell through to
 * "is a modal still open?", and Easy Apply's multi-step flow keeps the modal
 * open, so a real submission was read as a failure and dropped in silence.
 *
 * Reading the confirmation text is durable in a way class names are not: the
 * words are the product, and they have to stay legible to the user.
 */
async function waitForSubmissionConfirmation(): Promise<boolean> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (document.querySelector(".artdeco-inline-feedback--error")) return false;
    if (APPLICATION_SENT.test(document.body.innerText)) return true;

    // Some variants just close the modal. With no error on screen, that is a
    // success too.
    if (!document.querySelector(APPLY_MODAL)) return true;

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  console.warn("[crm] no submission confirmation appeared within 10s");
  return false;
}

// LinkedIn's job board is a SPA; re-cache as the user browses listings.
refreshCache();
let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    void waitForElement("#job-details, .jobs-description__content", 6000).then(refreshCache);
  }
}, 1000);
