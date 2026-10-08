# Architecture

How the system is built and why the pieces sit where they do.

## Stack

| Layer | Choice |
| --- | --- |
| Extension | Plasmo 0.89, Manifest V3, React 18, TypeScript |
| Extension styling | Tailwind CSS 3 (side panel), inline shadow-DOM CSS (in-page toasts) |
| Extension storage | `chrome.storage.local` via `@plasmohq/storage` |
| Backend | Hono 4 on `@hono/node-server`, Node 20+, TypeScript, `tsx` |
| Database | Supabase Postgres + `pgvector` + `pg_trgm` |
| File storage | Supabase Storage, private `resumes` bucket |
| Embeddings | OpenAI `text-embedding-3-small` (1536 dims) |
| Drafting model | OpenAI `gpt-4o-mini` |
| Optional web search | Tavily (company-news icebreakers) |
| Validation | zod, shared between client and server |
| Tests | `node:test` + `tsx` |
| Package manager | pnpm workspaces (monorepo) |

There is **no hosted deployment**, and there is no shared backend. Every install
runs the whole system on one person's machine: the proxy on loopback, an
unpacked extension in Chrome, and that person's own Supabase project and OpenAI
key. What ships is a *packaging* of that, not a service — a published container
image (`ghcr.io/kssharda0717-dev/job-search-crm`, amd64 + arm64) and a prebuilt
extension zip on each `v*` tag, so installing needs no Node, pnpm or git. The
proxy still holds a service-role key that bypasses RLS, which is why it binds
loopback and why hosting it for other people is out of scope permanently.

## Three processes, one contract

```
┌─────────────────────── Chrome ───────────────────────┐
│                                                      │
│  Content scripts          Service worker   Side panel│
│  (page origin)            (extension)      (React)   │
│  • linkedin-jobs          • holds token    • Jobs    │
│  • linkedin-profile       • all fetch()    • Contacts│
│  • linkedin-messaging     • alarms         • Drafts  │
│  • apply-watch (all URLs) • handshakes     • Vault   │
│         │                 • resume stash   • Settings│
│         │ runtime msg          ▲  │             ▲    │
│         └─────────────────────►│  │             │    │
│                                │  └─ broadcast ─┘    │
└────────────────────────────────┼─────────────────────┘
                                 │ HTTPS + x-crm-token
                                 ▼
                    ┌────────────────────────┐
                    │  Hono proxy :8787      │
                    │  • zod validation      │
                    │  • RAG / hybrid search │
                    │  • ReAct drafting agent│
                    │  • follow-up engine    │
                    │  holds: OPENAI_API_KEY │
                    │         SERVICE_ROLE   │
                    └───────────┬────────────┘
                                │
              ┌─────────────────┴──────────────────┐
              ▼                                    ▼
    ┌──────────────────┐              ┌────────────────────┐
    │ Supabase Postgres│              │ Supabase Storage   │
    │ jobs, resumes,   │              │ resumes bucket     │
    │ resume_chunks,   │              │ (private)          │
    │ contacts,messages│              └────────────────────┘
    │ + pgvector RRF fn│
    └──────────────────┘
```

### Why a proxy at all

A browser extension cannot hold an OpenAI key or a Supabase service-role key.
Both would be readable by anyone who unpacks the extension, and an MV3 content
script shares an origin with the page it runs in. The proxy is the only process
that holds either. The extension holds a single shared secret (`CRM_AUTH_TOKEN`)
which grants nothing except access to the user's own proxy.

### Why only the service worker calls the API

Content scripts execute in LinkedIn's origin. A `fetch` from there would be
subject to LinkedIn's CORS policy and would put the auth token in page context
where any script on the page could read it. Content scripts therefore send
`chrome.runtime` messages; the worker is the only caller of `lib/api.ts`.

### Why state lives in `chrome.storage.local`

MV3 terminates the service worker after roughly 30 seconds of idle. A Workday
application takes minutes. Anything that must survive that — pending
handshakes, the resume stash, the tab→job map, settings — is written to storage,
never held in a module-level variable.

## Folder structure

```
CRM/
├── docs/                       ← this documentation set
├── Dockerfile                  One image, two commands (`start` and `migrate`)
├── docker-compose.yml          Names the published image; deliberately no `build:`
├── docker-compose.build.yml    Opt-in override that builds from this tree
├── .github/workflows/
│   ├── ci.yml                  `pnpm verify` + the content-script zod grep
│   └── release.yml             On a `v*` tag: re-verify, push GHCR, attach the zip
├── packages/shared/src/
│   ├── types.ts                Domain entities (zod schemas + inferred types)
│   ├── api.ts                  Request/response contracts for every route
│   ├── constants.ts            Runtime-import-free shared values
│   ├── profile-text.ts         Dedupe/cap/condense a scraped profile (zod-free)
│   ├── vault.ts                documentRank + acceptsDelivery (zod-free)
│   ├── job-title.ts            Is this a job title or LinkedIn furniture? (zod-free)
│   └── index.ts                Barrel; re-exports all of the above
│
├── server/
│   ├── src/
│   │   ├── index.ts            Hono app: CORS, auth middleware, error handler
│   │   ├── routes.ts           Every HTTP route; zod parse at the boundary
│   │   ├── env.ts              zod-validated process.env (throws at import)
│   │   ├── db.ts               Supabase service-role client + `unwrap()`
│   │   ├── rag/
│   │   │   ├── pdf.ts          pdfjs-dist text extraction
│   │   │   ├── chunk.ts        Section-boundary chunking with overlap
│   │   │   ├── embeddings.ts   OpenAI embeddings client
│   │   │   ├── index-resume.ts Store → extract → chunk → embed → persist
│   │   │   ├── keywords.ts     Role keywords from JD + title, `toOrQuery`
│   │   │   ├── lens-query.ts   Lens B's dense query (pure; see note below)
│   │   │   ├── search.ts       Two-lens retrieval, then rerank
│   │   │   ├── fuse.ts         RRF within a lens (k=60) and across lenses (k=1)
│   │   │   ├── rerank.ts       LLM grades 0–2 on domain + reader fit, fails open
│   │   │   ├── grades.ts       Parsing/applying those grades (pure; see note below)
│   │   │   ├── embedding-guard.ts  Refuse a corpus embedded by another model
│   │   │   ├── store/          `VectorStore`: pgvector | qdrant
│   │   │   └── resume-name.ts  Canonical `<Name>_<Company>_<Role>.pdf`
│   │   ├── agent/
│   │   │   ├── draft.ts        System prompt + ReAct loop + repair/shorten
│   │   │   ├── tools.ts        Tool schemas and dispatch
│   │   │   ├── draft-policy.ts Whether to draft at all (pure; see note below)
│   │   │   ├── persona.ts      Rule-based headline → persona
│   │   │   ├── thread.ts       Prior messages rendered for the prompt (pure)
│   │   │   └── critique.ts     Machine critique of a draft (pure)
│   │   ├── observability/
│   │   │   ├── meter.ts        Token/call accounting for one run (pure)
│   │   │   └── draft-run.ts    Writes `draft_runs`; never fails a run
│   │   ├── eval/
│   │   │   ├── run-retrieval.ts, run-drafting.ts   The two harnesses
│   │   │   ├── gates.ts        Committed floors; sets a non-zero exit code
│   │   │   └── metrics.ts, faithfulness.ts, dataset.ts, seed.ts
│   │   ├── migrate/
│   │   │   ├── plan.ts         What to apply, in what order (pure; checksums)
│   │   │   └── run.ts          Holds the Postgres connection + `DATABASE_URL`
│   │   └── services/
│   │       ├── contacts.ts     Capture, enrich, backfill-link
│   │       ├── company-match.ts Company name normalisation + containment rule
│   │       └── followup.ts     State machine + stale-contact sweep
│   └── test/*.test.ts          node:test suites over the pure modules
│
├── extension/src/
│   ├── contents/               Injected into web pages
│   │   ├── linkedin-jobs.ts        linkedin.com/* — Easy Apply + handshake source
│   │   ├── linkedin-profile.ts     linkedin.com/* — Connect capture, enrich
│   │   ├── linkedin-messaging.ts   /messaging/*, /in/* — inject draft, detect reply
│   │   └── apply-watch.ts          http(s)://*/* except LinkedIn — ATS submit
│   ├── background/             Service worker
│   │   ├── index.ts                Message router; the only API caller
│   │   ├── poller.ts               Alarm, sweep, draftFor, missed invitations
│   │   ├── network-scan.ts         Reads the user's own network pages
│   │   ├── handshake.ts            Pending applications in storage
│   │   └── resume-stash.ts         Parked PDF bytes + which job may claim them
│   ├── sidepanel/              React UI
│   │   ├── tabs.tsx                Jobs / Contacts / Drafts / Vault
│   │   ├── components.tsx          Section, Card, Button, Badge, Empty
│   │   ├── hooks.ts                useCrmData, usePendingApplications
│   │   └── Settings.tsx            Proxy URL, token, name, polling
│   ├── lib/
│   │   ├── api.ts                  Typed proxy client (worker-only)
│   │   ├── messaging.ts            Message kinds + typed sendToBackground
│   │   ├── settings.ts             chrome.storage-backed settings
│   │   ├── dom.ts                  Safe DOM helpers for scraping
│   │   ├── toast.ts                Shadow-DOM in-page toast
│   │   ├── resume-capture.ts       Capture-phase file input listener
│   │   ├── encoding.ts             base64 helpers
│   │   └── scrapers/
│   │       ├── linkedin.ts         Job, profile, connections, invitations
│   │       └── ats.ts              Vendor detection, success signals
│   └── sidepanel.tsx           Panel shell and tab routing
│
└── supabase/migrations/
    ├── 0001_init.sql                       Schema, pgvector, RRF, trigram match
    ├── 0002_storage_and_rls.sql            Bucket + deny-all RLS
    ├── 0003_adjacent_employee_persona.sql  enum value
    ├── 0004_founder_executive_persona.sql  enum value
    ├── 0005_sparse_rank_length_normalization.sql
    ├── 0006_split_dense_and_sparse_search.sql  dense/sparse RPCs, drops hybrid
    ├── 0007_record_embedding_model.sql      which model embedded each chunk
    ├── 0008_draft_runs.sql                  one row per drafting run
    ├── 0009_escape_like_and_unique_chunks.sql  escape_like(); unique chunk key
    ├── 0010_contact_profile_text.sql        contacts.profile_text, profile_read_at
    ├── 0011_one_unsent_draft_per_contact.sql
    ├── 0012_message_review.sql              messages.review
    ├── 0013_corpus_wide_search_for_unlinked_contacts.sql  p_job_id may be null
    └── 0014_record_accepted_repairs.sql     rewrites kept, not just attempted
```

Migrations are append-only and the full list, with the consequence of skipping
each one, is in [`README.md`](../README.md) under Setup. Keep this tree and that
list in step; the next free number is **0015**.

## Data model

```
jobs ──1:1── resumes ──1:N── resume_chunks (embedding vector(1536), fts tsvector)
 │                                │
 │                                └── scoped by job_id (denormalised, no join)
 ├──1:N── contacts (job_id nullable = "general networking")
 │             │
 └──1:N── messages ──── contact_id
```

Enums are Postgres types, not check constraints:
`job_status`, `contact_status`, `persona`, `message_type`, `apply_source`.
Adding a persona therefore requires its **own migration file** —
`alter type … add value` cannot run inside a transaction with other statements.

Three database functions carry real logic:

- `dense_search_resume_chunks(job_id, embedding, limit)` — pgvector cosine.
- `sparse_search_resume_chunks(job_id, query_text, limit)` — `ts_rank_cd` with
  the length-normalisation flag.

  Both take `job_id` **nullable** as of migration 0013. A null means "this
  contact has no application", not "all applications": there is no role to leak
  into, and the corpus is the candidate's own resumes either way. A non-null
  `job_id` behaves exactly as before, so the invariant *retrieval must never
  cross applications* is intact. ADR-056.
- `match_jobs_by_company(company, threshold)` — bidirectional `ILIKE`
  containment plus trigram `similarity`, ordered by similarity. Both sides go
  through `escape_like()` (migration 0009), whose TypeScript twin is
  `escapeLikePattern()` in `services/company-match.ts`. **Keep the two in
  step** — without it `100% Remote` matched every tracked job.

Reciprocal Rank Fusion is **not** in the database. It lives in
`server/src/rag/fuse.ts` so it can be unit-tested, so the eval can score each
leg separately, and so the dense leg can be served by something other than
Postgres (ADR-034). Both legs over-fetch `max(limit*10, 30)`, because RRF is
meaningless without depth in each leg.

### Vector store

`server/src/rag/store/` — a `VectorStore` interface with two implementations,
chosen by `VECTOR_STORE` in the server env:

| | `pgvector` (default) | `qdrant` |
|---|---|---|
| Dense leg | HNSW cosine in the same Postgres as the rows | Qdrant collection, filtered on a `job_id` payload index |
| Sparse leg | `ts_rank_cd` | delegated to Postgres |
| Chunk ids | Postgres-generated | mirrored from Postgres |

The interface returns **ranks, never scores** (ADR-035). Switching the setting
does not migrate an existing corpus; the new store answers every query with
nothing until the resume is re-indexed through the Vault.

### Embedding-space guard

`resume_chunks.embedding_model` records which model produced each vector, and
`retrieveLegs()` — the one chokepoint every retrieval path including the eval
goes through — throws when the corpus was not embedded by the model the server
is about to embed the query with.

This exists because the dangerous change is invisible. A *width* change fails at
the insert: `vector(1536)` rejects it. A same-width swap does not —
`text-embedding-ada-002` is also 1536 dimensions, so every write succeeds, every
query succeeds, cosine distance keeps returning numbers, and the ranking is
noise. See ADR-040.

### Observability

One row in `draft_runs` per call to `generateDraft`, written by
`observability/draft-run.ts`: the evidence chunk ids the agent was shown,
ungrounded figures in the shipped draft, critique problems, repair passes,
prompt/completion tokens, model calls, latency, and `error`.

Tokens are summed across the **whole** run by a `UsageMeter` threaded on
`ToolContext` — ReAct turns, the rerank call, repair passes, shorten pass —
because reporting the drafting completion alone undercounts by more than half,
and worst when the run went badly. Failed runs are recorded too; recording never
throws. See ADR-041.

Faithfulness over any window is now a query rather than something to remember to
measure:

```sql
select date_trunc('day', created_at) as day,
       count(*)                                     as runs,
       avg((ungrounded_figures = 0)::int)           as clean_rate,
       avg(prompt_tokens + completion_tokens)       as mean_tokens,
       percentile_cont(0.95) within group (order by latency_ms) as p95_ms
  from draft_runs
 where error is null
 group by 1 order by 1 desc;
```

## HTTP surface

Every route is under `/api` and every one of them requires the `x-crm-token`
shared secret; `/health` is the only unauthenticated path. Request and response
bodies are the zod schemas in `packages/shared/src/api.ts`, parsed at the
boundary by `parseBody()`, so this table is a map rather than a contract — the
schemas are the contract.

| Method | Path | Body / query | What it does |
| --- | --- | --- | --- |
| `GET` | `/health` | — | Liveness. The Settings tab's "Test connection". |
| `GET` | `/api/jobs` | — | Every tracked application. |
| `POST` | `/api/jobs` | `CreateJobRequest` | Upserts on `(lower(company), external_job_id)`, then runs `linkContactsForJob`. |
| `PATCH` | `/api/jobs/:id` | `UpdateJobRequest` | Status/title/company/JD. Re-runs company matching when the company changes. |
| `POST` | `/api/resumes` | `UploadResumeRequest` | Store → extract → chunk → embed → persist. Refuses to overwrite without `replace: true`. |
| `GET` | `/api/resumes` | — | The vault listing. |
| `GET` | `/api/resumes/:id/download` | — | 60-second signed URL; the bucket is private. |
| `GET` | `/api/contacts` | — | Every contact, with its linked job. |
| `POST` | `/api/contacts/capture` | `CaptureContactRequest` | Upserts on `linkedin_url`; resolves the company to a job or reports ambiguity. |
| `POST` | `/api/contacts/enrich` | `EnrichContactRequest` | Fills **only** currently-null columns. Deliberately not capture: capture would reset `status`. |
| `PATCH` | `/api/contacts/:id` | `UpdateContactRequest` | Status, job link, persona. |
| `POST` | `/api/search/hybrid` | `HybridSearchRequest` | Retrieval without drafting. Not called by the extension — it exists so the two legs and the fusion can be exercised from `curl` against a real corpus, which is the only way to tell a ranking regression from a prompt regression. |
| `GET` | `/api/messages` | — | Drafts and sent messages. |
| `POST` | `/api/drafts` | `DraftRequest` | The ReAct loop below. |
| `POST` | `/api/messages/:id/sent` | `MarkSentRequest` | Records what the user actually sent, and advances the contact. |
| `DELETE` | `/api/messages/:id` | — | Discards an unsent draft. |
| `POST` | `/api/sync/observations` | `SyncObservationsRequest` | Reconciles scraped accept/reply state; returns who now needs a draft. |
| `GET` | `/api/sync/watchlist` | — | Which profiles the background sweep should look at. |

## Request flows

### Applying on an external ATS

```
user clicks "Apply on company website" on a LinkedIn job page
  └─ chrome.tabs.onCreated fires in the worker (opener = a /jobs/ tab)
       └─ worker asks the LinkedIn tab: SCRAPE_JOB
            └─ content script returns company/title/location/JD text
                 └─ beginHandshake() writes PendingApplication to storage
                      └─ ... user fills in the ATS form ...
                           └─ apply-watch sees submit + success URL/text
                                └─ COMMIT_HANDSHAKE → POST /api/jobs
                                     └─ linkContactsForJob() reconciles contacts
                                     └─ deliverResume() uploads the stashed PDF
```

Three success signals race (`form submit`, success URL, confirmation copy);
the first wins and the rest become no-ops. Unconfirmed handshakes expire after
`HANDSHAKE_TTL_MS` (2 h) and surface in the panel as "Awaiting confirmation".

`resolveHandshake()` commits an **exact tab match** outright. Failing that it
falls back across tabs only when there is **exactly one** handshake younger than
`CROSS_TAB_FALLBACK_MS` (10 min); two candidates, or one stale one, return null
and the user gets the manual "Track this application?" toast instead. The old
newest-wins reduce had no time or ambiguity bound, so a posting merely *browsed*
hours earlier could capture a submission on a different site — and because
`POST /jobs` upserts on `(lower(company), external_job_id)`, a borrowed
requisition id does not create a row, it silently **UPDATEs someone else's**.

`deliverResume()` no longer files whatever is stashed. It asks
`acceptsDelivery()` (`@crm/shared/vault`), which requires the tracked job to be
under 10 min old **and** the incoming file to outrank what has already been
delivered (`documentRank`: cover letter 0 < unknown 1 < resume 2). Without that,
a tracked job claimed files forever and each application's CV landed on the
previous one. See ADR-047.

### Drafting a message

```
POST /api/drafts { contactId, type }
  └─ introduction already SENT to this contact? → return it (never redraft)
  └─ existing unsent draft of this type? → return it (no second path),
       unless the profile was read after it was written (draftPredatesProfile)
  └─ seed ctx.persona from personaFromHeadline(contact.headline)
  └─ load everything already SENT to this contact
       └─ threadBlock() renders it into the task prompt, above the
          reflection section — not a tool call, not optional
  └─ ReAct loop, ≤ 6 turns, gpt-4o-mini, temp 0.7
       ├─ classify_persona     (rules veto the model if they disagree)
       ├─ execute_hybrid_search → searchResumeForRecipient()
       │     ├─ lens A: recipient's headline + their profile text
       │     └─ lens B: PERSONA_CONCERNS + the role applied to,
       │          with extractRoleKeywords(jd, title) on the sparse leg
       │     each lens: dense ⊕ sparse, RRF k=60, depth 8
       │     fuseLenses(): RRF across the two lenses, k=1, take 8
       │     rerankForRecipient(): gpt-4o-mini grades each 0–2 on
       │       domain-of-the-role first, reader fit second;
       │       drops the zeroes, take 3 — fails open to the fused order
       ├─ check_company_message_history (OTHER people at this company;
       │     what was sent to THIS contact is already in the prompt)
       └─ find_recent_company_news (optional, Tavily)
  └─ critiqueDraft(draft, {name, role, persona, evidence,
                           priorMessages, company, anchors, jdText})
       ├─ repeatsThread()  — repeated figure / repeated ask / repeated claim,
       │     with the role title and the company excluded, because the draft is
       │     required to name both and flagging them makes the critique
       │     unsatisfiable
       ├─ echoesJobDescription() — the same trigram machinery pointed at the
       │     ADVERT instead of the thread. The recipient often posted it and
       │     will recognise their own words. Excludes the role, the employer,
       │     anything the resume genuinely contains, and the closing question;
       │     reports ONE problem however many runs match. jdText is clipped at
       │     JD_PROMPT_CHARS, the same constant the prompt uses, so the check
       │     judges the draft against the text the model actually saw. ADR-058.
       └─ ABSTRACT_SUBJECT — the closing question is rejected when its subject
             is a category noun ("skills", "challenges", "insights") and
             nothing in it is an askAnchors() term. Structure, not wording:
             a deny-list of phrasings is something repairDraft is paid to walk
             around. ADR-050. The role and the employer are SUBTRACTED FROM
             the headline before anchoring — RULE 2 puts both in every opening
             message, and a headline usually leads with the employer, so
             withholding them as direct anchors is not enough. ADR-059.
       └─ problems? ≤ 2 repair turns; keep a rewrite only if it scores better
         on (ungrounded figures, style problems) read left to right. Attempts
         and kept rewrites are counted separately — repair_passes and
         repair_accepted (migration 0014), because a run can spend both calls
         and ship the draft it started with. ADR-062.
  └─ over the char limit? one shorten turn, then truncate at a word boundary
  └─ repairFigures() has the last word on numbers, after the shorten pass has
       had its turn at rewriting the sentences they live in. Rejected if it
       would push the draft back over the limit. ADR-055.
  └─ review = { evidenceCount, problems, ungroundedFigures,
                summaryOnlyFigures, repairPasses },
       scored on the FINAL text and stored on the row (migration 0012). The
       panel reads it; `draft_runs` reports from the same object, so telemetry
       and UI cannot disagree. ADR-054.
       summaryOnlyFigures is the one finding the repair loop is NOT given: a
       figure whose only retrieved source is a summary section cannot be
       attributed by anything the repair pass can see either, so all it could
       do is delete it — and RULE 4 demands a concrete fact. Reader-only.
       ADR-060. The clean state names the checks that ran, never a verdict:
       these compare figures and phrasing against retrieved text and have no
       opinion on whether the message is true. ADR-061.
  └─ INSERT into messages (draft_text, review; sent_at stays null)
       └─ unique (contact_id, type) WHERE sent_at IS NULL (migration 0011);
          a 23505 returns the draft that won the race rather than throwing
```

`generateDraft` also holds an `inFlight` map keyed `contactId:type`. The index
stops the duplicate *rows*; the map stops a second ReAct loop being paid for.

### Marking a message sent

```
POST /api/messages/:id/sent
  └─ messages: sent_text, sent_at = now()
  └─ contacts: status Follow_Up_Required → Accepted, scoped to that contact
```

The second write is not a convenience. `Follow_Up_Required` was a one-way edge —
the sweep wrote it and nothing ever wrote it back — so a contact who had been
chased stayed flagged forever and the panel kept telling the user to do the
thing they had just done. The general rule, ADR-051: **any write that changes
what the system should do next reconciles the state that decides it, in the same
request.** A 30–90 minute sweep is not a substitute. The `.eq("status",
"Follow_Up_Required")` guard is what keeps this from clobbering `Replied`.

### The follow-up engine

`sweepStaleContacts()` runs **only** at the end of `syncObservations()`. Any
caller that skips `syncObservations` when it has nothing to report switches the
follow-up engine off. This is a load-bearing invariant — see
`docs/DECISIONS.md` ADR-014.

It sweeps **`Accepted` and `Follow_Up_Required` both**. The sweep that finds a
stale contact is also the sweep that moves them into `Follow_Up_Required`, so
selecting only `Accepted` gave each contact exactly one chance at a draft and no
retry if it failed — which stranded 3 of 4 contacts for six days. Repetition is
bounded instead by `MAX_FOLLOW_UPS_PER_CONTACT` (2), counted from messages
actually **sent**. See ADR-048.

A draft the user does not want is removed with `DELETE /api/messages/:id`, which
refuses a sent message with 409. This is not only a UI affordance: the sweep
treats an unsent draft as work in progress, so without a way to discard one, a
rejected draft excluded that contact from every future sweep.

## Architectural rules

These are the rules a change is reviewed against.

### Boundaries

1. **Content scripts never call the API.** They send runtime messages. Only
   `background/` imports `lib/api.ts`.
2. **The auth token never leaves the service worker.** Not into page context,
   not into a content script, not into a URL.
3. **React components never call `fetch` directly.** The side panel calls
   `lib/api.ts` (same extension context, so this is allowed) or
   `sendToBackground`. It never constructs a request by hand.
4. **Routes contain no business logic.** `routes.ts` parses, delegates to a
   service, and serialises. Logic lives in `services/`, `rag/` or `agent/`.
5. **Nothing outside `server/src` imports `env.ts`.** It throws at import time,
   which would make pure modules untestable.

### Validation and types

6. **Every request body is parsed with a zod schema from
   `@crm/shared`** at the route boundary, never trusted.
7. **The contract is shared, not duplicated.** If the client and server
   disagree about a shape, the fix is in `packages/shared`, not a cast.
8. **Import shared constants from `@crm/shared/constants`, never
   `@crm/shared`,** in any extension code. The barrel pulls in zod; the
   subpath is runtime-import-free. A zod-bearing content script bundle is a
   regression.

### Purity and testability

9. **Logic worth testing must be pure.** `critique.ts`, `persona.ts`,
   `draft-policy.ts`, `chunk.ts`, `keywords.ts`, `lens-query.ts`, `grades.ts`,
   `embedding-guard.ts`, `resume-name.ts`, `company-match.ts` and
   `migrate/plan.ts` take arguments and return values — no database, no
   network, no `env`.

   This is why they are separate files rather than functions inside
   `search.ts`, `rerank.ts` or `draft.ts`. `rag/embeddings.ts` constructs the
   OpenAI client from `env` at module load and `env` throws when unset, so
   **anything reachable from that import graph is unreachable from a unit
   test**. Pulling a pure function out into its own module is the cheapest way
   to make it testable; do that rather than mocking `env`.

   **`pnpm verify` cannot catch a violation of this rule on your machine.**
   `server/.env` sits beside the code, dotenv loads it, `env.ts` is satisfied.
   CI has no `.env` and is the only place the rule is enforced — which is how
   `grades.ts` and `draft-policy.ts` came to exist: the first push reported 238
   passing where local said 260, with two suites dead at import and 20 tests
   that had never once run clean.
10. **A rule the model must follow is enforced in code, not only in the
    prompt.** Prompt text is a preference; `critiqueDraft` is enforcement.

### Persistence

11. **Any write that can change a company relationship reconciles it.**
    `POST /jobs`, `PATCH /jobs/:id`, `POST /contacts/capture` and
    `POST /contacts/enrich` all run the match.
12. **Link only on a single match.** Two applications at one employer is
    refused, never guessed.
13. **Re-indexing a resume deletes the old chunks.** Stale vectors would let a
    draft cite a CV the user never sent.

### Extension specifics

14. **MV3-durable state goes in `chrome.storage.local`.** Never a module
    variable that must survive a navigation or an idle timeout.
15. **Scrape by what a control *says*, not by an `aria-label` LinkedIn may
    drop.** Three separate controls have already broken that way, silently.
16. **Never open a contact's profile to check on them.** Read the user's own
    pages instead.
17. **Never dispatch a click on LinkedIn's Send button.** Non-negotiable; see
    `docs/SECURITY.md`.
