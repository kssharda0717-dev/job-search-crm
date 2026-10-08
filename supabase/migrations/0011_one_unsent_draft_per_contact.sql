-- 0011 — At most one unsent draft of a given type per contact.
--
-- Why this has to live in the database.
--
-- `sweepStaleContacts` guards against stacking drafts by counting the unsent
-- follow-ups for a contact and skipping when there is already one. That is a
-- read, then a decision, then a write by a different request — and nothing
-- holds between them. On 2026-10-01 the user opened roughly twenty-five
-- profiles in a row; `linkedin-profile.ts` fires OBSERVE_ACCEPTED three seconds
-- after each one loads, every OBSERVE_ACCEPTED runs the stale sweep, and the
-- sweeps overlapped. Each read "no draft exists", each wrote one:
--
--   06:22:23.5  follow_up  Omar Faruq
--   06:22:25.0  follow_up  Omar Faruq          <- same contact, 1.5s later
--   06:22:29.5  follow_up  Nikos Pallas
--   06:22:31.3  follow_up  Nikos Pallas
--   06:22:31.5  follow_up  Nikos Pallas  <- three, inside two seconds
--
-- Seven drafts, seven full agent runs, for four contacts. No amount of
-- application-level checking fixes a time-of-check/time-of-use race; only the
-- database can refuse the second write, because only the database sees both.
--
-- The index is PARTIAL on `sent_at IS NULL` deliberately. Sent messages are the
-- record of the conversation and must stay unconstrained — a contact can have
-- been sent an initial_outreach and two follow_ups, and ADR-048's thread block
-- depends on every one of them still being there.
--
-- `generateDraft` now catches 23505 on this index and returns the draft that
-- won the race, which is the same answer the caller wanted.

-- Collapse any duplicates that already exist, keeping the newest of each group.
-- A unique index cannot be created over violating rows, and the rows removed
-- here are by definition redundant: an unsent draft of the same type for the
-- same contact, superseded by a later one.
delete from public.messages m
using public.messages newer
where m.sent_at is null
  and newer.sent_at is null
  and m.contact_id = newer.contact_id
  and m.type = newer.type
  and (newer.created_at, newer.id) > (m.created_at, m.id);

create unique index if not exists messages_one_unsent_draft_per_contact_type
  on public.messages (contact_id, type)
  where sent_at is null;
