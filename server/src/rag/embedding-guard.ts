/**
 * Refuse to search a corpus that a different embedding model wrote.
 *
 * Query-side and document-side embeddings must come from the same model.
 * Cosine distance between vectors from two different models is a number, not a
 * similarity — nothing throws, nothing logs, and retrieval quietly degrades to
 * noise. That is the class of failure `docs/EVALUATION.md` §1 exists to catch,
 * except this one would not even show up as a dead leg: both legs keep
 * returning rows, the drafts keep reading fine, and the evidence is wrong.
 *
 * A *width* change is caught for free — `vector(1536)` rejects the insert and
 * you find out in the first second. The dangerous case is a same-width swap;
 * `text-embedding-ada-002` is also 1536. Nothing catches that unless something
 * compares the names, which is what this does.
 *
 * Its own module, rather than living next to `embedTexts`, because
 * `embeddings.ts` constructs the OpenAI client from `env` at import time and
 * `env` throws when unset. A rule worth enforcing is worth testing, and this
 * one is testable only if importing it costs nothing.
 */

/**
 * @param stored  Distinct model names behind this job's stored vectors.
 * @param current The model the query is about to be embedded with.
 * @returns An explanation naming both models and the way out, or `null` when
 *   the corpus is safe to search.
 *
 * An **empty** corpus is deliberately not a mismatch. "No resume indexed for
 * this application" is a state the agent already handles explicitly, with a
 * tool response that forbids making any claim about the candidate. Promoting it
 * to a hard error here would turn a degraded draft into a failed one for every
 * contact whose application has no resume — which is the common case early on.
 */
export function embeddingMismatch(stored: string[], current: string): string | null {
  if (stored.length === 0) return null;
  if (stored.length === 1 && stored[0] === current) return null;

  const names = stored.map((model) => `"${model}"`).join(", ");
  return (
    `This application's resume was indexed with ${names}, but the server embeds ` +
    `queries with "${current}". Vectors from different models are not ` +
    `comparable, so this search would return plausible-looking nonsense rather ` +
    `than fail. Re-index the resume through the Document Vault, or set ` +
    `EMBEDDING_MODEL back to the model that indexed it.`
  );
}
