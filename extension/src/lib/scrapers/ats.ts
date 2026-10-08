import type { AtsVendor } from "@crm/shared";
import { blockText, textFrom } from "../dom";

/** Identify the ATS from the hostname so we can pick vendor-specific selectors. */
export function detectVendor(url: string = location.href): AtsVendor {
  const host = safeHost(url);
  if (host.includes("greenhouse.io") || host.includes("grnh.se")) return "greenhouse";
  if (host.includes("lever.co")) return "lever";
  if (host.includes("myworkdayjobs.com") || host.includes("workday.com")) return "workday";
  if (host.includes("ashbyhq.com")) return "ashby";
  if (host.includes("ats.rippling.com")) return "rippling";
  if (host.includes("hibob.com")) return "hibob";
  return "unknown";
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Heuristics for "the application was submitted".
 *
 * Form `submit` events are the primary signal, but Workday and Ashby are SPAs
 * that never fire one, so URL and on-page confirmation text are also checked.
 * Over-detecting is the safer failure: a spurious record is easy for the user
 * to delete, whereas a missed submission loses the JD permanently once they
 * navigate away.
 */

const SUCCESS_URL_PATTERNS = [
  /\/thanks?\b/i,
  /\/confirmation\b/i,
  /\/success\b/i,
  /\/application[_-]?(submitted|complete|received)/i,
  /post[_-]?apply/i,
];

export function isSuccessUrl(url: string = location.href): boolean {
  return SUCCESS_URL_PATTERNS.some((pattern) => pattern.test(url));
}

const CONFIRMATION_PHRASES = [
  "thank you for applying",
  "application submitted",
  "application received",
  "thanks for applying",
  "we've received your application",
  "we have received your application",
  "your application has been submitted",
  "successfully submitted",
  // Rippling: "You have successfully applied for <title>".
  "successfully applied",
  "application complete",
];

export function hasConfirmationText(): boolean {
  // Scoped to the main region and capped in length: scanning the whole body
  // matches privacy-policy boilerplate and fires on the wrong pages.
  const region = document.querySelector("main, [role='main'], .application-confirmation") ?? document.body;
  const text = (region as HTMLElement).innerText?.slice(0, 4000).toLowerCase() ?? "";
  if (CONFIRMATION_PHRASES.some((phrase) => text.includes(phrase))) return true;

  // Sites that render the confirmation outside `main` — or as an image with a
  // caption — still almost always say it in the tab title.
  const title = document.title.toLowerCase();
  return CONFIRMATION_PHRASES.some((phrase) => title.includes(phrase));
}

// --- Job metadata ----------------------------------------------------------

export interface ScrapedAtsJob {
  title: string | null;
  company: string | null;
  location: string | null;
  jdText: string | null;
}

const VENDOR_SELECTORS: Record<
  AtsVendor,
  { title: string[]; company: string[]; location: string[]; jd: string[] }
> = {
  greenhouse: {
    title: [".app-title", "h1.app-title", "h1"],
    company: [".company-name", "span.company-name"],
    location: [".location", ".app-location"],
    jd: ["#content", ".job__description", "#job_description"],
  },
  lever: {
    title: [".posting-headline h2", "h2"],
    company: [".main-header-logo img[alt]", ".posting-headline .company"],
    location: [".posting-categories .location", ".sort-by-time"],
    jd: [".section-wrapper.page-full-width", ".posting-description"],
  },
  workday: {
    title: ["h1[data-automation-id='jobPostingHeader']", "[data-automation-id='jobPostingHeader']"],
    company: ["[data-automation-id='company']"],
    location: ["[data-automation-id='locations']", "[data-automation-id='jobPostingLocation']"],
    jd: ["[data-automation-id='jobPostingDescription']"],
  },
  ashby: {
    title: ["h1", "._title_12ylk_33"],
    company: ["[class*='companyName']", "header img[alt]"],
    location: ["[class*='location']"],
    jd: ["._descriptionText_4fqrp_201", "[class*='description']"],
  },
  rippling: {
    title: ["h1"],
    // The breadcrumb's first link is the employer; the page has no other
    // consistent company element.
    company: ["nav a:first-child", "[class*='breadcrumb'] a:first-child"],
    location: ["[class*='location']"],
    jd: ["main", "article"],
  },
  hibob: {
    title: ["h1"],
    // Nothing on the page names the employer; the subdomain does
    // (`lumera.careers.hibob.com`), which companyFromHost() resolves.
    company: [],
    location: ["h1 + p", "[class*='location']"],
    jd: ["main", "article"],
  },
  unknown: {
    title: ["h1", "h2"],
    company: ["[class*='company']"],
    location: ["[class*='location']"],
    jd: ["main", "#content", "article"],
  },
};

export function scrapeAtsJob(vendor: AtsVendor = detectVendor()): ScrapedAtsJob {
  const selectors = VENDOR_SELECTORS[vendor];

  let jdText: string | null = null;
  for (const selector of selectors.jd) {
    jdText = blockText(document.querySelector(selector));
    if (jdText) break;
  }

  const fromTitle = parseDocumentTitle();

  return {
    // The vendor list can only ever cover the platforms we have seen. On an
    // in-house careers site none of the selectors match, so fall back to the
    // two things every job page has: a tab title and a hostname.
    title: textFrom(selectors.title) ?? fromTitle?.title ?? null,
    company: textFrom(selectors.company) ?? fromTitle?.company ?? companyFromHost(),
    location: textFrom(selectors.location),
    jdText,
  };
}

/**
 * Job pages name the role and usually the employer in the tab title, in one of
 * a handful of shapes: "Senior Engineer - Acme", "Acme | Senior Engineer",
 * "Senior Engineer at Acme". Split on the separator and decide which half is
 * which by asking whether either matches the hostname.
 */
function parseDocumentTitle(): { title: string; company: string | null } | null {
  const raw = document.title.replace(/\s*[-–|]\s*(careers?|jobs?|apply)\s*$/i, "").trim();
  if (!raw) return null;

  const atMatch = raw.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch?.[1] && atMatch[2]) {
    return { title: atMatch[1].trim(), company: atMatch[2].trim() };
  }

  const parts = raw.split(/\s+[-–—|·]\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return parts[0] ? { title: parts[0], company: null } : null;

  const host = companyFromHost()?.toLowerCase();
  // The half that echoes the hostname is the employer; the other is the role.
  const companyIndex = host
    ? parts.findIndex((part) => part.toLowerCase().includes(host))
    : -1;

  if (companyIndex === -1) return { title: parts[0]!, company: parts[parts.length - 1]! };
  return {
    title: parts[companyIndex === 0 ? 1 : 0]!,
    company: parts[companyIndex]!,
  };
}

/**
 * Greenhouse and Lever encode the employer in the subdomain or path, e.g.
 * `boards.greenhouse.io/stripe` or `jobs.lever.co/figma`, which is a more
 * reliable source than the page chrome.
 */
export function companyFromHost(url: string = location.href): string | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);

    // Rippling puts a locale first: /en-GB/jack-westin/jobs/<uuid>
    if (parsed.hostname.includes("ats.rippling.com")) {
      const slug = /^[a-z]{2}(-[A-Za-z]{2})?$/.test(segments[0] ?? "")
        ? segments[1]
        : segments[0];
      return slug ? titleCase(slug.replace(/[-_]/g, " ")) : null;
    }

    // Vendors that put the employer in the first path segment:
    // boards.greenhouse.io/stripe, jobs.lever.co/figma, jobs.ashbyhq.com/notion.
    const segment = segments[0];
    if (
      /(greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com)$/.test(parsed.hostname) &&
      segment &&
      !["embed", "jobs", "applications"].includes(segment)
    ) {
      return titleCase(segment.replace(/[-_]/g, " "));
    }

    return companyFromLabels(parsed.hostname);
  } catch {
    return null;
  }
}

/** Hostname labels that describe the page's purpose, never the employer. */
const GENERIC_LABELS = new Set([
  "www",
  "jobs",
  "job",
  "boards",
  "job-boards",
  "careers",
  "career",
  "apply",
  "ats",
  "recruiting",
  "recruitment",
  "talent",
  "hiring",
  "my",
  "app",
  "secure",
  "portal",
  "com",
  "co",
  "org",
  "net",
  "io",
  // ATS vendors, so `jobs.ashbyhq.com` never reads as an employer called Ashby.
  "greenhouse",
  "lever",
  "workday",
  "myworkdayjobs",
  "ashbyhq",
  "rippling",
  "hibob",
  "smartrecruiters",
  "workable",
  "teamtailor",
  "personio",
  "recruitee",
  "bamboohr",
  "jobvite",
  "icims",
  "taleo",
  "breezy",
]);

/**
 * Pull the employer out of a hostname.
 *
 * `lumera.careers.hibob.com` is the employer on a vendor's domain, while
 * `careers.acme.com` and `www.acme.com` are the employer *behind* a generic
 * label. Taking the first label that is not a generic one covers both, and
 * dropping the public-suffix labels stops "com" from ever winning.
 */
function companyFromLabels(hostname: string): string | null {
  const labels = hostname.toLowerCase().split(".");
  // Two-part suffixes like .co.uk leave one extra label; the generic set covers
  // "co" and "com" so the country code is all that needs removing here.
  const meaningful = labels.filter((label) => !GENERIC_LABELS.has(label) && label.length > 2);
  const chosen = meaningful[0];
  return chosen ? titleCase(chosen.replace(/[-_]/g, " ")) : null;
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}
