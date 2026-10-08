-- 0013: let retrieval run over the whole resume corpus when there is no
-- application to scope it to.
--
-- Both functions are restated verbatim from 0006 apart from one line each:
-- `where c.job_id = p_job_id` becomes
-- `where (p_job_id is null or c.job_id = p_job_id)`.
-- `create or replace function` requires the whole body, so the diff is stated
-- here rather than left to be worked out from the file.
--
-- Why. 6 of 31 contacts have no employer and therefore no linked application:
-- `captureMissedInvitations` reads the Sent-invitations page, which gives a name
-- and a headline and nothing else, so there is nothing to match a job on. PRD §6
-- forbids opening their profiles in bulk to find out. For every one of them
-- `execute_hybrid_search` returned `hits: []`, the agent was told to make no
-- claims, and the user got a message with no evidence in it — the system's worst
-- output, produced for a fifth of the people in it, because of a filter rather
-- than a lack of data. The candidate's resumes were indexed the whole time.
--
-- This does not weaken the invariant it looks like it weakens. "Retrieval must
-- never cross applications" exists so a draft cannot cite a resume that was not
-- the one sent for that role. With `p_job_id` null there is no role, nothing was
-- sent, and there is no application to cross — the corpus is the candidate's own
-- resumes and nobody else's. A non-null `p_job_id` behaves exactly as before.
--
-- Skip this and drafting still works; every unlinked contact keeps getting a
-- message written from zero evidence.

create or replace function dense_search_resume_chunks (
  p_job_id uuid,
  p_query_embedding vector(1536),
  p_limit int default 30
)
returns table (chunk_id uuid, resume_id uuid, chunk_index int, chunk_text text)
language sql
stable
as $$
  select c.id, c.resume_id, c.chunk_index, c.chunk_text
  from resume_chunks c
  where (p_job_id is null or c.job_id = p_job_id)
    and c.embedding is not null
  order by c.embedding <=> p_query_embedding
  limit p_limit;
$$;

create or replace function sparse_search_resume_chunks (
  p_job_id uuid,
  p_query_text text,
  p_limit int default 30
)
returns table (chunk_id uuid, resume_id uuid, chunk_index int, chunk_text text)
language sql
stable
as $$
  select c.id, c.resume_id, c.chunk_index, c.chunk_text
  from resume_chunks c
  where (p_job_id is null or c.job_id = p_job_id)
    and p_query_text is not null and p_query_text <> ''
    and c.fts @@ websearch_to_tsquery('english', p_query_text)
  -- Flag 1 divides the rank by 1 + log(length). Without it the rank is raw
  -- cover density, which grows with chunk length, so the resume's SKILLS wall
  -- outranked every achievement bullet on the document. See 0005.
  order by ts_rank_cd(c.fts, websearch_to_tsquery('english', p_query_text), 1) desc
  limit p_limit;
$$;
