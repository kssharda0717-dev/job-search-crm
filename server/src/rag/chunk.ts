import { CHUNK_OVERLAP_CHARS, CHUNK_TARGET_CHARS } from "@crm/shared";

/**
 * Headers a resume writes in title case rather than shouting them.
 *
 * Needed because the shape rule below keys on an uppercase run, and a resume
 * that writes "Core Skills" would otherwise have no boundary at all — the
 * skills wall would pack into the same chunk as the last achievement bullet,
 * which is the exact failure this module was rewritten to stop.
 */
const KNOWN_HEADERS = new Set([
  "summary",
  "professional summary",
  "career summary",
  "profile",
  "objective",
  "experience",
  "work experience",
  "professional experience",
  "employment",
  "employment history",
  "education",
  "skills",
  "core skills",
  "key skills",
  "technical skills",
  "core competencies",
  "certifications",
  "licenses and certifications",
  "projects",
  "key projects",
  "publications",
  "awards",
  "achievements",
  "languages",
  "interests",
  "volunteer experience",
  "references",
]);

/** The dashes and pipes a resume puts between an employer and a role. */
const SEPARATOR = /\s[—–|·]\s|\s-\s/;

/**
 * The header a line announces, or `null` if it is body text.
 *
 * Two shapes, keyed on an uppercase run rather than on a vocabulary, because
 * every resume invents its own section names:
 *
 *   SKILLS                                              → "SKILLS"
 *   NORTHWIND LOGISTICS — Staff Engineer (2021—present) → the whole line
 *
 * The uppercase test applies only to the part before the separator, since the
 * role half is normally title case. The two-word-or-six-character floor is what
 * keeps a bullet like "AWS — migrated the fleet" from being read as a section
 * and shattering the surrounding block into one chunk per line.
 */
export function sectionHeader(line: string): string | null {
  const label = line.trim().replace(/[:\s]+$/, "");
  if (label.length === 0 || label.length > 90) return null;
  if (KNOWN_HEADERS.has(label.toLowerCase())) return label;

  const lead = label.split(SEPARATOR)[0]!.trim();
  if (!/[A-Z]/.test(lead)) return null;
  if (lead !== lead.toUpperCase()) return null;

  const words = lead.split(/\s+/);
  if (words.length > 7) return null;
  if (words.length < 2 && lead.length < 6) return null;

  return label;
}

/**
 * Split resume text into retrieval units that know which section they came
 * from.
 *
 * The previous version split on `/\r?\n/` and packed lines until it ran out of
 * budget, which made a PDF line wrap the only boundary it could see. On a real
 * resume that put three unrelated facts *and* the CORE SKILLS wall into chunk
 * one, and that chunk was then cited by every draft the system had ever
 * written. Two separate defences failed as a consequence: the LLM reranker
 * grades a chunk as a whole, so it could not score the wall zero without
 * discarding the achievements welded to it; and `ungroundedNumbers` asks only
 * whether a figure appears somewhere in the evidence, so a CSAT number sitting
 * three lines from an unrelated project read as support for it.
 *
 * So a section header is a hard boundary: it flushes whatever is open, and the
 * overlap is *not* carried across it, because an overlap that straddles two
 * sections reintroduces exactly the adjacency the boundary exists to remove.
 * Every chunk then carries its header as a prefix, which costs a few tokens and
 * buys a unit that can be judged on its own — "SKILLS" in front of a comma list
 * is the signal that lets a reranker rank it last.
 */
export function chunkResumeText(
  text: string,
  targetChars = CHUNK_TARGET_CHARS,
  overlapChars = CHUNK_OVERLAP_CHARS,
): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return [];

  const chunks: string[] = [];
  let section: string | null = null;
  let current: string[] = [];
  let currentLen = 0;
  /**
   * Lines added since the last flush. Without this the final flush can emit a
   * chunk consisting purely of carried-over overlap, duplicating content that
   * already sits at the end of the previous chunk.
   */
  let freshLines = 0;

  /** What the section prefix costs against the per-chunk budget. */
  const prefixLen = () => (section === null ? 0 : section.length + 1);
  const budget = () => Math.max(1, targetChars - prefixLen());

  const emit = (body: string) => {
    chunks.push(section === null ? body : `${section}\n${body}`);
  };

  const flush = (carryOverlap: boolean) => {
    if (current.length > 0 && freshLines > 0) emit(current.join("\n"));

    if (!carryOverlap) {
      current = [];
      currentLen = 0;
      freshLines = 0;
      return;
    }

    // Seed the next chunk with trailing lines worth roughly `overlapChars`,
    // so a bullet on a boundary keeps its surrounding context.
    const carry: string[] = [];
    let carryLen = 0;
    for (let i = current.length - 1; i >= 0; i--) {
      const line = current[i]!;
      if (carryLen + line.length > overlapChars) break;
      carry.unshift(line);
      carryLen += line.length + 1;
    }
    current = carry;
    currentLen = carryLen;
    freshLines = 0;
  };

  for (const line of lines) {
    const header = sectionHeader(line);
    if (header !== null) {
      flush(false);
      section = header;
      continue;
    }

    // Only a line over the absolute target is cut, never one that merely
    // overflows the budget the header left behind. Splitting mid-line loses the
    // phrase a labelled eval case is pinned to, and a header is at most 90
    // characters of slack.
    if (line.length > targetChars) {
      flush(false);
      const stride = budget();
      for (let i = 0; i < line.length; i += stride) emit(line.slice(i, i + stride));
      continue;
    }

    if (currentLen + line.length > budget()) flush(true);
    current.push(line);
    currentLen += line.length + 1;
    freshLines++;
  }

  flush(false);
  return chunks;
}
