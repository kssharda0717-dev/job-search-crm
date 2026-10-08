-- ---------------------------------------------------------------------------
-- Store what the recipient's LinkedIn profile actually says.
--
-- Until now a contact reached the drafting agent as a name, a company and a
-- one-line headline. The headline is a slogan people write once and forget, and
-- it is frequently absent altogether — people-cards render "Message" or
-- "Pending" where one would go — so the recipient arrived at retrieval as
-- little more than a five-value persona enum.
--
-- That is the wrong half of the problem to be starved on. Retrieval searches the
-- *candidate's* resume; the recipient decides which parts of it are worth
-- saying. A recruiter whose profile reads "Oracle Consultants All Modules —
-- Oracle HCM, Oracle Financials — MENA and Gulf regions" makes five specific
-- resume bullets relevant that a headline reading "Technical Talent
-- Acquisition" cannot reach by any query.
--
-- This column holds a condensed, capped read of the About, Experience and Skills
-- sections — the three parts that say what a person actually does. It is NOT
-- embedded and NOT added to the retrieval corpus: the corpus is the user's own
-- resume, and mixing the recipient's text into it would let a draft cite the
-- recipient's career as the candidate's own. That failure has already happened
-- once here, from the far weaker signal of a headline, and it produced a message
-- claiming the sender had "improved time-to-fill by 30%".
--
-- Nullable on purpose, and it will often be null. The profile is only readable
-- when the user is standing on it; harvesting profiles from the background sweep
-- would fill this column and break the anti-ban posture in PRD section 6, which
-- is not a trade this project makes.
-- ---------------------------------------------------------------------------

alter table contacts
  add column if not exists profile_text text;

-- Written whenever the profile was last read, so the panel can distinguish
-- "never looked" from "looked, and the profile really is this thin". Without it
-- a null `profile_text` is ambiguous and the panel cannot honestly prompt.
alter table contacts
  add column if not exists profile_read_at timestamptz;
