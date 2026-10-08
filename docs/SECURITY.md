# Security

The threat model of a single-user local tool is not "nobody attacks it". It is:

1. A **provider key leaking out of the extension bundle** and being spent by
   someone else. `OPENAI_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are the
   crown jewels.
2. **LinkedIn account loss**, through automation that looks like a bot or that
   sends something the user did not approve.
3. **A message going out that the user never read.**

Everything below serves one of those three.

---

## Authentication

- Every `/api/*` request carries a shared bearer token in the **`x-crm-token`**
  header. There are no sessions, no cookies, no refresh flow.
- `CRM_AUTH_TOKEN` is validated by zod at import with `min(16)`. The server
  refuses to start without it.
- The comparison is **constant-time**, hand-rolled in `server/src/index.ts`. A
  naive `===` short-circuits on the first differing byte and leaks the token
  one character at a time to anything that can time a local request.
- Length mismatch returns 401 immediately. That is not a timing leak worth
  closing: the length is not the secret.
- The token is never logged, never put in a URL, and never rendered in the
  panel after it is saved.

**Rotating it:** change `CRM_AUTH_TOKEN` in `server/.env`, restart the server,
paste the new value into the extension's Settings tab. There is nothing else to
update.

## Authorization

There is none, on purpose. One person, one proxy, one database — see
`docs/DECISIONS.md` → ADR-004. Every row belongs to the only user.

The consequence to be honest about: **anything that can reach the proxy with the
token can read every job, contact, message and resume.** That is why the proxy
binds to localhost and why the token is 16+ characters rather than a
convenience string.

If this ever became multi-user, the change is a `user_id` column, real RLS
policies, and an auth provider — a migration, not a rewrite. Do not half-build
it in the meantime.

## Secrets

| Secret | Lives in | Never in |
| --- | --- | --- |
| `OPENAI_API_KEY` | `server/.env` | the extension, any log, any doc |
| `SUPABASE_SERVICE_ROLE_KEY` | `server/.env` | the extension, any log, any doc |
| `TAVILY_API_KEY` (optional) | `server/.env` | the extension |
| `CRM_AUTH_TOKEN` | `server/.env` **and** `chrome.storage.local` | a URL, a log |

Rules:

- **Never put a provider key in the extension.** An unpacked extension's bundle
  is readable by anyone with the directory; `chrome.storage` is readable by
  anyone with the Chrome profile. This is a **hard** PRD constraint.
- `server/.env` is never committed. Neither is any resume PDF, nor anything
  under `build/`.
- `env.ts` throws at import if anything required is missing, so a
  misconfiguration is a startup failure rather than a 500 at the worst moment.
- **Nothing outside `server/src` imports `env.ts`** — it would make pure modules
  untestable and drag secrets into shared code.
- Never log a token, a key, or a full resume body. Log identifiers, counts and
  error classes.

Verify after any build:

```bash
grep -r "sk-\|service_role" extension/build ; true
```

## Database

- **RLS is enabled on all five tables with zero policies.** Deny-all. The
  proxy's service role bypasses RLS, so the app works; a leaked anon key grants
  nothing at all. Do not "fix" the missing policies — their absence is the
  control.
- The service-role client exists **only** on the server.
- Migrations are append-only. Never edit one that has been run.
- Constraints carry the invariants that matter: one resume per job (unique on
  `job_id`), one contact per LinkedIn URL, and a partial unique index on
  `(lower(company), external_job_id)` for job dedupe.
- Deletes cascade from `resumes` to `resume_chunks`, so a re-index cannot leave
  orphan vectors that a draft could later cite.

## Input validation

- **Every request body is validated by a zod schema at the route boundary**, in
  `parseBody()`. The same schemas in `packages/shared/src/api.ts` are used by
  the extension to build the request, so client and server cannot drift.
- A validation failure is a **400 with the zod error**, not a 500 and not a
  silent default.
- **Every string field has a `.max()`**, and the ceilings live in
  `packages/shared/src/constants.ts` rather than inline, so the extension's own
  types state the limit. Unbounded fields were not a theoretical problem: text
  arriving on `extractedText` skips the PDF parser entirely and is chunked and
  embedded, so its length is an OpenAI bill; `title` is compiled into a regex by
  `mentionsRole`; `instruction` is concatenated into the drafting prompt.
- The zod schemas run **after** the body has been received and `JSON.parse`d, so
  on their own they bound what is *stored*, not what is *allocated*. A
  `bodyLimit` of `MAX_REQUEST_BODY_BYTES` refuses an oversized body at the
  socket, before any of it reaches the heap.
- Supabase's client parameterises queries; there is no string-built SQL
  anywhere. The two RPCs take typed arguments.
- Filenames are run through `sanitizeFileName()` before they become a storage
  path. A path segment from user input is a traversal waiting to happen.
- Scraped LinkedIn text is treated as **data, never as instruction**. It reaches
  the model inside tool results and the model's output is then machine-checked
  by `critique.ts` — a headline that says "ignore your instructions" cannot make
  a draft ship, because the critique does not read intent.

## APIs

- CORS is an **allowlist** from `ALLOWED_ORIGINS`, defaulting to
  `chrome-extension://*`. The wildcard is matched by scheme and pattern, not by
  a substring test.
- `app.onError` maps `HttpError` to its status and everything else to a 500
  with a generic body. Stack traces do not reach the client.
- The proxy binds **explicitly to `127.0.0.1`** on `PORT` (8787). It is not
  meant to be exposed; there is no deployment target and no hosted mode.
  `@hono/node-server` defaults to `0.0.0.0`, so until the hostname was passed
  this process — which holds the OpenAI key and a service-role key that bypasses
  RLS — was reachable from every other device on the network, and the startup
  log said "localhost" either way. This document asserted the loopback bind
  before anything configured it; do not let it drift back.
- **The container sets `HOST=0.0.0.0`, and that is not a weakening.** Inside a
  container `127.0.0.1` is the container's own loopback, and Docker forwards a
  published port to the bridge address instead — bind loopback in there and the
  server accepts nothing while still reporting itself healthy.
  `docker-compose.yml` publishes `127.0.0.1:8787:8787`, so the host listens on
  loopback only. The guarantee moves from the process to Docker; it does not
  disappear. Publishing as `8787:8787` would remove it, which is why that line
  carries a comment saying so. `HOST` defaults to `127.0.0.1` everywhere else,
  and both directions are verified (2026-10-08): with the default, a request to
  the machine's own LAN address is refused; with the override, it is answered.
- `allowMethods` must list every method a route actually uses. `DELETE` was
  missing while `DELETE /api/messages/:id` existed, so discarding a draft failed
  its preflight and looked like a network error rather than a CORS one.
- Outbound calls go to exactly three hosts: OpenAI, Supabase, and Tavily when a
  key is set. No other network egress.
- **Never put personal data in a URL or query string.** URLs land in logs, in
  history and in referer headers.

## File uploads

- PDF only. Text extraction runs **server-side** (`rag/pdf.ts`) — an MV3 content
  script inherits the host page's CSP, so pdf.js cannot run there.
- A PDF whose text cannot be extracted is a **422**, surfaced next to the upload
  control. It is never indexed as an empty document, because an empty document
  retrieves nothing and the model fills silence with invention.
- Files go to a **private** Supabase Storage bucket. There is no public URL.
- Downloads use a **60-second signed URL** with
  `{ download: resume.file_name }` so Content-Disposition names the file.
- The storage key is `<jobId>/<sanitized name>` with no timestamp prefix; the
  previous object is deleted first and `upsert: true` is set. Because the key is
  derived from the job, a second upload resolves to the same object and
  overwrites the bytes in place — so an upload against a job that already has a
  resume is **refused** unless the request carries `replace: true`. Replacement
  is destructive and unrecoverable; it has to be asked for.
- Resume bytes are never held in a content-script variable — the confirmation
  page is a new document — and never persisted outside the per-tab stash, which
  has a 2 h TTL.
- **Capture is gated on the page being a job application.** The content scripts
  are injected far more broadly than the feature needs — one into every http(s)
  page, one into all of `linkedin.com` — because narrower `matches` lose
  applications silently. The gate is therefore evaluated per file-choice rather
  than at script load, so a PDF attached to a bank form, a tax portal or a
  LinkedIn message is never read. A toast fires on every capture that does
  happen; there is no silent path.

## LinkedIn safety

These protect the user's account and the people they are contacting. All four
are **hard** PRD constraints.

- **Never click LinkedIn's Send button.** Content scripts inject text into the
  composer and outline the native button. The human clicks it. No
  `dispatchEvent` on Send, ever.
- **No private LinkedIn APIs.** `document.querySelector` against rendered DOM
  only. Anything else is a ban risk and a licence violation.
- **Never open a contact's profile to check on them.** LinkedIn reports a
  profile view to the person viewed. Acceptance detection reads the user's own
  Sent-invitations and Connections pages instead.
- **Background sweeps stay jittered 30–90 minutes and paused 22:00–07:00.** A
  fixed interval is a signature, and 03:00 activity is not a human.

## Privacy

- All data stays in the user's own Supabase project and on their own machine.
  There is no telemetry, no analytics and no crash reporting.
- The only data sent to a third party is what drafting requires: the retrieved
  resume chunks, the job description, and the recipient's public headline, to
  OpenAI. Nothing else leaves.
- Contacts are people who have not consented to being in a CRM. Store the
  minimum the feature needs, and never create a record because the user merely
  looked at a profile.

## Verification checklist

Run before calling any security-touching change done. Also in
`docs/TEST_PLAN.md`.

- [ ] `grep -r "sk-\|service_role" extension/build` finds nothing.
- [ ] `/api/jobs` with no `x-crm-token` → 401.
- [ ] `/api/jobs` with a wrong token → 401.
- [ ] A disallowed origin is rejected by CORS.
- [ ] A malformed body → 400 with a zod error, not a 500.
- [ ] The Supabase **anon** key against the REST API reads nothing from any of
      the five tables.
- [ ] A resume signed URL is dead after 60 s.
- [ ] No log line contains a token, a key or a resume body.
- [ ] `server/.env`, `build/` and every PDF are untracked if git is initialised.
