-- ---------------------------------------------------------------------------
-- 0009: two correctness fixes with no feature attached to either.
--
-- 1. `match_jobs_by_company` pasted a company name straight into an `ilike`
--    pattern. `%` and `_` are wildcards there, so a company whose name contains
--    one — "100% Remote", "Node_Labs" — matched every tracked application at
--    once. The RPC then returned several candidates, `captureContact` correctly
--    refused to guess between them, and the contact was filed as general
--    networking. Silently: there is no error in that path, and the user only
--    sees a contact that would not link.
--
-- 2. `resume_chunks` had no unique key on (resume_id, chunk_index). The indexer
--    writes chunk 0..n for a resume, and a retry after a partial failure wrote
--    the same indices again. Duplicated text is worse than merely wasteful:
--    both legs of hybrid search can return the same passage twice, RRF adds its
--    reciprocal ranks together, and the duplicate outranks a genuinely better
--    chunk. The draft is then built from whatever happened to be written twice.
-- ---------------------------------------------------------------------------

-- --- 1. LIKE-pattern escaping ----------------------------------------------

-- Escapes the three characters that mean something to LIKE/ILIKE, in the order
-- that matters: the backslash first, or the escapes added below would
-- themselves be escaped.
create or replace function escape_like (p_value text)
returns text
language sql
immutable
strict
as $$
  select replace(replace(replace(p_value, '\', '\\'), '%', '\%'), '_', '\_');
$$;

comment on function escape_like (text) is
  'Escape \, % and _ so a user- or model-supplied string is matched literally by LIKE/ILIKE.';

create or replace function match_jobs_by_company (
  p_company   text,
  p_threshold float default 0.4
)
returns setof jobs
language sql
stable
as $$
  select j.*
  from jobs j
  where p_company is not null
    and p_company <> ''
    and (
      -- Substring match in either direction catches "Stripe" vs "Stripe, Inc."
      -- Both sides are escaped: `p_company` is scraped from a page, and
      -- `j.company` is scraped too, so neither is trusted as a pattern.
      j.company ilike '%' || escape_like(p_company) || '%'
      or p_company ilike '%' || escape_like(j.company) || '%'
      -- The trigram leg compares text, not patterns, so it needs no escaping.
      or similarity(j.company, p_company) >= p_threshold
    )
  order by similarity(j.company, p_company) desc, j.created_at desc;
$$;

-- --- 2. One row per (resume, chunk index) ----------------------------------

-- Existing duplicates have to go before the constraint can be added. Keeping
-- the lowest id is arbitrary but total: the rows are copies of the same text,
-- so which survives cannot matter, only that exactly one does.
delete from resume_chunks c
where exists (
  select 1
  from resume_chunks keep
  where keep.resume_id = c.resume_id
    and keep.chunk_index = c.chunk_index
    and keep.id < c.id
);

alter table resume_chunks
  add constraint resume_chunks_resume_id_chunk_index_key
  unique (resume_id, chunk_index);
