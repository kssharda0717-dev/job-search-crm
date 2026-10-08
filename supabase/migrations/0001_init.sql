-- ---------------------------------------------------------------------------
-- AI-Native Job Search CRM - initial schema
--
-- Deviation from the PRD worth flagging: the PRD models Resumes.file_blob as a
-- column. Storing multi-megabyte PDFs as bytea bloats the table and makes every
-- unrelated query slower, so the bytes live in the Supabase Storage bucket
-- `resumes` and we keep an object path here instead. Download behaviour for the
-- user is unchanged.
-- ---------------------------------------------------------------------------

create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists "uuid-ossp";

-- --- Enums -----------------------------------------------------------------

create type job_status as enum (
  'Pending', 'Applied', 'Interviewing', 'Offer', 'Rejected', 'Ghosted'
);

create type contact_status as enum (
  'Pending', 'Accepted', 'Replied', 'Follow_Up_Required'
);

create type persona as enum (
  'Engineering_Leader', 'Technical_Recruiter', 'Peer_Engineer'
);

create type message_type as enum (
  'connection_note', 'initial_outreach', 'follow_up'
);

create type apply_source as enum ('linkedin_easy_apply', 'external_ats');

-- --- Jobs ------------------------------------------------------------------

create table jobs (
  id              uuid primary key default uuid_generate_v4(),
  company         text not null,
  title           text not null,
  url             text,
  location        text,
  jd_text         text,
  status          job_status not null default 'Applied',
  source          apply_source not null,
  external_job_id text,
  applied_at      timestamptz,
  created_at      timestamptz not null default now()
);

-- Feature 3 resolves contacts to jobs with ILIKE '%company%'. A trigram index
-- is what makes that pattern non-sequential at any real volume.
create index jobs_company_trgm_idx on jobs using gin (company gin_trgm_ops);
create index jobs_status_idx on jobs (status);

-- Re-applying to the same requisition should update, not duplicate. Partial
-- index because external_job_id is null for manually-tracked roles.
create unique index jobs_external_id_uniq
  on jobs (lower(company), external_job_id)
  where external_job_id is not null;

-- --- Resumes (Document Vault) ----------------------------------------------

create table resumes (
  id             uuid primary key default uuid_generate_v4(),
  job_id         uuid not null references jobs (id) on delete cascade,
  file_name      text not null,
  storage_path   text not null,
  extracted_text text not null,
  uploaded_at    timestamptz not null default now()
);

-- PRD specifies a 1:1 relationship between a job and the resume sent for it.
create unique index resumes_job_id_uniq on resumes (job_id);

-- --- Resume chunks (RAG) ---------------------------------------------------

create table resume_chunks (
  id          uuid primary key default uuid_generate_v4(),
  resume_id   uuid not null references resumes (id) on delete cascade,
  -- Denormalised so hybrid search can filter by job without a join.
  job_id      uuid not null references jobs (id) on delete cascade,
  chunk_index int not null,
  chunk_text  text not null,
  embedding   vector(1536),
  -- Sparse leg of hybrid search. Generated so it can never drift from the text.
  fts         tsvector generated always as (to_tsvector('english', chunk_text)) stored
);

create index resume_chunks_fts_idx on resume_chunks using gin (fts);
create index resume_chunks_job_idx on resume_chunks (job_id);
create index resume_chunks_embedding_idx
  on resume_chunks using hnsw (embedding vector_cosine_ops);

-- --- Contacts --------------------------------------------------------------

create table contacts (
  id              uuid primary key default uuid_generate_v4(),
  -- Nullable: a contact with no company match is "General Networking".
  job_id          uuid references jobs (id) on delete set null,
  name            text not null,
  linkedin_url    text not null unique,
  headline        text,
  company         text,
  persona         persona,
  status          contact_status not null default 'Pending',
  connected_at    timestamptz,
  accepted_at     timestamptz,
  last_checked_at timestamptz,
  created_at      timestamptz not null default now()
);

create index contacts_status_idx on contacts (status);
create index contacts_job_idx on contacts (job_id);

-- --- Messages --------------------------------------------------------------

create table messages (
  id         uuid primary key default uuid_generate_v4(),
  contact_id uuid not null references contacts (id) on delete cascade,
  job_id     uuid references jobs (id) on delete set null,
  type       message_type not null,
  draft_text text not null,
  -- Null until the user manually clicks LinkedIn's native Send button.
  sent_text  text,
  sent_at    timestamptz,
  created_at timestamptz not null default now()
);

create index messages_contact_idx on messages (contact_id);
create index messages_job_idx on messages (job_id);

-- ---------------------------------------------------------------------------
-- Hybrid search: dense (cosine) + sparse (ts_rank_cd) fused with Reciprocal
-- Rank Fusion. RRF combines rankings rather than raw scores, which sidesteps
-- the fact that cosine distance and ts_rank are on incomparable scales.
--
--   score(d) = sum over each ranking r of  1 / (k + rank_r(d))
--
-- Both legs are scoped to a single job_id so a draft can only ever cite the
-- resume that was actually submitted for that application.
-- ---------------------------------------------------------------------------

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
        order by ts_rank_cd(c.fts, websearch_to_tsquery('english', p_query_text)) desc
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

-- ---------------------------------------------------------------------------
-- Feature 3: fuzzy company match. Returns candidate jobs ordered by trigram
-- similarity so the caller can decide between auto-link and disambiguation.
-- ---------------------------------------------------------------------------

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
      j.company ilike '%' || p_company || '%'
      or p_company ilike '%' || j.company || '%'
      or similarity(j.company, p_company) >= p_threshold
    )
  order by similarity(j.company, p_company) desc, j.created_at desc;
$$;
