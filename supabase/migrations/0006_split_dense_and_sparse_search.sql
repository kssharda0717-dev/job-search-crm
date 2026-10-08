-- Split hybrid retrieval into its two legs and move fusion into the server.
--
-- `hybrid_search_resume_chunks` did three things at once: dense ranking, sparse
-- ranking, and RRF fusion. That was one round trip, which is why it was written
-- that way, and it cost two things that turned out to matter more.
--
-- 1. Fusion was untestable. Checking that a chunk found by only one leg still
--    competes needed a populated Postgres and a 1536-dimension embedding, so it
--    was never checked. It is now `server/src/rag/fuse.ts`, which is pure.
-- 2. Neither leg could be measured on its own. The sparse leg matched *no rows
--    on every draft ever generated* — `websearch_to_tsquery` ANDs bare words,
--    so a space-joined keyword list is an impossible query — and the fused
--    output looked entirely reasonable throughout, because the dense leg always
--    returns something. A single fused score cannot surface a dead leg.
--
-- Both functions return `chunk_index` so the eval set can name relevant chunks
-- by a position that survives re-indexing; `chunk_id` is generated per insert
-- and cannot be written down in a committed fixture.
--
-- The ranking expressions are copied verbatim from 0005. The only change to
-- either is the added `chunk_index` column and the removal of the fusion step.

create or replace function dense_search_resume_chunks (
  p_job_id          uuid,
  p_query_embedding vector(1536),
  p_limit           int default 30
)
returns table (
  chunk_id    uuid,
  resume_id   uuid,
  chunk_index int,
  chunk_text  text
)
language sql
stable
as $$
  select c.id, c.resume_id, c.chunk_index, c.chunk_text
  from resume_chunks c
  where c.job_id = p_job_id
    and c.embedding is not null
  order by c.embedding <=> p_query_embedding
  limit p_limit;
$$;

create or replace function sparse_search_resume_chunks (
  p_job_id     uuid,
  p_query_text text,
  p_limit      int default 30
)
returns table (
  chunk_id    uuid,
  resume_id   uuid,
  chunk_index int,
  chunk_text  text
)
language sql
stable
as $$
  select c.id, c.resume_id, c.chunk_index, c.chunk_text
  from resume_chunks c
  where c.job_id = p_job_id
    and p_query_text is not null
    and p_query_text <> ''
    and c.fts @@ websearch_to_tsquery('english', p_query_text)
  -- Flag 1 divides the rank by 1 + log(length). Without it the rank is raw
  -- cover density, which grows with chunk length, so the resume's SKILLS wall
  -- outranked every achievement bullet on the document. See 0005.
  order by ts_rank_cd(c.fts, websearch_to_tsquery('english', p_query_text), 1) desc
  limit p_limit;
$$;

-- Nothing calls this any more. Fusion is `server/src/rag/fuse.ts`.
drop function if exists hybrid_search_resume_chunks (uuid, vector, text, int, int);
