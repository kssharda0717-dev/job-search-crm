/**
 * Canonical vault file names.
 *
 * Users name their tailored resumes anything — "resume.pdf", "CV final v3.pdf",
 * "Untitled.pdf" — so the name they picked carries no information once a dozen
 * of them are in the vault. The vault renames every upload to
 * `<Name>_<Company>_<Role>.pdf` so the file is self-describing wherever it ends
 * up, including after the user downloads it again.
 *
 * Pure and dependency-free so it can be unit tested; nothing here may import
 * `env`, which throws at import time.
 */
export function canonicalResumeName(params: {
  userName?: string | null;
  company?: string | null;
  title?: string | null;
  /** Used verbatim when there is not enough context to build a better name. */
  fallback: string;
}): string {
  const company = slugPart(params.company);
  const title = slugPart(params.title);

  // The company and the role are what make the file self-describing; without
  // either of them the original name at least matches what the user sees in
  // their downloads folder.
  if (!company || !title) return params.fallback;

  // The user's name is the one part that may legitimately be missing — it comes
  // from an extension setting most people never open. Dropping the rename
  // entirely when it is unset defeated the whole point: every vault file kept
  // whatever the ATS called it. Degrade to `Company_Role.pdf` instead.
  const parts = [slugPart(params.userName), company, title].filter(
    (part): part is string => part !== null,
  );

  return `${parts.join("_")}.pdf`;
}

/**
 * One path-safe segment: words joined by hyphens, so underscores stay
 * unambiguous as the separator between name, company and role.
 */
function slugPart(value?: string | null): string | null {
  const words = (value ?? "")
    // Decompose, then drop the combining marks, so "López" becomes "Lopez"
    // rather than splitting into "Lo" and "pez" at the orphaned accent.
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    // Keep letters and digits from any script; everything else is a separator.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return null;

  // Cap the segment so three long ones cannot exceed filesystem name limits.
  return words.join("-").slice(0, 60).replace(/-+$/, "");
}
