import "dotenv/config";
import { z } from "zod";

/**
 * `KEY=` in a .env file is an empty string, not an absent variable, and zod's
 * `.optional()` means absent. So `QDRANT_URL=` — which is what a new user gets
 * by copying `.env.example` and filling in only the required keys — failed
 * `.url()` and the server refused to boot on `Invalid url`, naming a store the
 * user had not chosen. The first command in the README crashed.
 *
 * Every consumer of these three tests truthiness (`!env.QDRANT_URL`), so an
 * empty string and an absent variable already mean the same thing downstream.
 * This makes the schema agree with them.
 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8787),
  /**
   * Interface to bind. Defaults to loopback, and should stay there — see the
   * comment above `serve()` in `index.ts` for what binding wider costs.
   *
   * It is configurable for exactly one caller: a container. Inside one,
   * `127.0.0.1` is the *container's* loopback, and Docker forwards a published
   * port to the container's bridge address instead — so a server bound to
   * loopback inside a container accepts nothing and looks dead. The compose
   * file sets `0.0.0.0` here and publishes to `127.0.0.1:8787` on the host,
   * which moves the loopback guarantee from this process to Docker rather than
   * dropping it.
   */
  HOST: z.string().default("127.0.0.1"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  /**
   * Shared secret the extension sends as `x-crm-token`. The proxy holds the
   * OpenAI and service-role keys, so it must not be an open relay.
   */
  CRM_AUTH_TOKEN: z.string().min(16),
  /** Comma-separated extension origins allowed to call this server. */
  ALLOWED_ORIGINS: z.string().default("chrome-extension://*"),
  /** Optional: enables the news-lookup tool for follow-up icebreakers. */
  TAVILY_API_KEY: optional(z.string()),
  /**
   * Where dense vectors live. `pgvector` keeps them beside the rows they
   * describe, which is the default for a reason (see docs/DECISIONS.md
   * ADR-001). Switching does not migrate an existing corpus — re-index through
   * the Vault afterwards.
   */
  VECTOR_STORE: z.enum(["pgvector", "qdrant"]).default("pgvector"),
  QDRANT_URL: optional(z.string().url()),
  QDRANT_API_KEY: optional(z.string()),
})
  /**
   * `VECTOR_STORE=qdrant` without `QDRANT_URL` used to boot cleanly and fail
   * only at the first retrieval, which is a background alarm minutes later —
   * long after the person who edited `.env` has moved on, and with an error
   * that names a store rather than a missing variable. A config mistake has to
   * announce itself at the moment it is made.
   */
  .superRefine((value, ctx) => {
    if (value.VECTOR_STORE === "qdrant" && !value.QDRANT_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["QDRANT_URL"],
        message: "required when VECTOR_STORE=qdrant",
      });
    }
  });

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const missing = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid server environment:\n${missing}\n\nSee server/.env.example`);
}

export const env = parsed.data;
