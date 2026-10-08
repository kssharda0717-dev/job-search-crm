// The subpath, never the `@crm/shared` barrel. The barrel re-exports the zod
// schemas, and this module is the LinkedIn content script's entire scraping
// layer: importing the barrel put zod in that bundle, Parcel emitted a stub for
// it, and the script died at load with `(0, o.z).enum is not a function`.
import { looksLikeJobTitle } from "@crm/shared/job-title";
import { condenseProfile, dedupeAdjacent } from "@crm/shared/profile-text";
import { blockText, findFirst, normalizeWhitespace, textFrom } from "../dom";

/**
 * LinkedIn DOM scraping.
 *
 * Every selector list is ordered most-stable-first. LinkedIn's class names are
 * build-hashed, so we lead with `data-*` and ARIA attributes and only fall back
 * to class names, which are the parts most likely to rot between releases.
 */

export interface ScrapedJob {
  title: string;
  company: string;
  location: string | null;
  jdText: string | null;
  externalJobId: string | null;
  url: string;
}

/**
 * The detail pane on /jobs/search-results, where the results list and the
 * selected job coexist in one document. Every selector below is resolved
 * against this rather than the document: a bare `h1` or company link would
 * otherwise match the list and silently scrape the wrong job.
 */
const DETAILS_ROOT_SELECTORS = [
  ".jobs-search__job-details",
  ".jobs-details",
  ".job-view-layout",
  "main",
];

const TITLE_SELECTORS = [
  ".job-details-jobs-unified-top-card__job-title h1",
  ".job-details-jobs-unified-top-card__job-title",
  ".jobs-unified-top-card__job-title",
  "h1.t-24",
  // Structural last resort. On builds that still render a heading this is the
  // job title; on the fully re-hashed layout there is no h1 at all and the
  // id-keyed fallbacks below take over.
  "h1",
];

/** The employer is always linked to its company page, whatever the layout. */
const COMPANY_LINK = "a[href*='/company/']";

const COMPANY_SELECTORS = [
  ".job-details-jobs-unified-top-card__company-name a",
  ".job-details-jobs-unified-top-card__company-name",
  ".jobs-unified-top-card__company-name",
];

/** Nav affordances that hang off a `/company/` link but are not the employer. */
const NOT_A_COMPANY = /^(show|see|view|follow|more)\b/i;

const LOCATION_SELECTORS = [
  ".job-details-jobs-unified-top-card__primary-description-container .tvm__text",
  ".job-details-jobs-unified-top-card__bullet",
  ".jobs-unified-top-card__bullet",
];

const JD_SELECTORS = [
  "#job-details",
  ".jobs-description__content",
  ".jobs-box__html-content",
  ".jobs-description-content__text",
];

export function scrapeJobPosting(): ScrapedJob | null {
  const jobId = currentJobId();
  const root = detailsPane(jobId);
  const fromTitle = parseDocumentTitle();

  // document.title leads, contrary to the "last resort" note on
  // parseDocumentTitle below. It is ugly to parse, but it is the only string
  // that provably describes the *selected* job. Every DOM selector here resolves
  // against `root`, and when LinkedIn's class names rotate — which they have,
  // twice — detailsPane() degrades to `main`, which on /jobs/search-results
  // holds the filter bar and all 99 other results as well. `querySelector("h1")`
  // then returns whatever comes first in the document, and three applications
  // were filed as "Share negative feedback" and "Remote" because of it.
  const title =
    fromTitle?.title ??
    looksLikeJobTitle(textFrom(TITLE_SELECTORS, root)) ??
    looksLikeJobTitle(titleFromJobLink(jobId));
  const company =
    textFrom(COMPANY_SELECTORS, root) ?? companyFromLinks(root) ?? fromTitle?.company ?? null;

  // Without both of these the record is useless for company matching later,
  // so treat it as a failed scrape rather than saving a half-populated job.
  if (!title || !company) return null;

  return {
    title,
    company,
    location: textFrom(LOCATION_SELECTORS, root) ?? fromTitle?.location ?? null,
    jdText: jobDescription(jobId, root),
    externalJobId: jobId,
    url: canonicalJobUrl(),
  };
}

/**
 * Narrow the document down to the selected job's detail pane.
 *
 * LinkedIn's class names are build hashes and have already rotated out from
 * under this scraper twice, taking every `DETAILS_ROOT_SELECTORS` entry with
 * them. The detail sections, however, keep readable ids that carry the job id
 * straight from the URL — `JobDetails_AboutTheJob_<jobId>`. Anchoring on one of
 * those and walking up to the nearest block that also holds the employer link
 * yields a root that provably belongs to this job and not to a results-list
 * neighbour, without depending on styling at all.
 */
function detailsPane(jobId: string | null): ParentNode {
  const section = jobId ? document.getElementById(`JobDetails_AboutTheJob_${jobId}`) : null;
  for (let el = section?.parentElement; el; el = el.parentElement) {
    if (el.querySelector(COMPANY_LINK)) return el;
  }
  return findFirst(DETAILS_ROOT_SELECTORS) ?? document;
}

function jobDescription(jobId: string | null, root: ParentNode): string | null {
  const byId = jobId ? document.getElementById(`JobDetails_AboutTheJob_${jobId}`) : null;
  const fromId = blockText(byId);
  if (fromId) return fromId;

  for (const selector of JD_SELECTORS) {
    const text = blockText(root.querySelector(selector));
    if (text) return text;
  }
  return null;
}

/**
 * The results list links each card to its own job. Matching on the id from the
 * URL picks out the selected one, so this can never return a neighbour's title.
 */
function titleFromJobLink(jobId: string | null): string | null {
  if (!jobId) return null;
  const link = document.querySelector(`a[href*='/jobs/view/${jobId}']`);
  if (!link) return null;

  const label = link.getAttribute("aria-label") ?? link.textContent ?? "";
  return normalizeWhitespace(label) || null;
}

/**
 * LinkedIn puts the posting in the tab title, and it is the one string on the
 * page that no amount of DOM re-hashing can move.
 *
 * Two forms are in the wild. The older one names the employer first —
 * "(3) Acme hiring Staff Engineer in Remote | LinkedIn" — and yields all three
 * fields. The current one is pipe-separated and title-first:
 * "Staff Engineer | Acme | LinkedIn".
 *
 * The pipe form deliberately returns **no company**. The middle segment looks
 * like the employer, but nothing here proves it is not the location, and a
 * wrong company silently mis-links every contact at that employer forever,
 * whereas a missing one falls through to the DOM read that is already getting
 * it right. Exactly three segments is the discriminator: a search page titled
 * "(20) jobs in United Arab Emirates | LinkedIn" has two, so it cannot be
 * mistaken for a posting.
 */
function parseDocumentTitle():
  | { company: string | null; title: string; location: string | null }
  | null {
  const raw = document.title.replace(/^\(\d+\)\s*/, "");

  const hiring = raw.match(/^(.+?)\s+hiring\s+(.+?)(?:\s+in\s+(.+?))?\s*\|\s*LinkedIn\s*$/);
  if (hiring?.[1] && hiring[2]) {
    return {
      company: normalizeWhitespace(hiring[1]),
      title: normalizeWhitespace(hiring[2]),
      location: hiring[3] ? normalizeWhitespace(hiring[3]) : null,
    };
  }

  const segments = raw.split("|").map((segment) => normalizeWhitespace(segment));
  if (segments.length === 3 && segments[0] && segments[1] && /^LinkedIn$/i.test(segments[2] ?? "")) {
    return { company: null, title: segments[0], location: null };
  }
  return null;
}

/**
 * Pick the employer out of the detail pane's `/company/` links.
 *
 * Not all of them are the company name: LinkedIn hangs "Show Premium Insights"
 * and "Show more" off the same href, and the first one in document order is one
 * of those. Take the name that occurs most often instead — the employer is
 * linked from the top card, the about-company block and its follower count,
 * while each call-to-action appears exactly once.
 */
function companyFromLinks(root: ParentNode): string | null {
  const counts = new Map<string, number>();

  for (const link of root.querySelectorAll(COMPANY_LINK)) {
    const name = stripFollowerCount(normalizeWhitespace(link.textContent ?? ""));
    if (!name || NOT_A_COMPANY.test(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  let best: string | null = null;
  for (const [name, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) best = name;
  }
  return best;
}

/** The "About the company" link runs the name into its follower count. */
function stripFollowerCount(name: string | null): string | null {
  return name?.replace(/[\d,.]+\s*[KM]?\s*followers?$/i, "").trim() || null;
}

/** Job id lives in the path on /jobs/view/:id and in ?currentJobId= on the list view. */
export function currentJobId(): string | null {
  const fromQuery = new URLSearchParams(location.search).get("currentJobId");
  if (fromQuery) return fromQuery;

  const fromPath = location.pathname.match(/\/jobs\/view\/(\d+)/);
  return fromPath?.[1] ?? null;
}

export function canonicalJobUrl(): string {
  const id = currentJobId();
  return id ? `https://www.linkedin.com/jobs/view/${id}/` : location.href;
}

// --- Profile ---------------------------------------------------------------

export interface ScrapedProfile {
  name: string;
  headline: string | null;
  company: string | null;
  linkedinUrl: string;
  /**
   * About + Experience + Skills, condensed. Null when none of the three could
   * be read — on a people-card surface, or before LinkedIn has hydrated.
   */
  profileText: string | null;
}

/**
 * Locators for LinkedIn's server-driven profile renderer.
 *
 * The profile moved onto SDUI (`data-sdui-screen=
 * "com.linkedin.sdui.flagshipnav.profile.Profile"`) and the previous selectors
 * did not survive it. Measured on a live profile: there is **no `<h1>` on the
 * page at all** — the person's name is an `<h2>` — and the in-page anchor divs
 * this file used to call a URL contract are gone, with
 * `getElementById("about" | "experience" | "skills" | "education")` all
 * returning null. Every read below therefore failed on its first line, which is
 * why a profile visit enriched nothing.
 *
 * What SDUI does give is a stable component id per card, carrying the profile
 * slug: `profileCardsExperienceOnly<slug>`, and `…Topcard` for the header. Ids
 * are preferred over headings because they do not change with the viewer's
 * locale.
 */
const TOPCARD_SELECTOR = '[id*="Topcard"], [componentkey*="Topcard"]';

/**
 * A profile card, located by its SDUI component id first and its heading second.
 *
 * The heading fallback is what keeps this working on the older layout and in
 * non-English locales, where the id prefix may differ but the section still
 * announces itself with an `<h2>`.
 */
function profileCard(idSelector: string, heading: RegExp): Element | null {
  const byId = document.querySelector(idSelector);
  if (byId) return byId;

  for (const title of document.querySelectorAll("h2")) {
    if (!heading.test(normalizeWhitespace(title.textContent ?? ""))) continue;
    return title.closest("section") ?? title.parentElement?.parentElement ?? null;
  }
  return null;
}

/** Rendered lines of a card, deduplicated — LinkedIn renders most text twice. */
function cardLines(el: Element | null): string[] {
  return dedupeAdjacent(blockText(el)?.split("\n") ?? []);
}

export function scrapeProfile(): ScrapedProfile | null {
  // The tab title leads. It is the one string that no amount of DOM re-hashing
  // can move, and the heading that used to be read first is no longer an `h1`.
  const top = cardLines(document.querySelector(TOPCARD_SELECTOR));
  const name = nameFromDocumentTitle() || top[0] || "";
  if (!name) return null;

  return {
    name,
    headline: headlineFromTopCard(top, name),
    company: companyFromTopCard(),
    linkedinUrl: canonicalProfileUrl(),
    profileText: condenseProfile({
      about: aboutText(),
      experience: experienceLines(),
      skills: skillLines(),
    }),
  };
}

/**
 * The headline is the first line of real text under the name in the top card.
 *
 * Read positionally because the class that used to carry it is gone. The layout
 * — name, then one line saying what the person does — is the product, and it
 * outlives any styling. Observed order on a live card:
 *
 *   0 "Hassan Amr"  1 "· 1st"  2 "<headline>"  3 "Cairo, Egypt"  …
 *
 * Line 1 is why `NOT_A_HEADLINE` below now anchors on the separator as well as
 * the digit: the previous pattern started with `\d`, so "· 1st" did not match
 * it and the degree badge would have been stored as the person's headline.
 *
 * Residual limitation, stated rather than papered over: for someone whose
 * headline is genuinely empty the next line is their location, and nothing in
 * the text distinguishes "Cairo, Egypt" from a short headline. LinkedIn
 * substitutes the current role when the field is blank, so this is rare, and a
 * location is at least a true fact about the person rather than an invention.
 */
function headlineFromTopCard(lines: string[], name: string): string | null {
  const start = lines.findIndex((line) => normalizeWhitespace(line).startsWith(name));
  for (const line of lines.slice(start + 1)) {
    const text = normalizeWhitespace(line);
    if (text && !NOT_A_HEADLINE.test(text)) return text;
  }
  return null;
}

/**
 * The employer, taken from the top card's company link.
 *
 * Link-only, deliberately. The card also lists the person's school and their
 * location, and a positional read cannot tell those apart from an employer —
 * whereas a wrong company here is not cosmetic: it feeds the fuzzy matcher that
 * decides which application a contact belongs to, and a bad link silently
 * poisons every future draft for that person. Returning null is safe, because
 * the server falls back to extracting the employer from the headline.
 */
function companyFromTopCard(): string | null {
  const card = document.querySelector(TOPCARD_SELECTOR);
  if (!card) return null;

  for (const link of card.querySelectorAll(COMPANY_LINK)) {
    const name = stripFollowerCount(normalizeWhitespace(link.textContent ?? ""));
    if (name && !NOT_A_COMPANY.test(name)) return name;
  }
  return null;
}

function aboutText(): string | null {
  const lines = withoutHeading(cardLines(profileCard('[id^="profileCardsAbout"]', /^about$/i)), /^about$/i);
  return lines.length > 0 ? lines.join("\n") : null;
}

/** How much of a card is signal before it becomes a wall of text. */
const MAX_EXPERIENCE_LINES = 40;

/**
 * The Experience card, kept as rendered rather than parsed into roles.
 *
 * The previous version reconstructed `{title, company}` pairs from `<li>`
 * elements laid out as title → employer → dates. The live card is the *grouped*
 * shape, where one employer heads several roles:
 *
 *   "Verdant Technology Outsourcing" / "2 yrs" /
 *   "Senior Technical Talent Acquisition" / "Apr 2026 - Present · 6 mos" / …
 *
 * Both shapes are in the wild and the lines do not say which one they are, so
 * any positional parse is a guess that produces a confidently wrong pairing.
 * This text is query-side context handed to the model as REFERENCE ONLY — it is
 * never embedded and never enters the resume corpus — so faithful-but-unparsed
 * beats structured-but-invented.
 */
function experienceLines(): string[] {
  const card = profileCard('[id^="profileCardsExperienceOnly"]', /^experience$/i);
  return withoutHeading(cardLines(card), /^experience$/i)
    .filter((line) => !IS_CARD_CHROME.test(line))
    .slice(0, MAX_EXPERIENCE_LINES);
}

/** How many skills carry signal before the list becomes a keyword dump. */
const MAX_SKILLS = 15;

function skillLines(): string[] {
  const card = profileCard('[id^="profileCardsSkills"]', /^skills$/i);
  return withoutHeading(cardLines(card), /^skills$/i)
    .filter((line) => !IS_CARD_CHROME.test(line) && line.length <= 60)
    .slice(0, MAX_SKILLS);
}

/** The card's own title is not content, and it repeats on every profile. */
function withoutHeading(lines: string[], heading: RegExp): string[] {
  return lines.filter((line) => !heading.test(line));
}

/**
 * Affordances rendered inside a card that read as content.
 *
 * "… more" is the truncation control at the foot of the Experience card and
 * "Show all 12 experiences" is its expanded form; neither says anything about
 * the person, and both would otherwise be handed to the drafting agent as fact.
 */
const IS_CARD_CHROME =
  /^(…\s*more|\.\.\.\s*more|show all|see all|show more|see more|\d+\s*endorsement|endorsed by)/i;

/**
 * LinkedIn titles a profile tab "Ahmed Jamoussi | LinkedIn". Like the job
 * scraper's `parseDocumentTitle`, this is the one string on the page that no
 * amount of DOM re-hashing can take away, so it is the floor under every
 * selector above.
 */
function nameFromDocumentTitle(): string {
  if (!location.pathname.startsWith("/in/")) return "";
  const match = document.title.match(/^(?:\(\d+\)\s*)?(.+?)\s*[|\-–]\s*LinkedIn\s*$/);
  return match?.[1] ? normalizeWhitespace(match[1]) : "";
}

/**
 * Chrome, counters and separators that sit where a headline would.
 *
 * The leading `·` alternative is load-bearing. A live top card renders the
 * degree badge as its own line, "· 1st", and the previous pattern anchored on
 * `\d` — so the badge did not match, and it would have been stored as the
 * person's headline and then handed to the persona classifier.
 *
 * `\+?` after the digit group is the same class of bug: "500+ connections" has
 * a plus between the number and the word, so `[\d,.]+\s*connections?` missed it.
 */
const NOT_A_HEADLINE =
  /^(·|·?\s*\d+(st|nd|rd|th)\+?$|contact info|follow(ing)?|message|more|connect|pending|open to|add profile|enhance profile|resources|[\d,.]+\+?\s*(followers?|connections?)|.*\bmutual connections?$)/i;

/** Strip query params and trailing segments so the URL is a stable identity key. */
export function canonicalProfileUrl(url: string = location.href): string {
  const match = url.match(/linkedin\.com\/in\/([^/?#]+)/);
  return match?.[1]
    ? `https://www.linkedin.com/in/${match[1]}/`
    : url.split("?")[0] ?? url;
}

/** "1st", "2nd", "3rd" and LinkedIn's "3rd+" — however the page spells it. */
const DEGREE_BADGE = /\b(1st|2nd|3rd)\+?\b/;

/**
 * True when the viewed profile is already a 1st-degree connection, which is how
 * we detect that a pending request was accepted without touching any private API.
 *
 * The order of evidence matters, and the previous version had it backwards. It
 * read one class name for the degree badge and, failing that, treated the
 * presence of a Message button as proof of connection — but LinkedIn renders
 * Message on 2nd- and 3rd-degree profiles too (InMail, and anyone with open
 * profile). So a profile the user had merely *invited* reported itself as
 * accepted, on every reload, which is exactly what the panel showed.
 *
 * So: a visible Pending control is decisive proof of the opposite and wins
 * outright; a readable degree badge is the page stating the answer and is
 * trusted next; the Message heuristic survives only for the case where the page
 * states no degree at all.
 */
export function isFirstDegreeConnection(): boolean {
  const card = topCardText();

  // "Pending" only ever appears on a profile whose invitation is outstanding.
  if (/\bpending\b/i.test(card)) return false;

  const badge =
    normalizeWhitespace(
      document.querySelector(".dist-value, .distance-badge .dist-value")?.textContent ?? "",
    ) || card.match(DEGREE_BADGE)?.[0] || "";

  if (badge) return badge.startsWith("1st");

  // Last resort, and only when the page said nothing about the degree.
  return Boolean(document.querySelector("main button[aria-label^='Message']"));
}

/**
 * The profile's top card — the block holding the name, the degree badge and the
 * action buttons.
 *
 * Scoped rather than read off `document.body` because the rest of the page is
 * full of other people: "People also viewed" carries their own degree badges,
 * and a 1st there would otherwise be read as this profile's.
 */
function topCardText(): string {
  const card = document.querySelector(TOPCARD_SELECTOR);
  return normalizeWhitespace((card as HTMLElement | null)?.innerText ?? "");
}
