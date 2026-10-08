import { env } from "../../env";
import { PgVectorStore } from "./pgvector";
import { QdrantStore } from "./qdrant";
import type { VectorStore } from "./types";

export type { ChunkRecord, VectorStore } from "./types";
export { PgVectorStore } from "./pgvector";
export { QdrantStore } from "./qdrant";

function build(): VectorStore {
  if (env.VECTOR_STORE === "qdrant") {
    if (!env.QDRANT_URL) {
      throw new Error("VECTOR_STORE=qdrant requires QDRANT_URL");
    }
    return new QdrantStore({ url: env.QDRANT_URL, apiKey: env.QDRANT_API_KEY });
  }
  return new PgVectorStore();
}

/**
 * The store the running server indexes into and retrieves from.
 *
 * Switching this changes where vectors live but not what is indexed, so an
 * existing corpus does not migrate itself — re-index through the Vault, or the
 * new store answers every query with nothing. That failure is silent in exactly
 * the way a dead retrieval leg is silent, which is why `pnpm eval:retrieval`
 * prints the store name at the top of its report.
 */
export const vectorStore: VectorStore = build();
