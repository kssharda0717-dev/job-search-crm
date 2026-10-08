import { db } from "../../db";
import type { RankedChunk } from "../fuse";
import type { ChunkRecord, VectorStore } from "./types";

interface SearchRow {
  chunk_id: string;
  resume_id: string;
  chunk_index: number;
  chunk_text: string;
}

/**
 * The default store: vectors live in the same Postgres as the rows they belong
 * to, so retrieval can be scoped with `where job_id = …` instead of a metadata
 * filter, and a resume and its vectors cannot get out of sync — deleting a
 * resume cascades to its chunks in the same transaction.
 */
export class PgVectorStore implements VectorStore {
  readonly name = "pgvector";

  async upsertChunks(chunks: ChunkRecord[]): Promise<void> {
    if (chunks.length === 0) return;

    // A real upsert, matching the method's name. It was a bare `insert`, which
    // meant a retry after a partial write duplicated chunk indices — and a
    // duplicated passage wins hybrid search, because both legs return it and
    // RRF adds the two reciprocal ranks together. Migration 0009 added the
    // unique key this conflict target needs.
    const { error } = await db.from("resume_chunks").upsert(
      chunks.map((chunk) => ({
        resume_id: chunk.resumeId,
        job_id: chunk.jobId,
        chunk_index: chunk.chunkIndex,
        chunk_text: chunk.chunkText,
        // pgvector's text input format is identical to a JSON array.
        embedding: JSON.stringify(chunk.embedding),
        embedding_model: chunk.embeddingModel,
      })),
      { onConflict: "resume_id,chunk_index" },
    );
    if (error) throw new Error(`Upsert resume chunks: ${error.message}`);
  }

  async embeddingModels(jobId: string | null): Promise<string[]> {
    // Deduped in TS rather than with `distinct`: PostgREST has no clean way to
    // express it, and a job has a handful of chunks, not a table scan.
    const query = db.from("resume_chunks").select("embedding_model");
    const { data, error } = await (jobId === null ? query : query.eq("job_id", jobId)).not(
      "embedding",
      "is",
      null,
    );
    if (error) throw new Error(`Load embedding models: ${error.message}`);

    return [
      ...new Set(
        (data ?? [])
          .map((row) => row.embedding_model as string | null)
          .filter((model): model is string => Boolean(model)),
      ),
    ];
  }

  /**
   * Read back a resume's chunks in index order, with the ids Postgres
   * generated. A secondary store has to mirror those ids rather than mint its
   * own: `fuseRrf` dedupes by `chunk_id`, so the same chunk under two
   * identities would be counted twice and could beat a genuine second result.
   */
  async chunksForResume(resumeId: string): Promise<RankedChunk[]> {
    const { data, error } = await db
      .from("resume_chunks")
      .select("id, resume_id, chunk_index, chunk_text")
      .eq("resume_id", resumeId)
      .order("chunk_index", { ascending: true });
    if (error) throw new Error(`Load resume chunks: ${error.message}`);

    return (data ?? []).map((row) => ({
      chunk_id: row.id as string,
      resume_id: row.resume_id as string,
      chunk_index: row.chunk_index as number,
      chunk_text: row.chunk_text as string,
    }));
  }

  async deleteResumeChunks(params: { resumeId: string }): Promise<void> {
    const { error } = await db
      .from("resume_chunks")
      .delete()
      .eq("resume_id", params.resumeId);
    if (error) throw new Error(`Delete resume chunks: ${error.message}`);
  }

  async denseSearch(params: {
    jobId: string | null;
    embedding: number[];
    limit: number;
  }): Promise<RankedChunk[]> {
    const { data, error } = await db.rpc("dense_search_resume_chunks", {
      p_job_id: params.jobId,
      p_query_embedding: JSON.stringify(params.embedding),
      p_limit: params.limit,
    });
    if (error) throw new Error(`dense_search_resume_chunks: ${error.message}`);
    return toRankedChunks(data);
  }

  async sparseSearch(params: {
    jobId: string | null;
    queryText: string;
    limit: number;
  }): Promise<RankedChunk[]> {
    const { data, error } = await db.rpc("sparse_search_resume_chunks", {
      p_job_id: params.jobId,
      p_query_text: params.queryText,
      p_limit: params.limit,
    });
    if (error) throw new Error(`sparse_search_resume_chunks: ${error.message}`);
    return toRankedChunks(data);
  }
}

export function toRankedChunks(data: unknown): RankedChunk[] {
  return ((data ?? []) as SearchRow[]).map((row) => ({
    chunk_id: row.chunk_id,
    resume_id: row.resume_id,
    chunk_index: row.chunk_index,
    chunk_text: row.chunk_text,
  }));
}
