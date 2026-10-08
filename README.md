# AI-Native Job Search CRM & Networking Copilot

A Chrome extension (Manifest V3) plus a proxy backend that tracks job
applications automatically, vaults the exact resume you submitted, maps LinkedIn
contacts to the roles you applied for, and drafts persona-aware outreach using
hybrid-search RAG over your own resume bullets.

Every message is drafted, never sent. See [Security model](#security-model).

## Layout

```
packages/shared/   Domain types, API contracts (zod), shared constants
server/            Hono proxy: Supabase + OpenAI, RAG, ReAct drafting agent
extension/         Plasmo MV3 extension: content scripts, worker, side panel
supabase/          SQL migrations (schema, pgvector, RLS)
scripts/           Run the proxy as a background service
Dockerfile         Server + migration runner; one image, two commands
docker-compose.yml Migrate to completion, then start the server
```

The extension never holds an OpenAI or Supabase key. It talks only to the proxy,
authenticated with a shared secret.

## Documentation

`docs/` is the source of truth. This README is a quickstart; it does not restate
the architecture.

| File | What it answers |
| --- | --- |
| [`docs/PRD.md`](docs/PRD.md) | What the product is and why, plus the known gaps |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How it is built, and the rules that keep it that way |
| [`docs/DESIGN.md`](docs/DESIGN.md) | How the side panel and toasts look and behave |
| [`docs/RULES.md`](docs/RULES.md) | The rulebook for changing this codebase |
| [`docs/TASKS.md`](docs/TASKS.md) | What is built, what is open |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Why each decision was made, and what failed first |
| [`docs/MEMORY.md`](docs/MEMORY.md) | Current state and known issues |
| [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md) | What "working" means |
| [`docs/EVALUATION.md`](docs/EVALUATION.md) | How retrieval and drafting are measured |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model and the full security checklist |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to get a change compiling and reviewed |
| [`SECURITY.md`](SECURITY.md) | How to report a vulnerability, and what is in scope |

## Setup

### 1. Supabase

Create a project. That is the whole step — you do not run any SQL by hand.

The schema is applied by a migration runner, once `server/.env` exists (step 2):

```bash
pnpm --filter @crm/server migrate
```

It reads a `schema_migrations` ledger, applies only the files that are missing,
in order, and records each with a checksum. Running it twice is a no-op. Running
it after a `git pull` applies whatever is new. It refuses — loudly, with a
non-zero exit — if the database and the repository disagree about history: a
file that was edited after being applied, a recorded migration that no longer
exists on disk, or two files sharing a number. See
[ADR-063](docs/DECISIONS.md#adr-063--migrations-apply-themselves-from-a-ledger-in-a-container-that-exits).

> **Upgrading a database you migrated by hand**, before this runner existed, run
> `pnpm --filter @crm/server migrate -- --baseline` once. It records the files
> you already applied without re-running them. New installs must not use it.

For reference, this is what the runner applies:

```
0001_init.sql                              tables, pgvector, pg_trgm, RRF search
0002_storage_and_rls.sql                   private resumes bucket, deny-all RLS
0003_adjacent_employee_persona.sql         + Adjacent_Employee
0004_founder_executive_persona.sql         + Founder_Executive
0005_sparse_rank_length_normalization.sql  ts_rank_cd normalization flag
0006_split_dense_and_sparse_search.sql     dense/sparse RPCs; fusion moves to TS
0007_record_embedding_model.sql            which model embedded each chunk
0008_draft_runs.sql                        one row per drafting run
0009_escape_like_and_unique_chunks.sql     escape_like(); unique (resume_id, chunk_index)
0010_contact_profile_text.sql              contacts.profile_text, profile_read_at
0011_one_unsent_draft_per_contact.sql      one unsent draft per (contact, type)
0012_message_review.sql                    messages.review — what the checker still said
0013_corpus_wide_search_for_unlinked_contacts.sql   p_job_id may be null
0014_record_accepted_repairs.sql           rewrites kept, not just attempted
```

`0001` enables the `vector` and `pg_trgm` extensions. `0002` turns on RLS with
**no policies**, so anon and authenticated roles can read nothing; only the
server's service-role key gets through.

`0003` and `0004` are separate files because `alter type … add value` cannot run
inside a transaction alongside other statements; the runner detects that from
the SQL and runs them outside one.

The rest of this section is what each migration buys you, written as what
happens without it. You should not be able to reach these states now — the
runner stops on a failure instead of continuing — but several of them fail
*silently*, which is why they are worth naming.

Skip `0003`/`0004` and drafting fails at
the insert with an invalid enum value. Skip `0005` and the sparse ranking still
favours whichever chunk is longest. Skip `0006` and **every draft fails**: the
server no longer calls `hybrid_search_resume_chunks`, which that migration drops
in favour of `dense_search_resume_chunks` and `sparse_search_resume_chunks`.
Skip `0007` and **every resume upload fails**, because the indexer writes a
column that does not exist. Skip `0008` and drafting still works but nothing is
recorded — deliberately, since telemetry must not be able to fail a draft.
Skip `0009` and **resume upload fails too**: the chunk upsert names
`(resume_id, chunk_index)` as its `ON CONFLICT` target, and without
`escape_like()` a company containing `%` or `_` matches every tracked job. Skip
`0010` and **every contact capture and enrich fails** on an unknown column.
Skip `0011` and drafting still works, but nothing stops two overlapping sweeps
from writing two drafts for the same contact — the guard in `generateDraft` is a
read-then-write race, and ~25 profile opens once produced 7 drafts for 4
contacts in 19 seconds. Skip `0012` and **every draft fails** on insert: the
draft is saved with its own review attached, and the column would not exist.
Skip `0013` and drafting still works, but every contact with no linked
application keeps retrieving nothing — `where c.job_id = null` is never true, so
this one fails *silently* and looks like it worked. Skip `0014` and drafting
still works, but every `draft_runs` insert is rejected for an unknown column;
`recordDraftRun` swallows that by design, so the symptom is a
`[draft_runs] insert failed` warning in the server log and a table that quietly
stops growing.

### 2. Server

```bash
pnpm install
cp server/.env.example server/.env
```

Fill in `server/.env`:

| Variable | Where it comes from |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API |
| `DATABASE_URL` | Supabase → the **Connect** button in the top bar → Connection String. (Not Project Settings → Database; that page only resets the password now.) Used **only** by `migrate`; the server never reads it. Take the box labelled **Session pooler** (port 5432); its username is `postgres.<project-ref>`, dot included. Not the **transaction** pooler on 6543: the runner holds a session-scoped `pg_advisory_lock`, and that pooler hands the connection to someone else between statements. The *direct* connection works too, but only from an IPv6 host — which rules it out under Docker, see below |
| `OPENAI_API_KEY` | platform.openai.com |
| `CRM_AUTH_TOKEN` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ALLOWED_ORIGINS` | leave as `chrome-extension://*` until you know your extension id |
| `HOST` | optional; defaults to `127.0.0.1`. Only the container overrides it — see `docker-compose.yml` |
| `TAVILY_API_KEY` | optional; enables company-news icebreakers on follow-ups |
| `VECTOR_STORE` | optional; `pgvector` (default) or `qdrant` |
| `QDRANT_URL`, `QDRANT_API_KEY` | required only when `VECTOR_STORE=qdrant` |

Switching `VECTOR_STORE` changes where vectors live but does not migrate an
existing corpus — re-index through the Vault, or the new store answers every
query with nothing. `pnpm --filter @crm/server eval:retrieval` prints the active
store name first for exactly this reason.

Then apply the schema and start the proxy:

```bash
pnpm --filter @crm/server migrate # creates every table, once
pnpm --filter @crm/server dev     # http://localhost:8787
curl localhost:8787/health        # {"ok":true}
```

Requires Node 20+. Node 22 is recommended — `@supabase/supabase-js` prints a
deprecation warning on 20.

#### Running it in the background

`dev` holds a terminal open and dies when you close it. To have the proxy start
at login and stay up on its own:

```bash
./scripts/macos-service.sh install
```

That registers a launchd agent (macOS). It starts the proxy now and at every
login, restarts it if it exits, and writes stdout and stderr to
`~/Library/Logs/jobsearchcrm/server.log`.

```bash
./scripts/macos-service.sh status      # registered? and is /health answering?
./scripts/macos-service.sh logs        # follow the log
./scripts/macos-service.sh restart     # after editing .env or server code
./scripts/macos-service.sh uninstall
```

`status` checks the port separately from the agent, because launchd reports a
crash-looping agent as registered — and the only question the extension cares
about is whether `/health` answers.

Run `install` **or** `dev`, not both; the second to start fails on a port
already in use. The service runs `start`, not `dev`, so it does **not** reload
on file changes — run `restart` after editing server code.

On Linux the equivalent is a systemd user unit; there is no script for it yet.

#### Running it with Docker

Docker replaces both the Node install and the launchd agent, and works the same
on macOS, Windows and Linux. Install Docker Desktop, fill in `server/.env` as
above, then from the repository root:

```bash
docker compose --env-file server/.env up -d
curl localhost:8787/health        # {"ok":true}
```

That builds one image and runs two things from it. `migrate` applies pending
migrations and exits; `server` starts only once `migrate` has exited
successfully, so a failed migration leaves you with the old schema and no
server rather than a new server talking to a half-built database.

`--env-file server/.env` is required, and **on every compose command, not just
`up`**. Compose interpolates the file before it does anything at all, so even
`docker compose ps` fails without it — with five "required variable is missing a
value" errors rather than anything about the flag. It is needed because Compose
looks in the repository root by default and the configuration lives in
`server/.env`, so that the Docker and non-Docker paths read the same file.

**If you have just reset your database password, wait two minutes before
believing `password authentication failed for user "postgres"`.** The session
pooler caches the old credential briefly, so the first run after a reset can be
rejected with a message that sounds final. Observed here with a byte-identical
connection string failing and then succeeding five minutes later with nothing
changed. Retry before you start editing anything.

**`DATABASE_URL` must be the session pooler here, not the direct connection.**
On newer Supabase projects `db.<ref>.supabase.co` has an AAAA record and no A
record, and Docker's Linux VM has no global IPv6 address, so `migrate` dies
with:

```
getaddrinfo ENOTFOUND db.<ref>.supabase.co
```

which reads like a typo and is not one. `net.connect` resolves with
`ADDRCONFIG`, which discards AAAA results on a host that cannot route them,
leaving no addresses at all — a plain `dns.lookup` in the same container still
returns the IPv6 address, so the name is fine and only the connect path fails.
The session pooler is IPv4. (Verified inside the image, 2026-10-08.)

Two deliberate details in `docker-compose.yml`, both load-bearing:

- **Only `migrate` is given `DATABASE_URL`.** The server has no code that uses
  it and should not hold a superuser password for the hours it runs (ADR-063).
  This is why the file lists variables one by one instead of handing both
  services the whole `.env`.
- **The port is published as `127.0.0.1:8787:8787`.** Dropping the prefix would
  expose the OpenAI and service-role keys to every device on your network. The
  container itself binds `0.0.0.0`, because a container's `127.0.0.1` is its own
  loopback and nothing outside can reach it; the loopback guarantee is provided
  by that publish address instead. → `docs/SECURITY.md`.

Useful afterwards:

```bash
docker compose --env-file server/.env ps            # STATUS should say (healthy)
docker compose --env-file server/.env logs -f server
docker compose --env-file server/.env restart server  # after editing server/.env
docker compose --env-file server/.env down            # stop
```

Run Docker **or** `dev` **or** the launchd agent — never two at once; the second
fails on a port already in use.

### 3. Extension

```bash
pnpm --filter @crm/extension build
```

Load `extension/build/chrome-mv3-prod` via `chrome://extensions` → Developer
mode → Load unpacked. Open the side panel, go to **Settings**, and enter the
proxy URL and the same `CRM_AUTH_TOKEN`. Nothing works until both are set.

For a tighter CORS policy, copy the extension id Chrome assigns and set
`ALLOWED_ORIGINS=chrome-extension://<id>` in `server/.env`.

Use `pnpm --filter @crm/extension dev` for hot reload during development.

## How it works

**Application tracking.** On LinkedIn Easy Apply, a submit listener scrapes the
job and posts it directly. For external ATSs the flow is a handshake, triggered
by the background worker seeing a new tab open *from* a LinkedIn job page rather
than by a click listener on the apply button — LinkedIn's button has no stable
id, class or label across their UI variants, so matching it fails silently and
looks identical to the extension being broken. The worker asks the LinkedIn tab
for its JD, writes it to `chrome.storage.local` under `pendingApplications`, and a
content script commits it once it sees a real success signal — a form submit
*plus* a `/thanks`-style URL or confirmation copy. Three independent signals
race; whichever lands first wins and the rest become no-ops.

That content script is injected on **every** site rather than on a list of ATS
vendors. The list was unwinnable: every employer picks their own platform and
several run careers pages in-house, and an unlisted vendor was not merely
degraded — the script was never injected, so the application, the JD and the
resume were lost with no symptom the user could see. It now loads everywhere and
decides for itself whether the page is worth watching, arming the expensive part
(a whole-body `MutationObserver` and a URL poll) only on evidence.

State lives in `chrome.storage.local` rather than worker memory because MV3
terminates the service worker after ~30s idle, and a Workday application takes
minutes.

When no success signal arrives at all, the handshake surfaces in the side panel
under **Awaiting confirmation** with an "I applied" / "Discard" choice.
Unconfirmed handshakes expire after two hours.

**Document vault.** A capture-phase `change` listener reads the PDF off the file
input and hands the bytes to the background worker immediately — not when the
submission is confirmed, because the content script dies on the next navigation
and the confirmation page is almost always a new document. The worker holds them
until an application is tracked, so an abandoned form never records a resume.

Because the script loads site-wide, capture is gated on the page actually being
a job application: a PDF you attach to a bank form or a LinkedIn message is
never read. You are shown a toast every time a resume *is* captured.

When several documents are attached, a cover letter never
displaces the CV. The server extracts the text, chunks it with overlap, embeds
with `text-embedding-3-small`, stores the PDF in the private `resumes` bucket,
and renames it to `<Name>_<Company>_<Role>.pdf` so the vault is legible without
opening anything. Re-uploading deletes the previous file **and** its vectors, so
a draft can never cite a resume you did not send.

**Entity mapping.** Clicking Connect on a profile scrapes name, headline and
company, then fuzzy-matches against your tracked jobs with trigram similarity.
One match auto-links; several raise a disambiguation toast; none falls back to
General Networking. The match runs on contact capture *and* on job creation, so
connecting before you apply resolves identically to connecting after.

**Drafting.** A ReAct loop over four tools — `classify_persona`,
`execute_hybrid_search`, `check_company_message_history` and
`find_recent_company_news` — picks the persona, retrieves the most relevant
resume bullets, and avoids repeating anything you already said to that company.

Retrieval runs **two lenses**. Lens A is the person being written to — their
headline *and* the About/Experience text from their own profile, which is what
finds shared ground; a headline alone is a slogan and is often blank. Lens B is
what someone in their role judges a candidate by, *while screening for the role
you actually applied to*, with that role's own keywords on the sparse leg.

Steering with the job description alone gives a CTO and a support coordinator the
same three bullets, which is the failure the lenses exist to fix; a third JD-only
lens used to exist and was deleted for being exactly that failure wearing a
lens's clothes. Naming the role inside Lens B is not a revival of it — the
persona clause still varies per reader, and a test pins that.

The role has to reach *every* ranking signal, not just the prompt. It once
reached only the prompt, and the result was a recruiter screening an Oracle
Fusion HCM vacancy being sent a client-satisfaction score from an unrelated
project: top-ranked, and perfectly on-brief for the question the system had
actually asked, which was "what is most impressive about this candidate?"

Each lens fuses a pgvector cosine ranking with a Postgres full-text ranking via
Reciprocal Rank Fusion (k=60), and the two lenses are then fused with each other
at k=1.

Fusion is not the last word. Eight fused candidates go to an **LLM reranker**
(`server/src/rag/rerank.ts`), which grades each 0–2 on whether it gives *this*
reader something to reply to and drops the zeroes. Fusion cannot solve the
problem it was hitting: the resume's skills wall and education block were ranked
top-2 by both legs of both lenses, so they took 11 of 18 evidence slots no
matter how the rankings were combined. The reranker can score them 0, because it
can tell that a list of technologies contains no claim. It reorders and drops
only, never invents, fails open to the fused order, and never returns nothing.

Every draft is then machine-checked by `server/src/agent/critique.ts` and
repaired up to twice. It rejects contentless phrases, more than one question, a
draft that never names the role, a question the recipient's job could not
answer, and **any number that does not appear in the retrieved resume text**. A
rule that lives only in the prompt is a preference; the model wrote "passionate
about" anyway. A repair is kept only if it scores better on
`(ungrounded figures, style problems)` read left to right — a fabricated
statistic is not tradeable against a stray exclamation mark.

**Follow-ups.** A jittered `chrome.alarms` sweep moves contacts through
`Pending → Accepted → Replied`, and flags `Follow_Up_Required` after the silence
window. Entering `Accepted` writes an outreach draft automatically; entering
`Follow_Up_Required` writes a follow-up. You find a message waiting rather than
having to notice the acceptance yourself.

Acceptance is detected **without ever opening a contact's profile** — LinkedIn
reports a profile view to the person viewed. Instead one minimized background
window reads two of your *own* pages, Sent invitations and Connections, and the
entire watchlist is reconciled against that single snapshot. A sweep costs two
page loads no matter how many contacts it covers.

Reply *detection* works; reply **drafting does not exist** — the reply text is
never captured. See [`docs/PRD.md`](docs/PRD.md) → Known gaps.

## Security model

Five constraints from the PRD are load-bearing, not incidental:

1. **No private LinkedIn APIs.** Only `document.querySelector` against rendered
   DOM.
2. **The system never clicks Send.** Content scripts inject text into the
   `<textarea>` and add an outline to LinkedIn's own Send button. There is no
   `dispatchEvent` on that button anywhere in
   `extension/src/contents/linkedin-messaging.ts`, and it must stay that way.
3. **A contact's profile is never opened to check on them.** LinkedIn reports a
   profile view to the person viewed, so polling that way would mean pestering
   the exact people you are trying to impress. Only your own Sent-invitations
   and Connections pages are read.
4. **Rate limiting.** Background sweeps are spaced 30–90 minutes at random and
   suspended between 22:00 and 07:00. A sweep opens one minimized window and
   loads two pages — its cost does not grow with the size of your network.
5. **Keys stay server-side.** The service-role key bypasses RLS and is only ever
   reachable from the proxy process. The extension holds a shared secret that
   grants nothing but access to your own proxy.

Full threat model and checklist: [`docs/SECURITY.md`](docs/SECURITY.md).

## Deviations from the PRD

**PDF parsing runs on the server, not in the browser.** The PRD specifies
in-browser pdf.js. MV3 content scripts execute in the host page's origin, so
pdf.js's web worker is blocked by LinkedIn's and most ATS platforms' CSP.
Working around it means an offscreen document, and it buys nothing: the PDF is
uploaded to Supabase Storage regardless, so it leaves the device either way.
`UploadResumeRequest` still accepts a pre-extracted `extractedText` if a client
can produce one.

**The sparse leg is Postgres full-text search, and it is not BM25.**
`ts_rank_cd` over a generated `tsvector` column: cover density, with **no IDF
term and no k1/b**. So a word that appears in every chunk is not discounted, and
saturation and length normalisation are not tunable — two things a reader who
sees "BM25" will assume are there. It fills the same slot in the fusion and
needs no extra search infrastructure, which is the whole reason for the
trade-off. → ADR-007.

**Resumes store a `storage_path`, not a blob.** Postgres is a poor place for
multi-megabyte binaries; the bytes live in a private Storage bucket.

## Development

Run all three after every change:

```bash
pnpm -r typecheck
pnpm --filter @crm/server test      # 240 tests / 47 suites, node:test
pnpm --filter @crm/extension build
```

Or as one command, `pnpm verify`.

Then verify no content-script bundle picked up zod — the barrel export pulls it
in, which is why extension code imports runtime values from
`@crm/shared/constants`:

```bash
cd extension/build/chrome-mv3-prod && grep -c zod *.js ; true
```

Every count must be `0`.

Everything tested is pure — arguments in, value out, no database, no network.
The suites cover draft critique, persona classification, resume naming, the
chunker, keyword extraction, the `toOrQuery` sparse-query builder, company
matching, headline company extraction, the polling cadence constraints, RRF
fusion, the retrieval metrics, the faithfulness grader, and the labelled eval
set itself.

### Evals

```bash
pnpm --filter @crm/server eval:retrieval   # precision/recall/MRR/nDCG, per leg
pnpm --filter @crm/server eval:drafting    # faithfulness + evidence overlap
```

Both seed a throwaway job and resume into the configured Supabase project and
tear it down afterwards, so do not point them at a database you care about.
Retrieval is cheap (embeddings only); drafting runs six full agent loops.

**Both exit non-zero when a floor in `server/src/eval/gates.ts` is breached.**
They used to print `FAIL` and return success, which meant the one defect the
persona pipeline exists to prevent — two recipients receiving a byte-identical
draft — could ship past the script written to catch it. The floors sit *below*
the recorded baseline on purpose: the reranker is an LLM call, so ±1 rank of
wobble between identical runs is noise, and a gate that fires on noise gets
bypassed. `pnpm verify:release` runs everything above plus both evals; it is a
release gate, not a per-commit one, because it spends real credit.

Read [`docs/EVALUATION.md`](docs/EVALUATION.md) before changing anything under
`server/src/rag/` or `server/src/agent/` — it explains what a bad number means,
and why there is deliberately no LLM judge.

### Observability

Every call to `generateDraft` writes one row to `draft_runs`: the evidence chunk
ids the agent was shown, how many figures in the shipped draft appear in none of
it, critique problems, repair passes, tokens and model calls summed across the
*whole* run, latency, and the error if it failed. Faithfulness and cost over any
window are a SQL query rather than a number someone has to remember to compute.
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) → Observability.
