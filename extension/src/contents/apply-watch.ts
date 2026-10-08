import type { PlasmoCSConfig } from "plasmo";
import { detectVendor, hasConfirmationText, isSuccessUrl, scrapeAtsJob } from "../lib/scrapers/ats";
import {
  type CommitHandshakeResult,
  type HasOpenHandshakeResult,
  sendToBackground,
} from "../lib/messaging";
import { captureResumeUploads } from "../lib/resume-capture";
import { showToast } from "../lib/toast";

/**
 * Feature 1 (external side) and Feature 2 (Document Vault), on any site.
 *
 * This used to be a list of six ATS vendors. That list is unwinnable: every
 * employer picks their own platform, several run their careers site in-house,
 * and a vendor that is not listed is not merely degraded — the script is never
 * injected, so the application, the JD and the resume are all lost with no
 * symptom the user can see. Being absent is the worst possible failure mode.
 *
 * So it now loads everywhere and decides for itself whether the page is worth
 * watching. The expensive part (a whole-body MutationObserver and a URL poll)
 * is armed only on evidence, so an ordinary page pays for two idle event
 * listeners and one string test.
 */
export const config: PlasmoCSConfig = {
  matches: ["http://*/*", "https://*/*"],
  // LinkedIn has its own scripts for jobs, profiles and messaging; running this
  // one there too would double-track every Easy Apply.
  exclude_matches: ["https://*.linkedin.com/*", "http://*.linkedin.com/*"],
  all_frames: true, // Greenhouse and friends embed the form in an iframe.
};

/** Whichever success signal fires first wins; the rest become no-ops. */
let committed = false;
let watching = false;

/**
 * Set once the background worker confirms the user reached this page from a
 * LinkedIn job posting. That is direct evidence of an application and outranks
 * anything the URL does or does not say.
 */
let handshakeOpen = false;

captureResumeUploads(() => handshakeOpen || isJobApplicationSite());

// --- Deciding whether to watch ---------------------------------------------

/**
 * Sites that host job applications say so in their URL. Deliberately broad:
 * a false positive costs one MutationObserver, a false negative costs the
 * user's application.
 */
const APPLY_URL = /(apply|application|career|job|vacanc|recruit|talent|hiring|opening)/i;

/**
 * Evidence that this page is a job application, as opposed to a page that
 * merely accepts a file.
 *
 * The distinction exists because two different things are gated on it, and
 * they have very different costs when wrong. Arming the submission watcher on
 * a page that turns out not to be an application costs one MutationObserver.
 * Arming the *resume capture* on one reads the PDF the user chose, base64s it,
 * and sends it to the server — so a false positive there is a document leaving
 * the device.
 */
function isJobApplicationSite(): boolean {
  return APPLY_URL.test(location.href) || isSuccessUrl() || hasConfirmationText();
}

function looksLikeApplyFlow(): boolean {
  if (isJobApplicationSite()) return true;
  // A résumé upload field is suggestive, but only of a file, not of a job.
  if (document.querySelector("input[type='file']")) return true;
  return false;
}

async function init(): Promise<void> {
  // An open handshake means the user arrived here from a LinkedIn job posting.
  // That outranks every heuristic below, because it is the one case where we
  // already know what they are applying to.
  const res = await sendToBackground<HasOpenHandshakeResult>({ kind: "HAS_OPEN_HANDSHAKE" });
  if (res.ok && res.data.open) {
    handshakeOpen = true;
    watch("handshake open for this tab");
    return;
  }

  if (looksLikeApplyFlow()) watch("page looks like an application");
}

function watch(reason: string): void {
  if (watching) return;
  watching = true;
  console.info(`[crm] watching for a submission (${reason}):`, location.href);

  const check = () => {
    if (committed) return;
    if (isSuccessUrl() || hasConfirmationText()) void tryCommit("confirmation page");
  };

  check();

  const observer = new MutationObserver(check);
  observer.observe(document.body, { childList: true, subtree: true });

  // SPA ATSs swap in the confirmation without a page load, so the URL changes
  // without firing anything we could listen to.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      check();
    }
  }, 1000);
}

// --- Submission signals ------------------------------------------------------

document.addEventListener(
  "submit",
  (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    // Submitting a form is the strongest hint a page can give, even if the URL
    // said nothing: start watching now if we were not already.
    watch("form submitted");
    // Submit fires before the server responds, so wait for a navigation or a
    // confirmation to render rather than trusting the event alone.
    setTimeout(() => void tryCommit("form submit"), 2500);
  },
  true,
);

async function tryCommit(reason: string): Promise<void> {
  if (committed) return;

  // A form submit alone is not proof; require a positive success signal.
  if (!isSuccessUrl() && !hasConfirmationText()) return;

  committed = true;
  console.info(`[crm] committing application (${reason})`);

  const res = await sendToBackground<CommitHandshakeResult>({
    kind: "COMMIT_HANDSHAKE",
    payload: { url: location.href, vendor: detectVendor() },
  });

  if (!res.ok) {
    committed = false; // Allow a later signal to retry.
    showToast({ title: "Could not track application", body: res.error, timeoutMs: 8000 });
    return;
  }

  if (!res.data.committed) {
    // No handshake: the user reached this site directly rather than via
    // LinkedIn. Offer to track it using whatever the page itself provides.
    offerManualTracking();
    return;
  }

  const job = res.data.job;
  showToast({
    title: "Application tracked",
    body: job ? `${job.title} at ${job.company}` : "Saved to your CRM",
  });
}

function offerManualTracking(): void {
  const scraped = scrapeAtsJob();
  if (!scraped.title || !scraped.company) {
    // Silence here reads as a broken extension, and the user is standing on a
    // confirmation page with nothing recorded. Say so.
    showToast({
      title: "Could not read this job posting",
      body: "Add the application from the side panel so the resume is filed against it.",
      timeoutMs: 8000,
    });
    return;
  }

  showToast({
    title: "Track this application?",
    body: `${scraped.title} at ${scraped.company}`,
    actions: [
      {
        label: "Track it",
        onClick: () => {
          void (async () => {
            const res = await sendToBackground({
              kind: "TRACK_APPLICATION",
              payload: {
                company: scraped.company!,
                title: scraped.title!,
                url: location.href,
                location: scraped.location,
                jdText: scraped.jdText,
                source: "external_ats",
                externalJobId: null,
                status: "Applied",
                appliedAt: new Date().toISOString(),
              },
            });
            showToast(
              res.ok
                ? { title: "Application tracked" }
                : { title: "Could not track application", body: res.error },
            );
          })();
        },
      },
      { label: "No thanks", variant: "ghost", onClick: () => {} },
    ],
  });
}

void init();
