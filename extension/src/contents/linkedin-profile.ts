import type { PlasmoCSConfig } from "plasmo";
import type { CaptureContactResponse } from "@crm/shared";
import { blockText, normalizeWhitespace, onClickNamed } from "../lib/dom";
import {
  canonicalProfileUrl,
  isFirstDegreeConnection,
  scrapeProfile,
} from "../lib/scrapers/linkedin";
import { sendToBackground } from "../lib/messaging";
import { showToast } from "../lib/toast";

export const config: PlasmoCSConfig = {
  // Every LinkedIn surface, because a Connect button is not confined to one.
  // People connect from search results, from "My Network", from an employer's
  // People tab, from the feed's suggestion rail — and Chrome only injects a
  // content script on a real navigation, so a match list of specific paths
  // loses every one of those reached by LinkedIn's client-side routing. A
  // narrow list did not fail loudly; it failed by the button doing nothing.
  matches: ["https://www.linkedin.com/*"],
  all_frames: false,
};

/**
 * Feature 3: asynchronous entity mapping.
 *
 * When the user sends a connection request we capture the profile and let the
 * server fuzzy-match the company against tracked applications. The match runs
 * at capture time rather than apply time, which is what makes the ordering
 * irrelevant: connecting three days after applying resolves the same way.
 */

/**
 * Every variant LinkedIn renders — "Invite <name> to connect" on people cards,
 * "Connect" on a profile's top card, and the overflow-menu item used when the
 * primary action is Message or Follow.
 *
 * The previous version required an explicit `aria-label` containing "connect".
 * People cards have one; the top-card button and the "More" menu item do not,
 * their name comes from their visible text. So connecting from a profile page —
 * the most obvious way to do it — recorded nothing at all.
 *
 * `\bconnect\b` deliberately rejects "Connections" (the nav item) and
 * "Disconnect": in both, the word is not bounded. The length guard keeps a
 * promo banner that happens to contain the word from triggering a capture.
 */
function isConnectControl(name: string): boolean {
  return name.length <= 60 && /\bconnect\b/i.test(name);
}

// Injection is the first thing to rule out when a Connect click records
// nothing: Chrome only injects on a real navigation, and LinkedIn is a SPA, so
// reaching a company page from the feed can leave this script absent entirely.
console.info("[crm] linkedin-profile content script loaded on", location.href);

/** Guards against double-capture when LinkedIn re-renders the button. */
let lastCapturedUrl: string | null = null;

onClickNamed(isConnectControl, (button) => {
  console.info("[crm] connect clicked:", button.tagName, button.textContent?.trim());
  const profile = capture(button);
  if (!profile) {
    showToast({
      title: "Could not read that profile",
      body: "Add the contact from their profile page instead.",
    });
    return;
  }

  const url = profile.linkedinUrl;
  if (url === lastCapturedUrl) return;
  lastCapturedUrl = url;

  void (async () => {
    const res = await sendToBackground<CaptureContactResponse>({
      kind: "CAPTURE_CONTACT",
      payload: profile,
    });

    if (!res.ok) {
      // Let a retry through; the capture never happened.
      lastCapturedUrl = null;
      showToast({ title: "Could not save contact", body: res.error });
      return;
    }

    presentResolution(res.data);
  })();
});

/**
 * Feature 5, passive half.
 *
 * The background sweep runs at a jittered 30-90 minute cadence and pauses
 * overnight, so an acceptance can sit unnoticed for hours — which reads, from
 * the panel, as the extension simply not working. Whenever the user opens a
 * profile themselves, the badge is right there for free: report it.
 *
 * This is a read of the page the user is already looking at. It opens nothing,
 * clicks nothing and calls no LinkedIn API.
 */
/**
 * When to read a profile after arriving on it.
 *
 * LinkedIn's profile renders progressively — the cards sit inside a
 * `data-component-type="LazyColumn"` — so the sections do not all exist at any
 * one moment. A single read at a fixed delay is a coin flip: on a real profile
 * the About and Experience cards were present at three seconds while Skills had
 * not rendered at all. Reading three times costs nothing (no network, no
 * clicks, no scrolling) and `reportProfileDetails` forwards a read only when it
 * saw more than the previous one did.
 */
const PROFILE_READ_DELAYS_MS = [3000, 8000, 16000];

/**
 * Three timed reads are not enough, and this is why the column kept coming back
 * null.
 *
 * The timers answer "has LinkedIn finished hydrating?" They do not answer "has
 * the card been built at all?", and on the current profile the About,
 * Experience and Skills cards sit inside a lazy column that renders when the
 * user scrolls near it. A profile opened and left at the top — which is what
 * opening someone's profile from the side panel does — can still have no
 * Experience card in the DOM at sixteen seconds, and every one of the three
 * reads then finds nothing. The enrich call that follows is a legal no-op (the
 * server only writes `profile_text` when the incoming text is *richer*), so the
 * whole visit stored nothing and said nothing.
 *
 * So watch instead of poll: any DOM change on an `/in/` page is a chance that a
 * card just appeared, and scrolling to it later in the visit is the commonest
 * such change. Throttled, because LinkedIn mutates continuously, and bounded,
 * because an observer left attached to a SPA is a leak.
 */
const PROFILE_WATCH_MS = 120_000;
const PROFILE_READ_THROTTLE_MS = 2_000;

let watching: { url: string; stop: (expired: boolean) => void } | null = null;

function watchProfile(url: string): void {
  // Leaving the previous page's observer attached would keep re-reading a
  // profile the user has navigated away from.
  watching?.stop(false);

  let lastRead = 0;
  const observer = new MutationObserver(() => {
    if (canonicalProfileUrl() !== url) return;
    if (Date.now() - lastRead < PROFILE_READ_THROTTLE_MS) return;
    lastRead = Date.now();
    reportProfileDetails();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // The URL is re-checked inside each timer because they outlive an SPA
  // navigation, and a late read would otherwise attribute this person's About
  // section to whoever the user opened next.
  const timers = PROFILE_READ_DELAYS_MS.map((delay) =>
    setTimeout(() => {
      if (canonicalProfileUrl() === url) reportProfileDetails();
    }, delay),
  );

  const stop = (expired: boolean): void => {
    observer.disconnect();
    for (const timer of timers) clearTimeout(timer);
    clearTimeout(deadline);
    watching = null;
    // Only on expiry. Navigating away after five seconds is not a failure, and
    // saying so every time the user glances at a profile would be noise.
    if (expired) void reportUnreadProfile(url);
  };

  const deadline = setTimeout(() => stop(true), PROFILE_WATCH_MS);
  watching = { url, stop };
}

function reportIfConnected(): void {
  // LinkedIn hydrates both surfaces well after load; an immediate read always
  // misses the degree badge and sees an empty list.
  if (location.pathname.startsWith("/in/")) {
    const url = canonicalProfileUrl();

    // Unconditional, and before the degree check: a contact captured from a
    // people card often has no headline, because the card renders "Message" or
    // "Pending" where one would go. The headline decides the recipient's
    // persona and therefore which resume evidence a draft is built from, so a
    // null one is not cosmetic. The full profile is the one surface that always
    // has it, and the user is standing on it.
    watchProfile(url);

    setTimeout(() => {
      if (canonicalProfileUrl() !== url || !isFirstDegreeConnection()) return;
      void sendToBackground({ kind: "OBSERVE_ACCEPTED", payload: { linkedinUrls: [url] } });
    }, PROFILE_READ_DELAYS_MS[0]);
    return;
  }

  setTimeout(() => {
    if (CONNECTIONS_PAGE.test(location.pathname)) reportConnectionsList();
  }, PROFILE_READ_DELAYS_MS[0]);
}

/**
 * Say so when a tracked contact's profile was never readable.
 *
 * This path has now failed silently three times, and each time the only symptom
 * was a persistent amber line in the side panel telling the user to do the very
 * thing they had just done. A visit that stored nothing for somebody the CRM is
 * tracking is a defect, and it has to announce itself on the page where it
 * happened. A stranger's profile storing nothing is the correct outcome and
 * stays silent — hence the lookup rather than an unconditional toast.
 */
async function reportUnreadProfile(url: string): Promise<void> {
  if (storedFor.url === url && storedFor.chars > 0) return;

  const res = await sendToBackground<{ contact: { profile_text: string | null } | null }>({
    kind: "LOOKUP_CONTACT_BY_URL",
    payload: { linkedinUrl: url },
  });
  if (!res.ok || !res.data.contact || res.data.contact.profile_text) return;

  showToast({
    title: "Could not read this profile",
    body:
      "Their About and Experience never rendered, so drafts still have only " +
      "their headline. Scroll down their profile once and it will be picked up.",
  });
}

/** How much profile text the server confirmed it holds, for the URL last read. */
let storedFor = { url: "", chars: 0 };

/**
 * The Connections page states, in one screen, that every person on it accepted.
 * The user was reading it while the panel still said "Pending" — the answer was
 * literally on their monitor. Harvest it.
 *
 * Only what is already rendered is read: no scrolling, no clicking, no extra
 * requests. The background worker intersects this against the watchlist, so
 * nothing about untracked connections ever leaves the browser.
 */
const CONNECTIONS_PAGE = /^\/mynetwork\/invite-connect\/connections/;

/**
 * Send this profile's headline, employer and condensed profile text to the
 * server, which fills them in only if the contact is already known and the
 * fields are still null. An unknown profile is a no-op — this must never turn
 * "the user looked at someone" into a CRM record.
 *
 * `profileText` is the reason this runs on every visit rather than only when
 * something is missing: a contact captured from a people card has a headline
 * and nothing else, and the About and Experience sections are what let a draft
 * say something the recipient recognises as being about them.
 */
let lastEnrichment: { url: string; size: number } | null = null;

function reportProfileDetails(): void {
  const profile = scrapeProfile();
  if (!profile) return;

  // Loud on purpose. A scrape that silently returns nothing is indistinguishable
  // from the extension being switched off, and that is exactly how a profile
  // visit came to enrich nothing for weeks: LinkedIn moved the profile onto its
  // server-driven renderer, every selector here missed, and the failure was
  // invisible from the panel.
  console.info("[crm] profile scrape", {
    name: profile.name,
    headline: profile.headline,
    company: profile.company,
    profileTextChars: profile.profileText?.length ?? 0,
  });

  if (!profile.headline && !profile.company && !profile.profileText) return;

  // Several reads are scheduled per visit because the cards hydrate at
  // different times. Forward one only when it saw more than the last, so a
  // late-but-thinner read cannot walk back a good one.
  const size = profile.profileText?.length ?? 0;
  if (lastEnrichment?.url === profile.linkedinUrl && size <= lastEnrichment.size) return;
  lastEnrichment = { url: profile.linkedinUrl, size };

  void (async () => {
    const res = await sendToBackground<{
      contact: { profile_text: string | null } | null;
      updated: boolean;
    }>({
      kind: "ENRICH_CONTACT",
      payload: {
        linkedinUrl: profile.linkedinUrl,
        headline: profile.headline,
        company: profile.company,
        profileText: profile.profileText,
      },
    });

    // The result used to be discarded with a bare `void`. A scrape that read
    // 2400 characters and then failed to store any of them looked, from the
    // panel, exactly like a scrape that had read nothing — so the send must
    // report itself, and a rejection must not stick in `lastEnrichment` or the
    // later reads in this visit would all skip as "no new information".
    if (!res.ok) {
      lastEnrichment = null;
      console.warn("[crm] enrich failed", res.error);
      // A console line is not enough. This path has now failed silently twice,
      // and both times the log was there and unread — the page console defaults
      // to a level filter that hides it. A rejection here means the profile the
      // user is looking at will never reach a draft, so say so where they are.
      // Success is deliberately silent: most profiles are strangers, and an
      // unknown profile is a no-op that returns ok.
      showToast({ title: "Could not save this profile", body: res.error });
      return;
    }

    // What the server confirms it holds, not what we believe we sent. The
    // enrich call succeeds and writes nothing whenever the incoming text is not
    // richer than the stored text, so "the request worked" is not evidence the
    // profile is readable — reading the row back is.
    storedFor = {
      url: profile.linkedinUrl,
      chars: res.data.contact?.profile_text?.length ?? 0,
    };
    console.info("[crm] enrich stored", res.data.updated, storedFor.chars, "chars");
  })();
}

/** A row offering this is a suggestion, not somebody the user is connected to. */
const OFFERS_TO_CONNECT = /\b(connect|follow)\b/i;

function reportConnectionsList(): void {
  // Scoped to `main` so the nav's own "Me" avatar is never read back as a
  // connection.
  const root = document.querySelector("main") ?? document;
  const urls = new Set<string>();

  for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href*='/in/']")) {
    const slug = anchor.href.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1];
    if (!slug) continue;

    // The Connections page renders "People you may know" beside the real list,
    // and reading both the same way reported people the user had merely invited
    // as having accepted. `\b` keeps this off "Connections", "Remove
    // connection" and "Connected 3 days ago".
    const row = anchor.closest("li") ?? anchor.parentElement;
    if (OFFERS_TO_CONNECT.test((row as HTMLElement | null)?.innerText ?? "")) continue;

    urls.add(`https://www.linkedin.com/in/${slug}/`);
  }
  if (urls.size === 0) return;

  void sendToBackground({
    kind: "OBSERVE_ACCEPTED",
    payload: { linkedinUrls: [...urls] },
  });
}

reportIfConnected();

// Both surfaces are reached by SPA navigation far more often than by page load.
let lastProfileUrl = location.href;
setInterval(() => {
  if (location.href !== lastProfileUrl) {
    lastProfileUrl = location.href;
    reportIfConnected();
  }
}, 1500);

interface CapturedProfile {
  name: string;
  linkedinUrl: string;
  headline: string | null;
  company: string | null;
  /** Only ever present when the click happened on the person's own profile. */
  profileText: string | null;
}

/**
 * Resolve the click to the person it was about.
 *
 * The page is the wrong thing to branch on. A profile page also renders
 * Connect buttons for "People also viewed", and search results, My Network and
 * the feed's suggestion rail are all card surfaces with no path in common. So
 * resolve the button to its own card first — that is true everywhere — and only
 * fall back to reading the whole document when the card turns out to be the
 * profile currently open, where the full page says more than the top card does.
 */
function capture(button: Element): CapturedProfile | null {
  const card = fromCard(button);

  if (location.pathname.startsWith("/in/")) {
    const self = canonicalProfileUrl();
    // `?? card` matters: the two reads fail independently, and the profile page
    // is the surface where giving up is least acceptable — the user is looking
    // straight at the person they just invited.
    if (!card || card.linkedinUrl === self) return scrapeProfile() ?? card;
  }

  return card;
}

/**
 * Read one person out of a people-card.
 *
 * The card is located structurally — the nearest ancestor of the button that
 * links to a profile — rather than by class name, because these cards carry
 * nothing but build hashes. Its rendered text is then read positionally:
 * "Kimia Ghorbani · 3rd" / "Backend Developer" / "Message".
 */
function fromCard(button: Element): CapturedProfile | null {
  let link: HTMLAnchorElement | null = null;
  let card: Element | null = null;

  for (let el = button.parentElement; el && el.tagName !== "BODY"; el = el.parentElement) {
    link = el.querySelector<HTMLAnchorElement>("a[href*='/in/']");
    if (link) {
      card = el;
      break;
    }
  }
  if (!link || !card) return null;

  const lines = blockText(card)?.split("\n") ?? [];
  const name = stripConnectionDegree(lines[0] ?? "");
  if (!name) return null;

  const headline = lines[1] && !IS_CARD_ACTION.test(lines[1]) ? lines[1] : null;

  return {
    name,
    linkedinUrl: canonicalProfileUrl(link.href),
    headline,
    company: companyFromPage(),
    // A card is a name and a line of text. Reading the open page here would
    // attribute whoever's profile is on screen to whoever's card was clicked.
    profileText: null,
  };
}

/** Card actions sit where the headline would be for people with no headline. */
const IS_CARD_ACTION = /^(message|connect|follow(ing)?|pending|view profile)$/i;

/** Names render as "Ehsan Ranjbar · 3rd"; the degree is not part of the name. */
function stripConnectionDegree(line: string): string {
  return normalizeWhitespace(line.split("·")[0] ?? "");
}

/**
 * The employer of everyone on a company page is the company itself, and the URL
 * slug is the dependable source — the visible heading is sometimes the tab name
 * rather than the company.
 *
 * Anywhere else, return nothing rather than guess. This used to fall back to
 * the page's `h1`, which on search results is the search term and in My Network
 * is "Grow your network" — a confidently wrong company the server would then
 * fuzzy-match against real applications. The headline travels with the contact
 * and the server extracts the employer from it.
 */
function companyFromPage(): string | null {
  const slug = location.pathname.match(/\/company\/([^/?#]+)/)?.[1];
  if (!slug) return null;
  return slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function presentResolution(result: CaptureContactResponse): void {
  const { contact, resolution, candidateJobs } = result;

  if (resolution === "auto_linked") {
    const job = candidateJobs[0];
    showToast({
      title: "Contact linked",
      body: job
        ? `${contact.name} linked to ${job.title} at ${job.company}`
        : `${contact.name} saved`,
    });
    return;
  }

  if (resolution === "general_networking") {
    showToast({
      title: "Saved as general networking",
      body: `No tracked application matches ${contact.company ?? "their company"}.`,
    });
    return;
  }

  // Ambiguous: the PRD calls for the user to pick. This toast does not
  // auto-dismiss, because dismissing it would silently leave the link unset.
  showToast({
    title: "Which role is this about?",
    body: `${contact.name} works at ${contact.company ?? "a company"} you have applied to more than once.`,
    actions: [
      ...candidateJobs.slice(0, 3).map((job) => ({
        label: job.title.length > 28 ? `${job.title.slice(0, 27)}…` : job.title,
        onClick: () => {
          void sendToBackground({
            kind: "LINK_CONTACT",
            payload: { contactId: contact.id, jobId: job.id },
          }).then((res) => {
            showToast(
              res.ok
                ? { title: "Contact linked", body: `${contact.name} → ${job.title}` }
                : { title: "Could not link contact", body: res.error },
            );
          });
        },
      })),
      { label: "Not job-related", variant: "ghost" as const, onClick: () => {} },
    ],
  });
}
