// `./constants`, never `./api`. This module is imported by the LinkedIn content
// script, and `./api` builds zod schemas at module scope: importing it put zod
// in the content-script bundle, where Parcel emitted a stub for it. The script
// then threw `(0, o.z).enum is not a function` on load, and every capture,
// profile read and enrichment on LinkedIn silently stopped happening.
import { MAX_PROFILE_TEXT_CHARS } from "./constants";

/**
 * Assemble the recipient-profile text that steers retrieval and drafting.
 *
 * Pure, and shared rather than living in the extension, for two reasons: the
 * server re-runs `capProfileText` on anything it is handed (a content script is
 * not a trusted writer), and DOM-walking code cannot be unit tested here while
 * this can.
 */

/**
 * Collapse LinkedIn's screen-reader duplication.
 *
 * Every visible string on a profile is rendered twice — once in a
 * `span[aria-hidden]` and once in a visually-hidden span — and the second copy
 * is clipped with CSS rather than `display:none`, so `innerText` returns both.
 * Left alone, a profile arrives at the embedding model saying everything twice,
 * which is not merely untidy: the sparse leg's term frequencies double and the
 * dense vector is pulled towards whatever the duplication emphasised.
 *
 * Consecutive-only, deliberately. A profile legitimately repeats a company name
 * across several roles, and dropping every later occurrence would erase the
 * career progression that makes the text worth having.
 */
export function dedupeAdjacent(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const text = line.replace(/\s+/g, " ").trim();
    if (text && text !== out[out.length - 1]) out.push(text);
  }
  return out;
}

/**
 * Trim to the wire limit on a line boundary.
 *
 * Cutting mid-sentence would hand the model a truncated claim about the
 * recipient, and a half-sentence is exactly the kind of thing that gets
 * confidently completed into something the profile never said.
 */
export function capProfileText(text: string, max = MAX_PROFILE_TEXT_CHARS): string {
  if (text.length <= max) return text;

  const kept: string[] = [];
  let used = 0;
  for (const line of text.split("\n")) {
    if (used + line.length + 1 > max) break;
    kept.push(line);
    used += line.length + 1;
  }

  // A single opening line longer than the whole budget is the one case with no
  // boundary to cut on; a hard slice beats returning nothing.
  return kept.length > 0 ? kept.join("\n") : text.slice(0, max);
}

export interface ProfileSections {
  about: string | null;
  /** Most recent first: "Senior Recruiter — Verdant". */
  experience: string[];
  skills: string[];
}

/**
 * Label the sections so the retrieval query and the agent prompt can tell a
 * self-description from a job history.
 *
 * Returns null rather than an empty string when nothing was readable, because
 * "" and "we never looked" must not be the same value in the database — the
 * panel prompts on one and not the other.
 */
export function condenseProfile(sections: ProfileSections): string | null {
  const parts: string[] = [];

  if (sections.about?.trim()) {
    parts.push(`About: ${dedupeAdjacent(sections.about.split("\n")).join(" ")}`);
  }

  const experience = dedupeAdjacent(sections.experience);
  if (experience.length > 0) {
    parts.push(`Experience: ${experience.join("; ")}`);
  }

  const skills = dedupeAdjacent(sections.skills);
  if (skills.length > 0) {
    parts.push(`Skills: ${skills.join(", ")}`);
  }

  if (parts.length === 0) return null;
  return capProfileText(parts.join("\n"));
}
