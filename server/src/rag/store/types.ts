import type { RankedChunk } from "../fuse";

/** One chunk on its way into the index. */
export interface ChunkRecord {
  resumeId: string;
  jobId: string;
  chunkIndex: number;
  chunkText: string;
  embedding: number[];
  /** Which model produced `embedding`. Stored so a later query can refuse to
   *  compare against vectors a different model wrote. */
  embeddingModel: string;
}

/**
 * The retrieval surface the drafting agent depends on.
 *
 * The two legs are separate methods rather than one `hybridSearch` because
 * fusion has to happen somewhere both stores can reach, and because measuring a
 * leg is the only way to tell "fusion is mis-weighted" apart from "the sparse
 * leg matched nothing". The second failure is the one that actually happened
 * and went unnoticed on every draft ever generated: `websearch_to_tsquery` ANDs
 * bare words, so a space-joined keyword list matched no rows and the hybrid
 * search was silently dense-only. A single fused number cannot show that.
 *
 * Every method is scoped to one `jobId`. Retrieval must never cross
 * applications — the whole point of the vault is that a draft cites the resume
 * that was actually sent for that role.
 *
 * The single carve-out is `jobId: null`, which means "there is no application".
 * A contact recovered from the Sent-invitations page has a name and a headline
 * and no employer, so nothing can be matched to a job, and PRD §6 forbids
 * opening their profile in bulk to find one. Scoping to a job that does not
 * exist returned zero chunks and the agent wrote from nothing. Null therefore
 * searches the whole corpus — which is the candidate's own resumes and nobody
 * else's, so no application is being crossed; there is none to cross. Callers
 * must say so in the prompt: evidence found this way was tailored for a
 * different role and the draft may not imply otherwise.
 */
export interface VectorStore {
  /** Identifies the backing store in eval output and logs. */
  readonly name: string;

  upsertChunks(chunks: ChunkRecord[]): Promise<void>;

  /**
   * The distinct embedding models behind this job's stored vectors.
   *
   * Normally one: `indexResume` writes every chunk for a job in a single call.
   * More than one, or one that is not the model the server is about to embed
   * the query with, means the corpus and the query are in different vector
   * spaces and the search is meaningless. The caller refuses rather than
   * returning the nonsense.
   */
  embeddingModels(jobId: string | null): Promise<string[]>;

  /**
   * Remove every vector belonging to a resume. Called before a re-index, so a
   * draft can never cite a bullet from a resume the user replaced.
   */
  deleteResumeChunks(params: { resumeId: string; jobId: string }): Promise<void>;

  /** Nearest neighbours by embedding similarity, best first. */
  denseSearch(params: {
    jobId: string | null;
    embedding: number[];
    limit: number;
  }): Promise<RankedChunk[]>;

  /** Lexical matches ranked by length-normalised cover density, best first. */
  sparseSearch(params: {
    jobId: string | null;
    queryText: string;
    limit: number;
  }): Promise<RankedChunk[]>;
}
