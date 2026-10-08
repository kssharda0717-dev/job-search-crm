import type { Message } from "@crm/shared";

/**
 * The conversation so far, rendered for the drafting prompt.
 *
 * Its own file, not a helper inside `draft.ts`: that module imports
 * `rag/embeddings`, which builds the OpenAI client from `env` at module load,
 * so nothing reachable from it can be unit tested.
 *
 * ---
 *
 * A follow-up was being written with no knowledge of the message it follows.
 * The task prompt carried the recipient, the job and the resume, and the only
 * route to "what have I already said to this person" was an optional tool call
 * (`check_company_message_history`) that the model frequently skipped — and
 * which scopes by *company* and caps at ten rows, so on a company where the
 * user has messaged several people this contact's own thread can fall out of it
 * entirely.
 *
 * The result, from a real run on 2026-10-01. Opener sent 2026-09-25:
 *
 *   "...taking loosely defined problems from users and developing tested,
 *    working products quickly, including a three-app platform built in three
 *    days. I'm curious, how does your team ensure that the AI solutions you
 *    build are aligned with the specific needs of government clients?"
 *
 * The follow-up it then produced:
 *
 *   "...I kept client satisfaction above 9.5/10 for nine straight months by
 *    translating user needs into a working product quickly. I'm interested in
 *    how your team approaches building custom AI solutions for government
 *    clients. Do you have any insights on that?"
 *
 * Same pitch, same question, reworded. To a recipient who has both messages in
 * one thread that does not read as a nudge; it reads as a bot that forgot. The
 * thread is not optional context for a follow-up — it *is* the context — so it
 * goes in the prompt unconditionally rather than behind a tool the model has to
 * think to call.
 */

/** Oldest first: a thread reads forwards, and the last line is what to avoid repeating. */
export function priorThread(messages: Message[]): Message[] {
  return messages
    .filter((m) => m.sent_at)
    .sort((a, b) => Date.parse(a.sent_at!) - Date.parse(b.sent_at!));
}

function daysAgo(iso: string, now: number): string {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return "earlier";
  if (days <= 0) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/**
 * Render the thread, or null when nothing has been sent to this person yet.
 *
 * Null rather than an empty block, because "we have never spoken" and "here is
 * what you said" must not look the same to the model — an empty <thread/> reads
 * as a thread with nothing worth repeating in it, which is the opposite of the
 * truth.
 *
 * `sent_text` is preferred over `draft_text` deliberately: the user edits drafts
 * in LinkedIn's composer before sending, and what the recipient actually read is
 * the only thing a follow-up must avoid repeating.
 */
export function threadBlock(messages: Message[], now = Date.now()): string | null {
  const thread = priorThread(messages);
  if (thread.length === 0) return null;

  const lines = thread.map((m) => {
    const label = m.type.replace(/_/g, " ");
    return `[${label}, sent ${daysAgo(m.sent_at!, now)}]\n${m.sent_text ?? m.draft_text}`;
  });

  return [
    "WHAT YOU HAVE ALREADY SENT THIS PERSON. They can see all of it in one",
    "thread, so anything you repeat reads as not having read your own messages:",
    "<thread>",
    ...lines,
    "</thread>",
    "",
    "The new message must not reuse the opening line, must not restate the same",
    "achievement or figure, and must not ask the same question in different",
    "words. If the strongest evidence was already used, use the next one. If the",
    "question was already asked, acknowledge that you asked it and ask something",
    "narrower, or make the message a short piece of new information with no",
    "question at all. Do not re-introduce yourself; they know who you are.",
  ].join("\n");
}
