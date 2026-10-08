-- A founder/CEO/CTO is not an Engineering_Leader. Classifying one as the other
-- produced outreach pitched at delivery throughput for someone who measures
-- candidates in revenue and risk.
--
-- `alter type ... add value` cannot run inside a transaction block, so this has
-- to be its own migration rather than an edit to 0001.
alter type persona add value if not exists 'Founder_Executive';
