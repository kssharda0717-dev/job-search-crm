import OpenAI from "openai";
import { EMBEDDING_MODEL } from "@crm/shared";
import { env } from "../env";

export const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

/** OpenAI accepts batched inputs; keep batches modest to stay under token caps. */
const BATCH_SIZE = 64;

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
    });
    // The API preserves input order, but sort defensively rather than trusting it.
    const sorted = [...res.data].sort((a, b) => a.index - b.index);
    out.push(...sorted.map((d) => d.embedding));
  }
  return out;
}

export async function embedText(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text]);
  if (!embedding) throw new Error("Embedding request returned no vector");
  return embedding;
}
