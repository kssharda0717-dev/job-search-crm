-- 0012: record what the critique still said about a draft that shipped.
--
-- `draft_runs` (0008) already stored *counts* — critique_problems, ungrounded
-- figures — but it is telemetry: nothing in the product reads it, and the side
-- panel renders drafts from `messages`. So a draft that came out of two repair
-- passes still carrying a problem looked, in the only place a human ever sees
-- it, identical to a clean one. Two messages recorded critique_problems = 1 and
-- were approved and sent, because the panel had no way to say otherwise.
--
-- Nullable with no default: every row written before this migration genuinely
-- was not reviewed, and claiming "0 problems" for them would be a lie told by a
-- default value. The panel distinguishes "not checked" from "checked, clean".
--
-- Skip this and drafting still works, but `POST /draft` fails on insert because
-- PostgREST rejects an unknown column.

alter table messages
  add column review jsonb;

comment on column messages.review is
  'DraftReview: { evidenceCount, problems[], ungroundedFigures[], repairPasses } '
  'as of the moment this draft was saved. Null for drafts written before 0012.';
