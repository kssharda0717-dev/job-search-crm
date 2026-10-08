-- 0014: separate repair attempts from repairs that were actually kept.
--
-- `repair_passes` (0008) counts model calls. `repairDraft` ranks each rewrite
-- and keeps it only if it scores strictly better, so a run can spend both calls
-- and ship the draft it started with. The table could not tell that apart from
-- a run whose two rewrites fixed everything: Nadia Haddad's row reads
-- `repair_passes: 2, critique_problems: 0`, which means either "it was dirty and
-- the loop cleaned it" or "both rewrites were discarded and what shipped is the
-- model's first answer". Those call for opposite responses — one says the loop
-- works, the other says it is burning tokens for nothing — and there was no way
-- to ask.
--
-- `repair_passes > 0 and repair_accepted = 0` is now a query.
--
-- Default 0, unlike 0012's deliberately-null `review`. A count of kept rewrites
-- is not a verdict about the draft, so backfilling the arithmetic truth for rows
-- written before this column existed asserts nothing false; every one of those
-- runs predates the counter, and 0 is what an un-instrumented loop is worth.
--
-- Skip this and drafting still works, but every `draft_runs` insert is rejected
-- for an unknown column. `recordDraftRun` swallows that by design — telemetry
-- must never fail a draft — so the symptom is a `[draft_runs] insert failed`
-- warning in the server log and a table that silently stops growing.

alter table draft_runs
  add column repair_accepted integer not null default 0;

comment on column draft_runs.repair_accepted is
  'Rewrites that scored better and were kept, of the repair_passes attempted. '
  'repair_passes > 0 and repair_accepted = 0 is a loop that paid for model calls '
  'and shipped the original draft. Always 0 for rows written before 0014.';
