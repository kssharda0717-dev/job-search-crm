-- ---------------------------------------------------------------------------
-- Storage bucket for the Document Vault, plus a deny-by-default RLS posture.
--
-- All access goes through the proxy server using the service-role key, which
-- bypasses RLS. Enabling RLS without permissive policies therefore means that
-- a leaked anon key grants nothing: the browser extension never talks to
-- Supabase directly. This is the whole point of routing through the proxy.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('resumes', 'resumes', false)
on conflict (id) do nothing;

alter table jobs           enable row level security;
alter table resumes        enable row level security;
alter table resume_chunks  enable row level security;
alter table contacts       enable row level security;
alter table messages       enable row level security;

-- No policies are defined on purpose. Deny-all for anon and authenticated
-- roles; the service role used by the proxy is exempt from RLS entirely.
