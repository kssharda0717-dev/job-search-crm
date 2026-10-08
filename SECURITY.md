# Security Policy

## Reporting a vulnerability

Please **do not open a public issue.** Use GitHub's private vulnerability
reporting on this repository (Security → Report a vulnerability), which opens a
private advisory only the maintainers can see.

Include what you need to reproduce it: the route or content script involved, the
request or page, and what you got back. If it needs a payload, attach it rather
than pasting it inline.

There is no bounty. This is a personal project.

## What is in scope

This is a locally-run tool, not a hosted service, so the interesting boundary is
not "the internet" — it is everything that reaches the proxy or the content
scripts from somewhere the user does not control:

- **The proxy** (`server/`). It holds an OpenAI key and a Supabase
  **service-role** key that bypasses RLS. It binds to `127.0.0.1` and requires a
  shared secret on every `/api/*` route. Anything that gets past either of those
  is in scope, as is anything that makes it leak a key, a stack trace or another
  user's row.
- **Scraped page content.** Headlines, profile text and job descriptions are
  attacker-controlled input. They reach the model inside tool results, and they
  reach regexes, storage paths and the database. Treating any of it as
  instruction rather than data is a bug.
- **The content scripts.** They are injected into every http(s) page. Anything
  that makes one read a file, exfiltrate page content, or act on a page the user
  is not applying through is in scope.
- **The vault.** Résumé bytes, the private Storage bucket, and the signed
  download URLs.

## What is not in scope

- Anything requiring an attacker to already have the user's `server/.env`, their
  Supabase dashboard, or local shell access.
- The absence of multi-user authentication. There is one user by design; there
  are no accounts and no tenancy to break.
- LinkedIn's own rate limits, ToS or anti-scraping measures. The constraints
  this project holds itself to are in `docs/PRD.md` §6 and are enforced in
  `docs/SECURITY.md` → LinkedIn safety; a report that the project *should*
  violate one of them is not a vulnerability report.
- Findings from a scanner with no demonstrated impact.

## Threat model and controls

The full threat model, the control list and the review checklist live in
[`docs/SECURITY.md`](docs/SECURITY.md). Read it before reporting — the thing you
found may already be documented there as a deliberate trade-off, in which case
the useful report is an argument against the trade-off.

## If you are running this yourself

Rotate anything that has ever been pasted anywhere: `SUPABASE_SERVICE_ROLE_KEY`,
`OPENAI_API_KEY` and `CRM_AUTH_TOKEN`. `server/.env` is gitignored, but a key
that has been in a terminal transcript, a screenshot or a chat window is burned.
