import type { MessageType } from "@crm/shared";

/**
 * Two decisions about *whether* to draft, kept apart from the drafting itself.
 *
 * `draft.ts` imports `db`, `openai` and `tools.ts`, all of which reach `env`,
 * which throws at import when a variable is missing. ESM evaluates that whole
 * graph before a test's first assertion, so importing these two predicates from
 * `draft.ts` meant the suite could not run without a configured `server/.env` —
 * it passed on the author's machine and failed in CI, where no `.env` exists.
 * See `docs/RULES.md`: pure logic goes where nothing in its import graph
 * touches `env`.
 */

/**
 * True when a waiting draft was written before the recipient's profile was read,
 * and so cannot have been built from it.
 *
 * Compared as instants, never as strings: PostgREST renders `timestamptz` in
 * whatever offset the connection asks for, so a string compare reads the wall
 * clock rather than the instant and `11:00+00:00` sorts before `14:00+05:30`
 * despite being two and a half hours later. That exact mistake already shipped
 * once in `services/followup.ts`.
 *
 * An unreadable or absent timestamp means "no evidence the draft is stale" —
 * keep the waiting draft rather than silently regenerating on every click.
 */
export function draftPredatesProfile(
  profileReadAt: string | null | undefined,
  draftCreatedAt: string,
): boolean {
  if (!profileReadAt) return false;
  const read = Date.parse(profileReadAt);
  const drafted = Date.parse(draftCreatedAt);
  if (Number.isNaN(read) || Number.isNaN(drafted)) return false;
  return read > drafted;
}

/**
 * Message types that happen at most once per contact.
 *
 * You introduce yourself to someone once. A second "I recently applied for the
 * Oracle Fusion HCM role" to a person who already received it, and replied or
 * did not, is not a draft — it is the system having forgotten. A `follow_up` is
 * deliberately excluded: chasing twice is a legitimate thing to want.
 */
const ONCE_PER_CONTACT: ReadonlySet<MessageType> = new Set([
  "connection_note",
  "initial_outreach",
]);

export function isOncePerContact(type: MessageType): boolean {
  return ONCE_PER_CONTACT.has(type);
}
