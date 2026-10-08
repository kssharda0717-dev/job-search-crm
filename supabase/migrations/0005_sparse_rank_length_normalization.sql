-- Normalise the sparse leg for chunk length.
--
-- `ts_rank_cd(vector, query)` with no normalisation flag returns a raw cover
-- density, which grows with the number of matched lexemes and therefore with
-- the length of the chunk. The sparse query is a union of ~30 terms (persona
-- vocabulary plus the job description's technology keywords), so the chunk that
-- won was reliably the resume's SKILLS block: a 700-character wall of
-- comma-separated technology names that matches almost every term in the query
-- and contains no system, no number and no decision. It outranked every
-- achievement bullet on the document, and a draft built from it can only say
-- that the candidate "has experience with" things.
--
-- Flag 1 divides the rank by 1 + log(document length), which is enough to stop
-- a long chunk winning on length alone without over-rewarding very short ones
-- the way flag 2 (divide by length) would.
--
-- Everything else is byte-identical to 0001; `create or replace function`
-- requires the whole body to be restated.
create or replace function hybrid_search_resume_chunks (
  p_job_id          uuid,
  p_query_embedding vector(1536),
  p_query_text      text,
  p_limit           int default 3,
  p_rrf_k           int default 60
)
returns table (
  chunk_id    uuid,
  resume_id   uuid,
  chunk_text  text,
  dense_rank  int,
  sparse_rank int,
  rrf_score   float
)
language sql
stable
as $$
  with dense as (
    select
      c.id,
      row_number() over (order by c.embedding <=> p_query_embedding) as rank
    from resume_chunks c
    where c.job_id = p_job_id
      and c.embedding is not null
    -- Over-fetch relative to p_limit: fusion needs depth in each leg to be
    -- meaningful, otherwise RRF degenerates to whichever leg matched at all.
    limit greatest(p_limit * 10, 30)
  ),
  sparse as (
    select
      c.id,
      row_number() over (
        order by ts_rank_cd(c.fts, websearch_to_tsquery('english', p_query_text), 1) desc
      ) as rank
    from resume_chunks c
    where c.job_id = p_job_id
      and p_query_text is not null
      and p_query_text <> ''
      and c.fts @@ websearch_to_tsquery('english', p_query_text)
    limit greatest(p_limit * 10, 30)
  )
  select
    rc.id,
    rc.resume_id,
    rc.chunk_text,
    d.rank::int,
    s.rank::int,
    coalesce(1.0 / (p_rrf_k + d.rank), 0.0)
      + coalesce(1.0 / (p_rrf_k + s.rank), 0.0) as rrf_score
  from resume_chunks rc
  -- Full outer join semantics: a chunk found by only one leg still competes.
  left join dense d on d.id = rc.id
  left join sparse s on s.id = rc.id
  where rc.job_id = p_job_id
    and (d.rank is not null or s.rank is not null)
  order by rrf_score desc
  limit p_limit;
$$;
