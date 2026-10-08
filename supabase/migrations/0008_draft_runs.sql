-- ---------------------------------------------------------------------------
-- One row per drafting run: what it retrieved, what it cost, how long it took,
-- and whether the result was grounded.
--
-- Until now the server logged two lines in total. `generateDraft` computed
-- `citations` and `trace` and returned them in the HTTP response — but the
-- majority of drafts are written by the follow-up engine, where nobody is
-- reading that response, so the evidence a message was built from was
-- unrecoverable the moment the request ended. "Why did it say that?" had no
-- answer, and neither did "is faithfulness falling?" or "what is this costing?"
--
-- A run is not a message. A run can fail without producing one, and the failed
-- runs are the interesting ones, so `message_id` is nullable and `error` exists.
-- ---------------------------------------------------------------------------

create table if not exists draft_runs (
  id            uuid primary key default uuid_generate_v4(),

  -- set null, not cascade: deleting a draft must not erase the record that it
  -- was generated, what it cost, or what evidence it used.
  message_id    uuid references messages (id) on delete set null,
  contact_id    uuid references contacts (id) on delete set null,
  job_id        uuid references jobs (id) on delete set null,

  type          message_type not null,
  persona       persona,

  -- Retrieval, scored. `evidence_chunk_ids` is what the agent was actually
  -- shown; `ungrounded_figures` is how many numbers in the final draft appear
  -- in none of it. Faithfulness over any window is a query against these two,
  -- not a number someone has to remember to compute.
  evidence_chunk_ids uuid[] not null default '{}',
  ungrounded_figures int not null default 0,
  critique_problems  int not null default 0,
  repair_passes      int not null default 0,

  -- Cost and latency. Tokens are summed across every model call the run made:
  -- the ReAct turns, the reranker, the repair passes and the shorten pass.
  -- Reporting only the drafting call would undercount a run by more than half.
  model              text not null,
  prompt_tokens      int not null default 0,
  completion_tokens  int not null default 0,
  model_calls        int not null default 0,
  latency_ms         int not null,

  error         text,
  created_at    timestamptz not null default now()
);

create index if not exists draft_runs_created_idx on draft_runs (created_at desc);
create index if not exists draft_runs_contact_idx on draft_runs (contact_id);

-- Deny-all, consistent with every other table (migration 0002). Only the
-- service role reads this.
alter table draft_runs enable row level security;
