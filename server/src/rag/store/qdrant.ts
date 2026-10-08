import { QdrantClient } from "@qdrant/js-client-rest";
import { EMBEDDING_DIMENSIONS } from "@crm/shared";
import type { RankedChunk } from "../fuse";
import { PgVectorStore } from "./pgvector";
import type { ChunkRecord, VectorStore } from "./types";

const COLLECTION = "resume_chunks";

interface ChunkPayload {
  chunk_id: string;
  resume_id: string;
  job_id: string;
  chunk_index: number;
  chunk_text: string;
}

/**
 * Qdrant for the dense leg, Postgres for everything else.
 *
 * This exists to keep the `VectorStore` interface honest — an abstraction with
 * one implementation is a guess about what varies. Writing the second one is
 * what proved the interface could not expose scores (Qdrant returns cosine
 * similarity, Postgres returns cover density) and could not assume the store
 * owns the text.
 *
 * The sparse leg is deliberately delegated to Postgres rather than reimplemented
 * on Qdrant's sparse-vector support. Postgres is the system of record for chunk
 * text regardless — the vault, the resume rows and the cascade on delete all
 * live there — so its `tsvector` is free and already tuned (see migration 0005).
 * Duplicating lexical search into Qdrant would mean two indexes that can
 * disagree about what the resume says, which is the failure mode this whole
 * feature exists to prevent.
 *
 * The cost of that choice, stated plainly: this store needs both services up,
 * and a write is not atomic across them. `upsertChunks` writes Postgres first,
 * so a Qdrant failure leaves the text searchable and the dense leg empty rather
 * than the other way round — a degraded draft rather than a draft citing a
 * bullet that no longer exists.
 */
export class QdrantStore implements VectorStore {
  readonly name = "qdrant";

  private readonly client: QdrantClient;
  private readonly postgres = new PgVectorStore();
  private ready: Promise<void> | null = null;

  constructor(params: { url: string; apiKey?: string }) {
    this.client = new QdrantClient({ url: params.url, apiKey: params.apiKey });
  }

  /**
   * Created on first use rather than at construction: `env.ts` is imported at
   * startup, and a server that cannot boot because a secondary vector store is
   * down is worse than one whose drafting degrades.
   */
  private ensureCollection(): Promise<void> {
    // Only a *fulfilled* promise is cached. `??=` alone cached the rejection
    // too, so one transient Qdrant outage during startup disabled the dense leg
    // for the lifetime of the process, and every subsequent draft was served by
    // the sparse leg alone with no error to explain it.
    this.ready ??= (async () => {
      const existing = await this.client.getCollections();
      if (existing.collections.some((c) => c.name === COLLECTION)) return;

      await this.client.createCollection(COLLECTION, {
        vectors: { size: EMBEDDING_DIMENSIONS, distance: "Cosine" },
      });
      // Retrieval is always scoped to one application. Without an index on
      // job_id the filter is a full scan of every resume the user ever sent.
      await this.client.createPayloadIndex(COLLECTION, {
        field_name: "job_id",
        field_schema: "keyword",
      });
      await this.client.createPayloadIndex(COLLECTION, {
        field_name: "resume_id",
        field_schema: "keyword",
      });
    })().catch((err: unknown) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  async upsertChunks(chunks: ChunkRecord[]): Promise<void> {
    if (chunks.length === 0) return;
    await this.postgres.upsertChunks(chunks);
    await this.ensureCollection();

    // Postgres generated the ids, so read them back rather than minting a
    // second identity for the same chunk. `fuseRrf` dedupes by `chunk_id`, so
    // the same chunk under two identities would be counted twice and could beat
    // a genuine second result.
    const stored = await this.postgres.chunksForResume(chunks[0]!.resumeId);
    const embeddingByIndex = new Map(chunks.map((c) => [c.chunkIndex, c.embedding]));
    const jobId = chunks[0]!.jobId;

    // A chunk Postgres holds but this batch has no embedding for cannot be
    // written with an empty vector: Qdrant rejects the whole upsert on a
    // dimension mismatch, so one stale row would fail the entire resume.
    // Skipping it leaves that chunk reachable on the sparse leg, which is the
    // same degradation this class already documents for a partial write.
    const points = stored.flatMap((chunk) => {
      const vector = embeddingByIndex.get(chunk.chunk_index);
      if (!vector) return [];
      return [{
        id: chunk.chunk_id,
        vector,
        payload: {
          chunk_id: chunk.chunk_id,
          resume_id: chunk.resume_id,
          job_id: jobId,
          chunk_index: chunk.chunk_index,
          chunk_text: chunk.chunk_text,
        } satisfies ChunkPayload,
      }];
    });

    if (points.length === 0) return;
    await this.client.upsert(COLLECTION, { wait: true, points });
  }

  /**
   * Delegated to Postgres, which is where the model name is written — by the
   * `postgres.upsertChunks` call above, in the same operation that produced the
   * vectors Qdrant holds. The two cannot disagree about which model wrote a
   * chunk without that call having half-failed, which is the same window as the
   * non-atomic write documented on this class.
   */
  embeddingModels(jobId: string | null): Promise<string[]> {
    return this.postgres.embeddingModels(jobId);
  }

  async deleteResumeChunks(params: { resumeId: string; jobId: string }): Promise<void> {
    await this.ensureCollection();
    await this.client.delete(COLLECTION, {
      wait: true,
      filter: { must: [{ key: "resume_id", match: { value: params.resumeId } }] },
    });
    await this.postgres.deleteResumeChunks(params);
  }

  async denseSearch(params: {
    jobId: string | null;
    embedding: number[];
    limit: number;
  }): Promise<RankedChunk[]> {
    await this.ensureCollection();
    const response = await this.client.query(COLLECTION, {
      query: params.embedding,
      limit: params.limit,
      // No filter at all when there is no application to scope to. An empty
      // `must` is not the same thing — Qdrant treats it as a filter that matches
      // nothing, which would silently reproduce the zero-evidence bug this
      // carve-out exists to fix.
      ...(params.jobId === null
        ? {}
        : { filter: { must: [{ key: "job_id", match: { value: params.jobId } }] } }),
      with_payload: true,
    });

    return response.points.map((point) => {
      const payload = point.payload as unknown as ChunkPayload;
      return {
        chunk_id: payload.chunk_id,
        resume_id: payload.resume_id,
        chunk_index: payload.chunk_index,
        chunk_text: payload.chunk_text,
      };
    });
  }

  sparseSearch(params: {
    jobId: string | null;
    queryText: string;
    limit: number;
  }): Promise<RankedChunk[]> {
    return this.postgres.sparseSearch(params);
  }
}
