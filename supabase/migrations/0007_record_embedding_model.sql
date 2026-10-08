-- ---------------------------------------------------------------------------
-- Record which embedding model produced each stored vector.
--
-- Query-side and document-side embeddings must come from the same model. Today
-- they do: `rag/embeddings.ts` is the only caller on both paths and it imports
-- one constant. But that invariant is held by nobody having changed the
-- constant yet, which is not an invariant — it is luck.
--
-- The dangerous case is not a dimension change; `vector(1536)` rejects that at
-- the insert and you find out immediately. It is swapping to a *different model
-- of the same width* — `text-embedding-ada-002` is also 1536 — where every
-- insert and every query succeeds, cosine distance keeps returning numbers, and
-- the numbers are meaningless. Retrieval degrades to noise with no error
-- anywhere, which is the exact failure mode `docs/EVALUATION.md` §1 was written
-- about.
--
-- Storing the name lets the server refuse to search a corpus it cannot compare
-- against, instead of silently returning nonsense.
-- ---------------------------------------------------------------------------

alter table resume_chunks
  add column if not exists embedding_model text;

-- Backfill with the literal name rather than a default, on purpose.
--
-- Every row that exists was written by a build in which EMBEDDING_MODEL was
-- 'text-embedding-3-small' — the constant has never had another value — so this
-- is a statement of fact, not an assumption. A column DEFAULT would be the
-- assumption: it would stamp the current model onto every future row whatever
-- actually produced it, which launders exactly the mistake this column exists
-- to catch.
update resume_chunks
   set embedding_model = 'text-embedding-3-small'
 where embedding_model is null
   and embedding is not null;

-- Not NOT NULL: `embedding` is itself nullable (a chunk can be stored before it
-- is embedded), and a chunk with no vector has no model. The pairing is the
-- rule worth enforcing.
alter table resume_chunks
  drop constraint if exists resume_chunks_embedding_model_pairing;

alter table resume_chunks
  add constraint resume_chunks_embedding_model_pairing
  check ((embedding is null) = (embedding_model is null));

create index if not exists resume_chunks_model_idx
  on resume_chunks (job_id, embedding_model);
