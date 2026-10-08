# Architecture Decision Records

Permanent decisions. `docs/MEMORY.md` holds current state; this file holds the
things that must not be quietly reversed.

Each record says what was decided, **why**, and — where it matters — what was
tried first and failed. An agent proposing to change one of these must argue
against the reason, not restate the alternative.

---

## ADR-001 — Supabase Postgres + pgvector, not a separate vector DB

**Decision.** One Postgres holds the relational data *and* the embeddings.

**Reason.** The retrieval query is always scoped to a single application's
resume (`where job_id = …`). A dedicated vector store would mean a second
system, a second consistency problem, and a metadata filter that Postgres gives
for free with a `where` clause. `pgvector` HNSW is far more than enough for a
few hundred chunks per user.

## ADR-002 — A local proxy holds the keys; the extension never does

**Decision.** `server/` holds `OPENAI_API_KEY` and
`SUPABASE_SERVICE_ROLE_KEY`. The extension holds only `CRM_AUTH_TOKEN`.

**Reason.** An unpacked extension's bundle is readable by anyone with the
directory, and `chrome.storage` is readable by anyone with the profile. A
provider key in there is a key that is spent by someone else. This is a **hard**
PRD constraint.

**Consequence.** The product cannot work without the user running a Node
process. Accepted: the target user is a software engineer.

## ADR-003 — RLS enabled with zero policies

**Decision.** Row-level security is on for all five tables and **no policy is
defined**.

**Reason.** Deny-all by default. The proxy's service role bypasses RLS, so the
app works; a leaked anon key grants nothing at all. Writing permissive policies
for a single-user tool would only create a way to get them wrong.

**Rejected.** Per-user policies. There is no user table and no auth — see
ADR-004.

## ADR-004 — Single-user, no account system

**Decision.** No `users` table, no login, no per-row ownership. One shared
bearer token on `x-crm-token`.

**Reason.** One person, one proxy on `localhost`, one database. Auth would be
ceremony around a boundary that does not exist. Adding it later means a
migration, not a rewrite.

## ADR-005 — PDF text extraction runs on the server

**Decision.** `server/src/rag/pdf.ts` parses the PDF. The extension uploads
bytes.

**Reason.** Deliberately deviates from the PRD's original sketch. An MV3 content
script inherits the **host page's origin and CSP**, so pdf.js cannot spawn its
worker on LinkedIn or on a Workday ATS page. It fails at the exact moment the
resume is submitted, which is the only moment it matters. Do not move this back
into the browser.

## ADR-006 — Resumes live in Storage; the DB stores a path

**Decision.** `resumes.storage_path`, not a `bytea` column.

**Reason.** Postgres rows are not a file server, and signed URLs give expiring,
auditable access with no proxy streaming code. A 60 s signed URL also means no
PDF ever transits the extension a second time.

## ADR-007 — Postgres full-text search is the "BM25" leg

**Decision.** A generated `tsvector` column plus `ts_rank_cd` is the sparse leg
of hybrid search. No Elasticsearch, no external BM25 service.

**Reason.** `ts_rank_cd` is cover density, not textbook BM25, and that is
acceptable at this corpus size. One system beats two.

**Say "sparse leg", not "BM25".** The quotes in the title above were doing more
work than they could carry. Two specific things BM25 has that this does not:
an **IDF** term, so a word appearing in every chunk is *not* discounted here;
and **k1/b**, so term-frequency saturation and length normalisation are not
tunable — 0005's flag `1` is the only length control there is, and it is on or
off. Both absences push the same way: common words score too well. That is why
`rag/keywords.ts` has to be selective up front, and it is the reason a reader
who takes "BM25" literally will mis-predict this system's failures. The name was
removed from `tools.ts` (a tool description is read by the model as fact) and
from `keywords.ts` on 2026-10-03.

**Correction already applied (migration 0005).** `ts_rank_cd` takes a
normalization flag. Without it the rank is raw cover density, which **grows with
chunk length**, so the longest keyword-densest chunk won every time. Flag `1`
(÷ `1 + log(length)`) fixed it.

## ADR-008 — Reciprocal Rank Fusion, not score blending

**Decision.** Dense and sparse results are fused by RRF with `k = 60` inside
`hybrid_search_resume_chunks`.

**Reason.** Cosine distance and `ts_rank_cd` are not on a comparable scale and
their distributions shift per query. Any weighted sum needs a magic constant
that is wrong for the next document. RRF only reads rank order.

## ADR-009 — Three retrieval lenses, one of them the raw headline

> **Partly superseded by ADR-037.** Lens C and `interleave()` are gone; two
> lenses remain and are fused by RRF. The reasoning below is why lens A exists
> and still stands — it is the reason the pipeline is not JD-steered. Only the
> count and the combination step changed.

**Decision.** Retrieval runs three queries — (A) the recipient's headline
verbatim, (B) `PERSONA_CONCERNS` prose plus resume-flavoured `terms`, (C) the
job description — and interleaves hit 1 of each, deduped by `chunk_id`.

**Reason.** Steering with the **job description alone** gives a support lead and
a CTO the same three most-technical bullets, which is the anti-criterion in
`docs/PRD.md`. Steering with the persona alone is almost as bad: the recipient
reached retrieval as a 5-value enum, so "HR Coordinator" and "Staff Recruiter"
produced byte-identical queries and four years of HCM payroll experience — the
only thing an HR coordinator would ever reply to — was unreachable.

## ADR-010 — Persona `terms` are verbs, never skill nouns

**Decision.** `PERSONA_CONCERNS[*].terms` must be verbs a resume uses about work
done ("migrated", "reduced", "owned"), not the nouns a skills list is made of.

**Reason.** `Technical_Recruiter` originally read `years, experience, engineer,
senior, degree, certified, stack` — a skills-section retriever, word for word.
Both legs landed on the resume's comma-separated technology wall, which contains
no system, no number and no decision, so the draft could only say "I have
experience with". Audit every new persona against this.

## ADR-011 — Sparse keywords go through `toOrQuery()`

**Decision.** Every keyword list passed to the sparse leg is joined with ` or `.

**Reason.** `websearch_to_tsquery('english', 'python kafka aws')` produces
`'python' & 'kafka' & 'aws'`. Twenty-five space-joined JD keywords matched
**nothing, on every draft ever generated** — the "hybrid" search was silently
dense-only and nobody could see it, because dense always returns something.

## ADR-012 — Draft rules are enforced in code, not only in the prompt

**Decision.** `server/src/agent/critique.ts` is pure, tested, runs on every
draft, and triggers exactly one repair turn. The rewrite is kept only if it
fixes more than it breaks.

**Reason.** The prompt already banned "passionate about". The model wrote it
anyway. A rule that exists only in a prompt is a preference; a rule in
`critique.ts` is a rule.

**Corollary.** Every number in a draft is checked against the retrieved chunks.
Rounding — "over 30,000" for 32,330 — is the realistic failure, and the
recipient can hold the message next to the resume attached to the same
application.

## ADR-013 — Rules classify the persona; the model may be overruled

**Decision.** `personaFromHeadline()` runs first, **seeds** `ctx.persona`, and
**vetoes** `classify_persona` when they disagree — saying so in the tool
response rather than swapping silently.

**Reason.** Two failures. The model called an "HR Coordinator" an
`Engineering_Leader` and aimed an AI-metrics question at her. And nothing forces
the model to call `classify_persona` first despite the prompt; when it skipped,
retrieval fell back to the JD-only lens (see ADR-009). That lens no longer
exists, which makes the seeding *more* load-bearing, not less: with a null
persona, lens B degrades to job-description keywords alone and lens A carries
the whole personalisation.

## ADR-014 — The follow-up engine lives inside `syncObservations`

**Decision.** `sweepStaleContacts()` runs at the end of `syncObservations()` and
every caller calls it **unconditionally**, even with an empty observation array.

**Reason.** All three call sites used to early-return when there was nothing to
report. `sweepStaleContacts` is what turns an accepted contact with no reply
after N days into `Follow_Up_Required` and drafts the follow-up. So the engine
switched itself off the instant every invitation had been accepted — that is,
on **success**. `SyncObservationsRequest.observations` has no `.min()`; an empty
array is valid input by design.

**Corollary.** The sweep's transitions arrive in `needsDraft` only and never
increment `updated`. Gate `draftFor()` and `DATA_CHANGED` on
`needsDraft.length > 0 || updated > 0`, never on `updated` alone.

## ADR-015 — MV3-durable state goes in `chrome.storage.local`

**Decision.** The ATS handshake, the resume stash and `tabJobs` live in
`chrome.storage.local`, never in a module-level variable.

**Reason.** The service worker is killed after ~30 s idle. An external ATS
application spans minutes and at least one new document. A module variable is
gone before the user clicks Submit. Requires the `unlimitedStorage` permission.

## ADR-016 — Resume capture stashes on file-input change, and ranks documents

**Decision.** A capture-phase listener on every `input[type=file]` stashes the
bytes per tab; `documentRank()` (cover-letter 0, unrecognised 1, resume/CV 2)
refuses a strictly lower-ranked replacement.

**Reason.** The confirmation page is a **new document**, so the bytes cannot be
held in a content-script variable. And one stash per tab meant a cover letter
attached *after* the CV was filed as the tailored resume. Unrecognised names
still count, so `Arjun_Nair.pdf` is not lost.

## ADR-017 — Any write that could change a company relationship reconciles it

**Decision.** `POST /jobs`, `PATCH /jobs/:id`, `POST /contacts/capture` and
`POST /contacts/enrich` all run the company match.

**Reason.** Connecting three days before you apply must resolve identically to
connecting three days after. Matching only on contact capture left every
connect-then-apply contact — the normal order — as "general networking" forever.

## ADR-018 — Link on a single match only; never guess

**Decision.** One matching application auto-links. Two or more raise a
disambiguation prompt. Zero means general networking.

**Reason.** A wrong link silently poisons every future draft for that person,
citing the resume they were never sent. Being asked once is cheap; being wrong
is invisible.

**Also.** `companiesMatch()` is the SQL containment rule lifted to TS with **no
trigram leg** — it links records the user never connected, so it uses the strict
half — plus a 3-char floor so "AI" and "Co" cannot wildcard.

## ADR-019 — Acceptance detection reads the user's own pages

**Decision.** One minimized `chrome.windows.create({ focused: false, state:
"minimized" })` reads `/mynetwork/invitation-manager/sent/` then
`/mynetwork/invite-connect/connections/`, and the whole watchlist is reconciled
against that single snapshot.

**Reason.** LinkedIn reports a profile view **to the person viewed**. Polling by
visiting profiles would mean pestering the exact people the user is trying to
impress — a hard PRD constraint. It is also O(1) per sweep rather than O(n).

**Rejected.** The earlier design that visited up to 5 profiles per sweep with
human-scale pauses. `README.md` still describes it; see TASK-904.

## ADR-020 — A failed scrape is reported as a failure, not as "nothing found"

**Decision.** `readable: false` becomes `SweepResult.problem` and the panel says
*"Could not read LinkedIn. Make sure you are signed in."*

**Reason.** Reporting a broken scrape as "no changes" is the worst failure mode
in this codebase — it has happened three times — because it is
indistinguishable from the honest answer and the user stops trusting the tool
without ever learning why.

## ADR-021 — Content-script match patterns are broad

**Decision.** Match LinkedIn broadly, not a list of specific paths.

**Reason.** Chrome injects only on a real navigation and LinkedIn is a SPA, so a
narrow match list loses every route reached by client-side navigation. It fails
by **doing nothing**, which is indistinguishable from the extension being
broken.

## ADR-022 — Match what a control *says*, not its `aria-label`

**Decision.** DOM matching keys on visible text.

**Reason.** Three separate controls have broken when LinkedIn dropped or renamed
an `aria-label`, each time silently. The button's visible text is the more
stable contract.

## ADR-023 — The extension drafts; the human sends

**Decision.** Text is injected into LinkedIn's composer and the native Send
button is outlined. No `dispatchEvent` on Send, ever.

**Reason.** Hard PRD constraint. It is also the product's whole position: the
one deliberate act left to the user is the one that genuinely needs judgement.

## ADR-024 — `@crm/shared/constants` is a separate subpath export

**Decision.** Extension code imports runtime values from
`@crm/shared/constants`; only types come from `@crm/shared`.

**Reason.** The barrel pulls in zod. A content script that bundles zod is a
content script injected into every LinkedIn page carrying a validation library
it never uses. Verify after every build that no content-script bundle contains
`zod`.

## ADR-025 — One `alter type … add value` per migration file

**Decision.** Migrations `0003` and `0004` each add exactly one persona.

**Reason.** `alter type … add value` cannot run inside a transaction alongside
other statements. Combining them fails at apply time, on the user's database,
after the earlier statements have already run.

## ADR-026 — `findJobId()` is a deliberate read-then-write

**Decision.** `POST /jobs` selects before inserting rather than relying on
`on_conflict`.

**Reason.** The uniqueness rule is a **partial expression index**
(`on jobs (lower(company), external_job_id) where external_job_id is not null`)
and PostgREST's `on_conflict` cannot name it. Single-user, so the race is
theoretical.

## ADR-027 — Automatic drafting is the only path; buttons must not be a second

**Decision.** `generateDraft()` returns an existing **unsent** draft of the same
type instead of creating another, unless `instruction` is set — an explicit
user-steered rewrite. The Contacts tab shows "Draft ready →" rather than "Draft
outreach" whenever one exists.

**Reason.** `draftFor()` already writes the draft on acceptance. Two paths to
one message produced two near-identical drafts and made every button unsafe to
press twice.

## ADR-028 — Rejected: an "inventory chunk" classifier

**Decision.** No heuristic strips the resume's SKILLS wall out of the index.

**Reason.** I wrote a comma/semicolon segment-length classifier and threw it
away. The real bullet *"Built a four-tier matching engine (registration, policy
number, normalised name, partial registration)…"* scores 46 chars/segment
against a 45-char threshold — it would have silently deleted an achievement.
Length normalisation (ADR-007) solves the same problem without deleting
anything.

## ADR-029 — Enrichment fills nulls only and never touches `status`

**Decision.** `POST /contacts/enrich` is a distinct route from
`/contacts/capture`, writes only null columns, and is a **no-op** for unknown
profiles.

**Reason.** A null headline is a correctness bug, not a cosmetic one: the
headline picks the persona, which steers retrieval, which decides which bullets
the draft is built from. But re-using `captureContact`'s upsert would reset an
`Accepted` contact to `Pending`. And a 404-free no-op is what stops "the user
looked at someone" from becoming a CRM record.

## ADR-030 — No screen may go silent

**Decision.** Every tab, in every state, says what the system is doing and what
happens next. The Drafts tab keeps sent messages on screen with a follow-up
countdown.

**Reason.** The Drafts tab rendered only unsent drafts, so "Mark as sent"
emptied the page. In the user's words: *"the draft section looks extremely blank
and feels nothing is happening there."* A sent message is the **start** of the
product's job, not the end.

## ADR-031 — Retrieval is measured against a labelled set, not eyeballed

**Decision.** `server/eval/retrieval-cases.ts` holds six labelled cases against
a committed fixture resume. `pnpm --filter @crm/server eval:retrieval` reports
precision@k, recall@k, MRR, nDCG@k and hit rate. See
[EVALUATION.md](EVALUATION.md).

**Reason.** Both retrieval bugs this codebase shipped were invisible from the
output. The sparse leg was dead for every draft ever generated (ADR-021), and
the skills wall outranked every achievement bullet until ADR-007 — in both cases
the fused result still looked like plausible resume text to a human skim. A
score that drops when a leg dies is the only thing that catches that class of
failure, and it did not exist.

## ADR-032 — Gold labels are marker phrases resolved at run time

**Decision.** Cases name chunks by distinctive phrases. `resolveCase()` maps
them to indices against the live chunking and **throws** on a marker that
matches nothing.

**Reason.** Chunk ids are generated per insert, so a committed fixture cannot
name them. Chunk indices are a function of `CHUNK_TARGET_CHARS`, so hardcoding
them would silently invalidate the whole set the first time anyone tuned the
chunker — the exact change the set exists to measure. Throwing rather than
skipping matters because a zero meaning "the label is stale" is
indistinguishable from a zero meaning "the search is broken".

## ADR-033 — Faithfulness is graded deterministically, not by an LLM judge

**Decision.** `src/eval/faithfulness.ts` checks that every figure in a draft
appears in the chunks the draft was built from, plus a lexical-support proxy
reported beside it. No Ragas/DeepEval-style model judge.

**Reason.** A judge from the same model family agrees with its own
hallucinations — the failure it is least able to see is the one it produces. It
also costs a call per case, so nobody runs it on every change, and it is
non-reproducible, so a regression and run-to-run noise look identical. The two
things measured instead can be checked exactly, and rounding `32,330` to "over
30,000" is the one failure the user cannot recover from: the recipient can hold
the message next to the resume attached to the same application.

## ADR-034 — RRF moved out of SQL into `src/rag/fuse.ts`

**Decision.** `hybrid_search_resume_chunks` is dropped (migration 0006) and
replaced by `dense_search_resume_chunks` + `sparse_search_resume_chunks`.
Fusion happens in TypeScript.

**Reason.** Three things at once, and none of them was achievable with fusion in
the database. Fusion became unit-testable — verifying that a chunk found by only
one leg still competes previously required a populated Postgres and a
1536-dimension embedding. The eval can score each leg separately, which is the
only way to tell "fusion is mis-weighted" apart from "one leg matched nothing".
And the vector store became swappable, because a store now only has to return
ranked lists. The extra round trip is cheap next to the embedding call that
precedes both queries.

## ADR-035 — `VectorStore` exposes ranks, never scores

**Decision.** The interface returns ordered `RankedChunk[]` with no score field.
Two implementations exist: `PgVectorStore` (default) and `QdrantStore`.

**Reason.** Cosine distance and `ts_rank_cd` cover density are not on a
comparable scale and their distributions shift per query, so anything reading
scores has to invent a weighting constant that is wrong for the next document.
RRF reads rank order only, so rank order is all a store must promise. Writing
the second implementation is what proved the interface honest: `QdrantStore`
delegates `sparseSearch` to Postgres, because Postgres is the system of record
for chunk text and duplicating lexical search would mean two indexes that can
disagree. It also mirrors Postgres-generated chunk ids rather than minting its
own — `fuseRrf` dedupes by `chunk_id`, so the same chunk under two identities
would be counted twice and could beat a genuine second result.

## ADR-036 — `follow_up_days` travels on the request; the server env var is gone

**Decision.** `SyncObservationsRequest.followUpDays` carries the user's setting
to `sweepStaleContacts()`. `env.FOLLOW_UP_DAYS` is deleted rather than kept as a
fallback. `api.syncObservations()` attaches the value itself so no call site can
omit it.

**Reason.** The extension owns settings — there is no user table on the server
to read them from — but the sweep that enforces the deadline runs on the server.
With a number on each side, the side panel counted down from the extension's
value while the sweep used the server's, so the product stated a deadline it did
not keep. A tool that acts on your behalf is worth nothing if its promise and
its behaviour are two different numbers, and a fallback env var would have
preserved exactly that failure mode in a quieter form. Bounds
(`MIN_FOLLOW_UP_DAYS`/`MAX_FOLLOW_UP_DAYS`) are enforced twice on purpose: the
panel clamps so the user cannot save something the server would reject, and zod
rejects so a stale client cannot post a 0 that would mark every accepted contact
overdue on the next sweep.

## ADR-037 — Retrieval ends with an LLM reranker, not with fusion

**Decision.** `searchResumeForRecipient` fuses two lenses to
`RERANK_CANDIDATES` chunks and hands them to `rag/rerank.ts`, which grades each
0/1/2 and cuts to the limit. It can only reorder and drop, it falls open to the
fused order on any error, and it never returns an empty list.

**Reason.** Measured, not assumed. `eval:retrieval` showed the resume's
comma-separated skills wall and its education block taking **11 of 18 evidence
slots** across six labelled recipients, while the chunk that is the gold answer
for two of them was never retrieved at all. Both offenders were ranked top-2 by
*both legs of both lenses* — a sixty-item technology list matches more query
terms than any real sentence, and sits near the centroid of "backend
engineering" — so no rearrangement of fusion could exclude them. That is the
definition of fusion being the ceiling, which was the standing precondition for
this work (old TASK-1004).

What a reranker adds is the one judgement neither leg can represent: a passage
can match a query perfectly and still make no claim. Cosine distance and
`ts_rank_cd` both score surface overlap; only a reader can score whether there
is a fact in there to say out loud.

**Why not a cross-encoder.** This is a single-user local proxy. A ~400 MB ONNX
model to reorder eight passages is the wrong trade against one `gpt-4o-mini`
call inside a drafting flow that already costs several. Recorded as TASK-1005
with the condition that would change the answer.

**This does not contradict ADR-033 (no LLM judge).** Reranking is a retrieval
step that the eval *measures*; judging is the measurement itself. A model inside
the thing under test is fine. A model in the ruler is not.

**Measured 2026-09-28.** Pipeline nDCG@3 0.482 → 0.710, MRR 0.417 → 0.667,
hit-rate 0.667 → 0.833, forbidden-chunk violations 4 → 1. The full pipeline now
beats the single fused concern lens (nDCG 0.710 vs 0.667), which it had never
done. These figures are what *this decision* moved and are left as recorded; the
2026-10-08 re-run in `docs/EVALUATION.md` §6 confirms the reranker still earns
its call — `full` sits above `fused` on every column.

## ADR-038 — The repair pass ranks ungrounded figures above every style problem

**Decision.** `repairDraft` scores candidates as `(ungroundedFigures,
totalProblems)` and picks the lexicographic minimum over up to
`MAX_REPAIR_PASSES` rewrites.

**Reason.** The rule it replaced was "accept the rewrite only if it has strictly
fewer problems", which treats a fabricated statistic as interchangeable with a
stray exclamation mark. `eval:drafting` caught the consequence: a draft claiming
payroll for "over 32,000 employees" when the resume says 32,330. The critique
named the figure, the rewrite fixed a different problem, the count did not fall,
and the invented number shipped under the user's name. Everything else this
system enforces is a matter of taste; a number the resume does not contain is a
false statement about the user sent to someone who may go on to check it.

**Residual.** This did not reach 1.000 — see TASK-1006. Ordering repairs
correctly does not make the model comply, and a guarantee needs a deterministic
step rather than a third instruction.

## ADR-039 — The role-mention check requires only the head of a job title

**Decision.** `mentionsRole` splits the title on a comma or a *spaced* dash and
requires the distinctive words of the head only, falling back to the whole title
when the head is generic ("Software Engineer, …").

**Reason.** Postings qualify a role with a team or product —
"Senior Backend Engineer, Payments Platform" — and nobody writes a full
requisition title into a 300-character note. Demanding every distinctive word
made the rule unsatisfiable: `eval:drafting` showed the repair pass rewriting
the draft, the rule firing again, and the rewrite being discarded for not
reducing the problem count. The rule's stated purpose — the recipient can tell
which job you mean — is met by the head plus the company. A bare hyphen is
deliberately not a separator; it is part of the role far more often
("Full-Stack Engineer").

**Known weakness, pre-existing.** "Software Engineer, Applied AI" reduces to the
single word `applied`, which any draft satisfies with the verb "I applied". The
check is weakest exactly where titles are most generic.

## ADR-040 — Every chunk records the model that embedded it, and retrieval refuses a mismatch

**Decision.** `resume_chunks.embedding_model` (migration 0007), written by
`indexResume` and the eval seeder, a `check` constraint pairing it with
`embedding`, and a guard at the single retrieval chokepoint (`retrieveLegs`)
that throws when the stored models are not exactly `[EMBEDDING_MODEL]`.

**Reason.** The invariant "the query and the corpus are in the same vector
space" was held by nobody having changed the constant yet. That is not an
invariant, it is luck. A *width* change is caught for free — `vector(1536)`
rejects the insert. A same-width swap is caught by nothing: `text-embedding-
ada-002` is also 1536 dimensions, so every insert succeeds, every query
succeeds, cosine distance keeps returning plausible numbers, and the ranking is
meaningless. The failure has no error message and no symptom except drafts
quoting the wrong bullet.

The guard lives in `rag/embedding-guard.ts` rather than `rag/embeddings.ts`
because the latter constructs the OpenAI client from `env` at import time, and
`env` throws when unset — putting a pure function there would make it
untestable, which is the repo's own rule.

**Deliberate detail.** The backfill writes the literal model name rather than
adding a column `DEFAULT`. A default would stamp the current model onto every
future row whatever actually produced it, laundering exactly the mistake the
column exists to catch.

**Deliberate detail.** An empty corpus is *not* a mismatch. "No resume indexed"
is a state `execute_hybrid_search` already handles with an explicit no-evidence
tool response; throwing there would turn a degraded draft into a failed one for
every contact whose application has no resume.

**Consequence for the eval.** The guard sits on the path the eval harness also
takes, on purpose. An eval that scores a cross-model corpus reports a number
that means nothing, and the low score would be read as a ranking regression.

## ADR-041 — Every drafting run is recorded, including the ones that fail

**Decision.** `draft_runs` (migration 0008), one row per call to
`generateDraft`: evidence chunk ids, ungrounded figures, critique problems,
repair passes, prompt/completion tokens, model calls, latency, and `error`.

**Reason.** The server logged two lines in total. `generateDraft` computed
`citations` and `trace` and returned them in the HTTP response — but the
majority of drafts are written by the follow-up engine, where nobody reads that
response, so the evidence a message was built from was unrecoverable the moment
the request ended. "Why did it say that?" had no answer, and neither did "is
faithfulness falling?" or "what is this costing?". `eval:drafting` answers those
questions for six fixture recipients on demand; it says nothing about the
messages actually sent to real people.

**A run is not a message.** `message_id` is nullable and failures are recorded
with their error, because a run that threw is the one most worth querying later.
All three foreign keys are `on delete set null`: deleting a draft must not erase
the record that it was generated, what it cost, or what evidence it used.

**Recording must never fail a run.** `recordDraftRun` swallows and logs its own
errors — the only place in the server that deliberately does. Turning a
telemetry outage into a drafting outage is how monitoring takes down the thing
it monitors.

**Tokens are summed across the whole run, not the drafting call.** A run is up
to six ReAct turns plus a rerank call plus up to two repair passes plus a
shorten pass. Reporting the drafting completion alone undercounts by more than
half, and the undercount grows exactly when the run went badly. The counter is a
mutable `UsageMeter` on `ToolContext` rather than an `AsyncLocalStorage`
ambient: the context object already accumulates run state (`citations`), and an
async-context read that silently returns nothing when the store is unset is a
metric that quietly reports zero — the failure this is meant to prevent.
`recordUsage` increments `calls` even when the API omits `usage`, so "calls high
with tokens low" is a visible discrepancy rather than a silent shortfall.

**Faithfulness is scored after the shorten pass, not after repair.** Shortening
rewrites the sentence a figure lives in. What ships is what gets measured.

## ADR-042 — No semantic cache

**Decision.** Repeat retrieval and repeat drafting are not cached by query
similarity, and will not be.

**Reason.** The standard RAG checklist prescribes a semantic cache to avoid
paying twice for the same question. This is not a question-answering system.
"Draft a message to a recruiter at Stripe" and "draft a message to a *different*
recruiter at Stripe" are near-identical queries that **must** produce different
messages — and `eval:drafting` has a hard gate for exactly that: two recipients
receiving a byte-identical draft fails the run. A semantic cache would convert
that failure into a feature, and it would do so most aggressively for the
recipients who are most alike, which is precisely the population the two-lens
retrieval exists to differentiate.

**What is cached instead, correctly.** `generateDraft` returns the existing
unsent draft for a contact rather than generating a second one, unless the user
passes an explicit rewrite instruction. That is exact-key reuse of a result for
the same person, not similarity reuse across people. It removes the duplicate
cost the cache was supposed to remove, without the failure mode.

**Latency.** The related checklist item is a P95 under 2 s. The drafting loop is
6 turns plus a rerank plus repairs; it is 10–30 s and it runs on a background
alarm, so the user-visible SLO is "a draft is waiting when the panel opens", not
2 s. `draft_runs.latency_ms` makes that claim checkable instead of asserted.

## ADR-043 — The evals exit non-zero, and `verify:release` is the gate

**Decision.** `server/src/eval/gates.ts` holds committed floors; both runners
call `enforce()`, which prints a pass/fail table and sets `process.exitCode = 1`.
`pnpm verify` = typecheck + tests + extension build. `pnpm verify:release` adds
both evals.

**Reason.** Both runners already computed everything needed to fail a release
and then exited 0 anyway. `eval:drafting` printed the literal words "FAIL: two
recipients received a byte-identical draft" on stdout and returned success — so
the one defect the entire persona pipeline exists to prevent could ship past the
script written to catch it, as long as nobody read the scrollback. A check that
requires a human to read it is not a check.

**Floors, not targets, and set below the baseline.** The reranker is an LLM
call, so a chunk can move ±1 rank between identical runs (EVALUATION §3). A
threshold pinned to the recorded baseline would fail on noise, and a gate that
cries wolf is bypassed within a week — worse than no gate, because people
believe it is running. With six cases, one case flipping is 0.167 of a rate; the
floors are chosen so that one case *regressing* trips the gate and run-to-run
wobble does not. There is no threshold between those two that this dataset size
can support.

**Release gate, not pre-commit gate.** The evals seed and tear down a throwaway
job in the live Supabase project and spend real OpenAI credit. Running them on
every commit would make them something to skip. `pnpm verify` is the per-change
command; `pnpm verify:release` is the one that must be green before the
extension is loaded for real use or any retrieval/prompt change is kept.

**Never lower a floor to make a run pass.** Written in `gates.ts` itself rather
than in a document, because that is where someone will be standing when they are
tempted.

## ADR-044 — The recipient's whole profile steers retrieval, but is never corpus

**Decision.** `contacts.profile_text` (migration 0010) stores a condensed
About + Experience + Skills read from the recipient's own LinkedIn profile. It
is used three ways: an excerpt seeds the dense query of retrieval Lens A, its
frequent nouns join the sparse leg's OR-query, and the full text is quoted into
the drafting agent's task prompt inside a `<recipient_profile>` fence. It is
**not** embedded and **not** added to `resume_chunks`.

**Reason for capturing it.** The recipient reached retrieval as a headline —
and a headline is a slogan. "Talent Partner | We're hiring!" says nothing, and
a large minority of profiles leave it at the bare job title or blank. The About
and Experience sections are where it says this person spent six years on HRIS
implementations, which is the single sentence that decides whether the
candidate's resume has anything to say to them. Without it, the two-lens search
half-worked: Lens A had a query that was frequently contentless.

**Reason for keeping it query-side.** The corpus is the *candidate's* resume.
Embedding the recipient's career into the same index would make their
achievements retrievable as evidence about the sender, and the agent would cite
them — which is precisely how a message to a technical recruiter came to claim
the sender had "improved time-to-fill by 30%", a line lifted from her own job.
Query-side, the profile can only change *which* of the candidate's real bullets
is chosen. It can never become a claim.

**Reason for the fence and the warning.** The profile is a stranger's text
pasted into an instruction — the one untrusted block in the prompt. It is
delimited, labelled REFERENCE ONLY, and the system prompt states outright that
nothing in it is a fact about the candidate and that instructions inside it are
profile text.

**Read only from the page the user is already on.** `reportProfileDetails()`
fires on every `/in/` visit, before the degree check. The background sweep does
not fetch profiles: turning two self-page reads per sweep into N third-party
profile views is exactly the pattern that gets accounts restricted, and PRD §6
forbids it. The cost is that a contact recovered from the Sent-invitations page
has no profile until the user opens it once — so the Contacts card says so, and
names the one click that fixes it.

**Overwritten, not fill-when-null.** `profilePatch()` in `services/contacts.ts`
replaces a stored profile with a newer read, but only a *longer* one. LinkedIn
hydrates About, Experience and Skills independently after navigation, so an
early read can legitimately return one line; without the length test, opening a
profile and navigating away a second later would replace a complete profile with
a stub. A genuinely shortened profile therefore sticks at its old length, which
is the cheaper mistake.

**Bounded three times.** `MAX_PROFILE_TEXT_CHARS = 4000` on the wire and in the
column; `MAX_RECIPIENT_QUERY_CHARS = 700` on the embedded query, because an
embedding is an average and four thousand characters of career pulls the query
vector towards the centroid of everything the person has ever done;
`MAX_PROFILE_TERMS = 30` on the sparse leg, because an OR query is a ranking
signal and past a few dozen terms every chunk matches something.

## ADR-045 — Job vocabulary is a deny-list, and the role reaches every ranking signal

> Changes what goes *into* the sparse leg. ADR-011 (`toOrQuery`) and ADR-037
> (two lenses, closed by a reranker) are unaffected.

**Decision.** Two changes that are one decision.

1. `extractTechKeywords` becomes `extractRoleKeywords`. The closed `TECH_VOCAB`
   allow-list stops being a **gate** and becomes a ×3 **boost**; a ~200-word
   `JD_BOILERPLATE` deny-list does the filtering instead. Title terms carry ×5.
   A plain body word must appear at least twice to survive, or it is prose.
2. The role the user applied to is passed to *every* ranking signal:
   `concernLensQuery` names it in Lens B's dense query, `extractRoleKeywords`
   receives the title as well as the JD body, and `RerankTarget` carries
   `roleTitle` + `roleKeywords` into the rerank rubric.

**Reason, measured rather than reasoned.** `extractTechKeywords` returned the
empty string for the real 2,714-character Oracle Fusion HCM job description.
`TECH_VOCAB` was a backend-hiring word list — no `oracle`, no `hcm`, no
`fusion`, no `payroll` — so the job description contributed **zero** terms to
retrieval. Lens B's sparse leg fell back to persona verbs alone
(`built or shipped or … or clients or supported`), and `clients` / `supported`
are precisely what a client-satisfaction bullet matches.

Underneath that, a larger fact: `job.title` reached `buildTaskPrompt` and
nothing else. Both dense queries, both sparse queries and the rerank rubric were
all answering "what is most impressive about this candidate?" and none of them
was answering "about this job". `Technical_Recruiter.caresAbout` says the
candidate "has already done **this job** somewhere real" — an unevaluable
instruction, because the grader was never told what the job was.

**Why a deny-list is the only thing that generalises.** The vocabulary of *work*
is unbounded — nursing, litigation, FP&A, embedded firmware, HCM — and any
enumeration of it is a list of the industries whoever wrote it happened to think
of. The vocabulary of *job-advert filler* is small, closed and nearly identical
across every industry: "passionate", "fast-paced", "responsibilities",
"stakeholders". Deny-listing that leaves whatever is distinctive about the
posting, whatever field it is in. Postgres `websearch_to_tsquery('english', …)`
stems, so word forms collapse at match time and the list does not need
inflections.

**Residual and acknowledged.** `TECH_VOCAB` survives as a ×3 boost, which is
asymmetric: a software posting still gets a thumb on the scale that an Oracle
posting does not. It is vestigial and should probably be deleted, but not
without re-running `eval:retrieval`, whose fixture is a backend resume.

**Why the domain test is not an impressiveness test.** The rerank rubric now
decides grade 2 against grade 1 on domain, explicitly stating that a quantified,
hard-won achievement from unrelated work is a **1** and a weaker number inside
the role's own domain is a **2**. Without that sentence the model reverts to
ranking by impressiveness, which is the behaviour being fixed.

**Why `concernLensQuery` lives in its own module.** `rag/search.ts` imports
`rag/embeddings.ts`, which constructs the OpenAI client from `env` at module
load, and `env` throws when unset. Nothing in that import graph can be reached
from a unit test. `rag/lens-query.ts` is pure and testable, for the same reason
`rag/embedding-guard.ts` is a separate file.

**Why this is not the deleted lens C.** ADR-037 removed a JD lens whose query
named only the company, so it returned a byte-identical ranking for all six eval
recipients. Lens B stays recipient-specific: the persona clause still varies per
reader, and a test asserts that two personas produce different queries for the
same role.

**Verified by ablation, read-only, against the live Oracle job and the
recipient's real profile.** Role withheld, rank 0 was a tooling inventory
(`PeopleTools 8.59/9.1, SFTP/FTP, PGP keys, Control-M`). Role supplied, rank 0
was `PeopleSoft payroll onto Fusion: Pay Calendars → Payroll Definitions,
PeopleCode → Fast Formula, Records → Flexfields`.

## ADR-046 — An introduction is written once per contact, ever

**Decision.** `isOncePerContact()` in `agent/draft.ts` treats `connection_note`
and `initial_outreach` as final. Before the unsent-draft reuse lookup,
`generateDraft` queries for a **sent** message of the same type to the same
contact and returns it unchanged if one exists. `follow_up` is exempt. An
explicit user `instruction` overrides, because that is a deliberate rewrite.

**Reason.** The reuse lookup filtered `.is("sent_at", null)`, so a message that
had been sent was invisible to it. Observed live: Hassan Amr's initial outreach
was created 08:51:06, marked sent 09:08:17, and written again at 10:48:47 — a
hundred minutes after it went out. Every acceptance sweep and every profile
visit was another chance to re-introduce the user to somebody they had already
written to, and the panel showed it as a pending draft, inviting them to send it
twice.

**Why `follow_up` is exempt.** Chasing twice is a legitimate thing to want, and
it is the one message type whose entire purpose is to be sent again. Applying
the guard to it would switch the follow-up engine off.

**Why return the sent message rather than an error.** The caller is usually the
panel asking "what is the state of this contact?". Handing back the message that
was actually sent answers that question; an error would render as a failure on a
contact where nothing is wrong.

---

## ADR-047 — A resume is delivered on evidence, and never overwrites in silence

**Context — the incident of 2026-10-01.** Three applications were tracked in one
session and every tailored CV was filed one application behind:

| UTC | what happened |
| --- | --- |
| 02:52:34 | job row created, Trellis Digital / AI Field Deployment Engineers |
| 02:52:40 | a resume object written into that job's folder |
| 03:06:07 | the **same row's** `applied_at` updated — a second commit, same requisition id |
| 03:13:31 | the **same storage key overwritten in place** |
| 03:13:32 | job row created, Cedar Union CRM / AI Engineer — one second later |
| 03:40:03 | a resume written to the Cedar Union job |
| 03:40:27 | job row created, Raw Ventures — twenty-four seconds later |
| — | Raw Ventures: no resume row, no storage object |

Read back, the PDF stored under Trellis Digital opens `AI Engineer | LLM
Applications, RAG & Agents` (the Cedar Union CV) and the one under Cedar Union opens
`Backend Engineer, AI-Driven Development` (the Raw Ventures CV). The extracted
text says so; this is not inferred from timing. A fourth application — a
Solutions Engineer role — has no row at all, and the CV tailored for it was the
object destroyed at 03:13:31.

**Four defects, each sufficient on its own to misfile a document.**

**1. A tracked job claimed files forever.** `rememberJobForTab` bound tab → job
and nothing ever marked that binding satisfied; `forgetTab` cleared it only when
the tab closed, and the tab-independent `lastTrackedJob` reused
`HANDSHAKE_TTL_MS` — two hours. The file picker fires *before* submission, which
is the normal order, so the next application's CV resolved to the previous
application and was uploaded there. Replaced by `acceptsDelivery()` in
`@crm/shared/vault`: a `DELIVERY_WINDOW_MS` of ten minutes, and a
`deliveredRank` on the binding so a job accepts one document and afterwards only
something that outranks it.

**Why ten minutes and not "once".** Both halves are load-bearing. The window
alone fixes this incident — the two bad deliveries were 21 and 26 minutes late.
The rank alone fixes the ATS that asks for the cover letter first and the CV
second, which a flat once-only rule would break. Neither subsumes the other.

**Why refusing is cheap and accepting is not.** An unclaimed resume waits in the
stash and the commit seconds later takes it. A wrongly accepted one overwrites a
tailored CV that exists nowhere else.

**2. `documentRank` could not read its own filenames.** `\bcv\b` does not match
`Arjun_CV.pdf`, because `_` is a word character. Every underscore-separated
name — which is every exported CV, including the vault's own
`<Name>_<Company>_<Role>.pdf` — scored as unrecognised, so the ranking written
to stop a cover letter being filed as the resume could not tell them apart.
`\b` replaced with an explicit filename-separator class.

**3. The upload was destructive and unconditional.** The storage key is derived
from the job, so a second upload resolved to the identical object and
`upsert: true` overwrote the bytes; Supabase keeps no version. `POST /resumes`
now returns **409** unless the caller sets `replace`. The extension's
`deliverResume` already returns a rejected resume to the stash, so the refusal
is self-healing: the application the document actually belongs to claims it
moments later.

`indexResume` also ordered its writes against its own stated invariant — the
upload destroyed the previous bytes *before* the new row existed. The key now
carries a timestamp and the old object is removed last, after the replacement is
committed. The timestamp is invisible: `GET /resumes/:id/download` sets
Content-Disposition from `file_name`.

**4. Two ways to attribute an application to a posting the user only browsed.**
`resolveHandshake` fell back to the newest handshake in *any* tab — intended for
Workday's second tab, but it also let an abandoned handshake, up to two hours
old, be committed by an unrelated site. It now falls back only to a handshake
under ten minutes old **and only when there is exactly one**; ambiguity yields
null, which surfaces the manual "Track this application?" toast. Separately,
`refreshCache()` in `linkedin-jobs.ts` kept the last successful scrape
unconditionally, so a scrape that missed on the posting on screen answered with
the previous posting's title, company, URL *and requisition id*. It now drops
the snapshot when the id on screen no longer matches it.

**Why the requisition id is the dangerous field.** `POST /jobs` takes its
`UPDATE` branch on `(company, external_job_id)`. A wrong title creates a badly
named row; a wrong requisition id silently overwrites a different application and
leaves no row for the real one. That is why there is no Solutions Engineer
record to repair.

**Consequence: manual attachment had to exist.** Refusing bad deliveries makes a
job holding the wrong CV unrecoverable, because automatic capture was the only
path in. `ResumePicker` on the application card attaches or replaces by hand and
passes `replace` explicitly, confirming first.

---

## ADR-048 — A follow-up is drafted automatically, knows what it is following, and can be refused

**Context — four defects found on 2026-10-01, each confirmed against the live
database before anything was changed.** The user reported that an opener and its
follow-up read almost identically. They do:

> *opener, 09-25* — "…taking loosely defined problems from users and developing
> tested, working products quickly… how does your team ensure that the AI
> solutions you build are aligned with the specific needs of government clients?"
>
> *follow-up, 10-01* — "…translating user needs into a working product quickly…
> I'm interested in how your team approaches building custom AI solutions for
> government clients."

Same claim, same question, six days apart. The investigation found three further
defects behind it.

**1. The follow-up engine was one-shot.** `sweepStaleContacts` selected
`.eq("status", "Accepted")`. The sweep that finds a stale contact is also the
sweep that moves them to `Follow_Up_Required` — so from the next sweep onward
they are invisible to it. One attempt, ever. If that single `draftFor()` call
failed for any reason — worker asleep, proxy down, the error swallowed by
`poller.ts` — the contact was stranded permanently. Live: **4 contacts in
`Follow_Up_Required`, 3 of them with no draft at all**, stuck since 2026-09-24
and 09-25, while the panel told the user a follow-up "will be drafted for you".
The one draft that existed was created at 05:49:53 on 10-01, by the user
pressing the button. Six days, zero automatic follow-ups.

Now `.in("status", ["Accepted", "Follow_Up_Required"])`, with the status write
left in place and idempotent (the returned row is what the caller drafts from).
Repetition is bounded by `MAX_FOLLOW_UPS_PER_CONTACT = 2` counted from
**messages actually sent**, not drafted — two chases after the opener is where a
reasonable person stops, and an unbounded sweep over a now-recurring status is
how a CRM turns into a nuisance.

**Why count sent, not drafted.** A draft the user never sent is not a chase the
recipient received. Counting drafts would let three discarded attempts exhaust a
contact's budget without a single message leaving the extension.

**2. `buildTaskPrompt` never carried the conversation.** The only route to "what
have I already said to this person" was `check_company_message_history`, which
the model had to *choose* to call, which scopes by **company** rather than
contact, and which caps at 10 rows. `draft_runs` for the offending message
records `model_calls: 3, repair_passes: 0` — persona, search, write. It never
asked. A model that has not been shown the thread is not writing a follow-up; it
is writing a second opener.

The thread is now loaded unconditionally in `draft.ts` and rendered into the
prompt by `agent/thread.ts` (`priorThread` + `threadBlock`), placed **before**
the reflection section, because what was already said constrains every choice
below it. It carries `sent_text` in preference to `draft_text` — the recipient
read what the user actually sent, not what the agent proposed — dates each
message in days so staleness is visible, and names the three ways a follow-up
repeats itself: same opening line, same achievement or figure, same question
reworded. All three were present in the real failure.

**Why its own file.** `draft.ts` imports `rag/embeddings`, which constructs the
OpenAI client from `env` at module scope, so nothing reachable from it is unit
testable. Same reason as `embedding-guard.ts` and `lens-query.ts`.

**Why not a tool.** A tool is optional by construction. Prior messages are not
context the model may want; they are the definition of the task.

**3. There was no way to say no.** `DraftCard` offered Insert, Copy and Mark as
sent. A draft the user rejected sat in "Needs your approval" forever, kept the
badge lit, and — worse — permanently excluded that contact from the sweep, whose
"don't stack follow-up drafts" guard reads an unsent draft as work in progress.
Refusing one draft therefore silenced the contact. `DELETE /api/messages/:id`
plus a confirmed Discard button. A **sent** message is refused with 409: it is
the record of the conversation, and the thread block above now depends on it.

**4. A profile read that stores nothing says nothing.** Live: 31 contacts, 3
with `profile_text`, all written in a two-minute window on 09-30. The chain is
silent at every step — `condenseProfile()` returns null when About, Experience
and Skills are all empty; `reportProfileDetails` sends anyway because the
headline is non-null; `profilePatch` writes only when the incoming text is
*longer* than the stored text, so it returns `{}`; `updated: false` is not
rendered anywhere. The user opens the profile, the amber "headline alone" banner
stays, and nothing anywhere reports a failure.

Three fixed timers at 3/8/16 s cannot see a lazy column that renders on scroll,
which is what a profile opened from the side panel and left at the top looks
like. Replaced with a `MutationObserver` on `document.body`, throttled to one
read every 2 s and bounded at 120 s — watch, do not poll; an observer left
attached to a SPA is a leak. The timers are kept as a floor.

**And the silence is now broken.** On expiry, if the contact is known to the CRM
and the server still reports no `profile_text`, the page toasts and says to
scroll. A stranger's profile storing nothing is correct and stays silent — hence
the lookup rather than an unconditional toast. The content script trusts
`contact.profile_text.length` **read back from the server**, never what it
believes it sent: the enrich call returns 200 and writes nothing whenever the
text is not richer than what is stored, so "the request worked" was never
evidence the profile was readable. That assumption is why this failed silently
three times.

---

## ADR-049 — Only the database can stop a race, and only a check can stop a model

**Context — 2026-10-01, after ADR-048 shipped.** Seven follow-up drafts appeared
for four contacts inside nineteen seconds, and the ones that appeared still
repeated the openers they were chasing. Two separate lessons.

**1. The "don't stack drafts" guard was a time-of-check/time-of-use race.**
`sweepStaleContacts` counted unsent follow-ups for a contact and skipped when
one existed. That is a read, a decision, and a write by a *different* request,
with nothing held between them. `linkedin-profile.ts` fires `OBSERVE_ACCEPTED`
three seconds after every 1st-degree profile loads, and every one of those runs
the stale sweep. The user opened ~25 profiles in a row:

| created_at | contact |
| --- | --- |
| 06:22:23.5 | Omar Faruq |
| 06:22:25.0 | Omar Faruq |
| 06:22:29.5 | Nikos Pallas |
| 06:22:31.3 | Nikos Pallas |
| 06:22:31.5 | Nikos Pallas |

Every sweep read "no draft exists" because none had been written yet. No amount
of application-level checking fixes this; only the database sees both writers.
Migration **0011** adds a partial unique index on `(contact_id, type) WHERE
sent_at IS NULL`. Partial on purpose: sent messages are the conversation record
and must stay unconstrained, and ADR-048's thread block depends on all of them.

**Why an index and not a transaction.** The check and the write are separated by
a full ReAct loop — ten seconds of OpenAI calls. Holding a transaction open
across that would pin a connection per in-flight draft for the entire run.

**The index protects the data; it does not protect the spend.** Three concurrent
runs for Nikos each completed a full retrieval, rerank and critique — ~30k
prompt tokens — to produce two rows Postgres then rejected. `generateDraft` now
keeps an `inFlight` map keyed on `contactId:type`; a second request joins the
first rather than starting a second agent. This is exact-key reuse of one
pending computation, which ADR-042 already identified as the correct version of
caching here — two different recipients at the same company still get their own
run, and `eval:drafting` gates on that.

**2. A rule in the system prompt is a preference.** ADR-048 put the thread in the
prompt and told the model not to reuse the opening, the evidence or the
question. It did all three:

> *opener* "…how does your team ensure that the AI solutions you build are
> **aligned with the specific needs of government clients**?"
> *follow-up* "…how does your team ensure the solutions you create are
> effectively tailored to meet the **unique needs of government clients**?"

Every other quality rule in this system is enforced by `critique.ts` with a
repair pass behind it. Repetition was the one that was not, so it was the one
that shipped. `repeatsThread()` now checks three things against what the
recipient has actually been sent: a **figure** they already received, an **ask**
whose content words overlap the previous ask by half or more, and a **shared
three-content-word run** in the claim — which is how "LLM applications that are
actively used by non-technical operators" was caught coming back as "LLM
applications that non-technical operators use monthly".

**The role title is excluded from all three comparisons.** RULE 2 *requires* the
follow-up to name the role the opener named. Counting that as repetition makes
the critique unsatisfiable, and an unsatisfiable rule has already cost this
codebase a repair loop that rewrote forever and discarded every rewrite.

**3. "Make it easy" produced the survey question.** RULE 6 said to ask one
question and make it easy; the model read "easy" as "cheap to answer", and the
critique only counted question marks. The result was a closing line that could
be sent to anyone alive: "Do you have any insights on that?", "What tools or
processes do you find most effective?", "What qualities are you prioritizing in
candidates?". The last of those asks a recruiter to read the job ad back to you.

RULE 6 now states the test — delete the name and the company; if the question
still makes sense it is a survey — and says plainly that **no question is better
than a generic one**. `GENERIC_ASK` enforces it, reporting the closing line once
rather than once per overlapping pattern.

> **Superseded within the day.** RULE 6 stands; `GENERIC_ASK` does not. A
> deny-list of phrasings, fed back to the generator as its own repair
> instruction, is a specification of the cheapest evasion — and the model took
> it. See **ADR-050**, immediately below.

---

## ADR-050 — A critique rule the model can reword its way out of is not a rule

**Status:** Accepted · 2026-10-01 · supersedes the `GENERIC_ASK` phrase list of
ADR-049 · relates to TASK-1015

### Context

ADR-049 shipped `GENERIC_ASK`, a list of regexes matching the survey closers
observed that morning, and tightened `repeatsThread()`. The next automatic sweep
(07:02) produced four follow-ups. `draft_runs` recorded `critique_problems: 0`
for all four. Three of them were the same failures again:

| recipient | closing line | why it passed |
|---|---|---|
| Nikos | "What **specific** skills or experiences are you prioritizing in candidates for this position?" | `\bwhat (qualities\|skills\|…)\b` requires the noun immediately after `what`. One adjective defeats it. `repair_passes: 2`. |
| Daniel | "Are there specific skills or technologies that you see in high demand right now?" | No pattern began with anything but `what`. |
| Lena | "How does your team approach gathering feedback during the development of AI solutions for government clients?" vs the opener's "how does your team ensure that the AI solutions you build are aligned with the specific needs of government clients?" | 3 of 8 content words shared = 38%, under the 50% ratio. |

Nikos's run is the one that matters. `repairDraft` ranks candidates by
`critique.problems.length`, so the objective handed to the model is *reduce the
number of regex hits*, and the cheapest way to do that is always the smallest
edit that stops a pattern matching rather than the edit that fixes the message.
Two repair passes were spent learning to insert one adjective. **A deny-list of
surface forms, fed back to its own generator as the repair instruction, is an
evasion trainer.** The space of paraphrases is infinite; the list is not.

### Decision

**1. Check the shape of the question, not its wording.** `GENERIC_ASK` is
deleted. A closing question is a problem when its subject is one of 23
`ABSTRACT_SUBJECT` category nouns (skills, qualities, tools, processes,
challenges, insights, trends…) **and** nothing inside `askText()` matches an
`askAnchors()` term — the company, the role, or what the recipient's headline
says they do. The only two ways to satisfy it are to name something concrete or
to delete the question, and both of those are the real fix. The problem text
says so explicitly: *deleting it is better than rewording it*.

**2. Anchors must exclude abstract words.** Nikos Pallas's headline is
"Recruitment Manager | Matching **Skills** to Opportunities | FinTech". Without
this filter her own tagline anchors "what specific skills are you prioritizing",
and the check goes silent on the exact draft it was written for. A category noun
cannot anchor a question to a person, wherever it came from.

**3. Repetition is an absolute count, not a ratio.** `shared >= 3 || ratio >=
0.5`. A ratio rewards padding and punishes brevity, which is backwards here
because the repair pass *shortens* the ask — the threshold gets easier to pass
under exactly the pressure that is meant to tighten it. Three distinctive words
in common is a shared subject. The **company** now joins the role title in the
excluded set, since the draft is required to name it, and tokens are trimmed of
leading and trailing dots (`[^a-z0-9+#.]+` keeps `.` so "node.js" survives,
which meant a sentence-final `team.` was missing the stopword set).

### Consequences

- Every new critique rule must be reviewed by asking **"what is the cheapest
  evasion?"** If the answer is a reword, the rule is wrong.
- 197 tests / 40 suites. `server/test/repetition.test.ts` replays the 07:02
  drafts, including the adjective evasion and the headline-anchor false negative
  found before shipping.
- `critiqueDraft` gained `company` and `anchors`; `draft.ts` supplies them from
  `ctx.company`, `job.title` and `contact.headline`.
- Omar Faruq's follow-up is *not* caught by either rule, correctly: "the AI
  systems" is anchored by his role title. Its defect was an empty corpus — the
  Clearwater Labs resume was uploaded nine minutes after the draft was written.

---

## ADR-051 — Sending a message reconciles the contact's state, in the same request

**Status:** Accepted · 2026-10-01 · relates to ADR-036, ADR-048

### Context

Four follow-ups were drafted, approved and sent. All four contacts continued to
show the amber **Follow Up Required** badge, the line "No reply for 5+ days — a
follow-up is due", and a **Draft follow-up** button.

`POST /messages/:id/sent` wrote `sent_text` and `sent_at` to `messages` and
nothing else. `Follow_Up_Required` is written by `sweepStaleContacts()` and was
never written back by anything. The status was not stale by a few minutes — it
was permanent until the next sweep happened to look, and the sweep only ever
*adds* that status.

The data was not wrong; the state machine had a one-way edge.

### Decision

The mark-sent route clears the flag in the same request:

```ts
.update({ status: "Accepted" })
.eq("id", message.contact_id)
.eq("status", "Follow_Up_Required")
```

Scoped by status rather than written unconditionally: a `Replied` contact must
not be demoted because the user sent them something, and a `Pending` one has not
accepted the invitation yet. The follow-up clock restarts from the new
`sent_at`, so the sweep re-flags them in `followUpDays` if they stay quiet,
bounded by `MAX_FOLLOW_UPS_PER_CONTACT`.

Two panel changes follow from it, because `Accepted` now means two different
things:

- `contactStateLine()` takes the contact's most recent `sent_at`. With one, the
  card reads "You messaged them 2 hours ago — waiting for a reply. If they stay
  quiet, a follow-up is drafted for you in 5 days." Without one it still reads
  "you can message them now".
- **Draft outreach** renders only when nothing has been sent. Otherwise it
  offers to introduce the user to someone they are two messages into a
  conversation with.

### Consequences

- Generalises the rule the company matcher already follows: **any write that
  changes what the system should do next must reconcile the state that decides
  it, in the same request.** Deferring to a background sweep is not equivalent
  when the sweep runs every 30–90 minutes.
- The four stuck contacts were reconciled by hand with the same transition.
- **Open, not fixed by this ADR:** `repairDraft` returns its best candidate
  after `MAX_REPAIR_PASSES`, even when the critique still objects. The 07:32
  batch recorded `critique_problems: 1` for two drafts that shipped and were
  sent. The telemetry knew; the panel did not say. → TASK-1016.

## ADR-052 — A chunk is cut on sections, not on line breaks

**Status:** Accepted · 2026-10-01 · relates to ADR-012, ADR-039, ADR-045

### Context

`chunkResumeText` split on `/\r?\n/` and packed lines up to a character budget.
A PDF line-wrap was therefore the only boundary it could see, and a section
header was just another line to pack.

On the real resume this put three unrelated facts **plus the whole CORE SKILLS
wall** into chunk 1, which was then cited in *every* `draft_runs` row — the wall
is a bag of keywords, so it matches every query. Two failures follow and neither
is fixable downstream:

- **Adjacency reads as causation.** The agent joined a CSAT figure from one
  project to Oracle Fusion work from another with the word "along with", because
  in the retrieved text they were adjacent.
- **The reranker cannot grade its way out.** Grading is per chunk. A chunk that
  is one third skills wall and two thirds real achievement has no score that is
  not wrong about part of it.

This caps what the reranker, the critique and the prompt can ever achieve. It is
the root cause under the whole drafting stack, and it was fixed first.

### Decision

`sectionHeader()` decides where a chunk starts. A line is a header when it is a
known resume heading (`SKILLS`, `EXPERIENCE`, `CERTIFICATIONS`, … 25 of them,
case-insensitive, trailing colon stripped) **or** it is short, capitalised
throughout, and at most seven words before the first `—`/`–`/`|`/`·`/` - `, which
is how a resume writes `ORACLE CORPORATION — Bengaluru, India`.

A header ends the current chunk, is never emitted as a chunk of its own, and is
**prefixed to every chunk cut from the section below it**, costing its own length
out of that chunk's budget. Overlap is carried between chunks of the same
section and deliberately **not** across a header.

Both halves of the rule are load-bearing, and each has a test built from a line
of the real resume:

- Seven words and a separator, so `Senior Software Engineer — Bengaluru, India`
  and `AWS — migrated the fleet to Graviton` are read as content, not headings.
- All-caps on the *lead* only, so a shouted employer with a mixed-case location
  still counts.
- The skills wall itself is long and comma-heavy, so it fails every test and is
  never mistaken for the heading above it.

### Consequences

- Retrieval now returns a passage that is about one thing, and the section name
  travels with it. Both the reranker and `misattributedFigures` (ADR-053) depend
  on that; neither would work on the old chunks.
- The eval fixture goes from a chunk set nobody could reason about to **8 chunks,
  one per section**, with the skills wall isolated and labelled `SKILLS`. Every
  `relevantMarkers` / `forbiddenMarkers` phrase in `eval/retrieval-cases.ts`
  still resolves — checked before the chunker was trusted.
- The hard-split path for a single over-long line now strides by the *remaining*
  budget after the prefix, so `chunk.length <= targetChars` still holds exactly.
  The split *condition* is unchanged, so no line the old chunker kept whole is
  now cut — cutting one would have destroyed an eval marker.
- **Existing `resume_chunks` rows were written by the old chunker and do not
  change.** Every resume must be re-uploaded for this to reach live data. Until
  then the live corpus is still the old one, and a draft on it is evidence about
  the old chunker, not this one.

## ADR-053 — A figure must belong to the claim, not merely exist somewhere

**Status:** Accepted · 2026-10-01 · relates to ADR-039, ADR-052, ADR-050

### Context

`ungroundedNumbers` asks one question: does this number appear anywhere in the
retrieved evidence? On a corpus of mixed chunks that question is nearly free to
pass, and it passed the worst draft the system has produced — a CSAT figure from
a support project welded onto an Oracle Fusion rollout. The number was in the
evidence, so every grounding check in the system reported clean. The recipient
read one sentence asserting a causal link the resume never made.

Omar's run is the other half of the same hole: `evidence_chunk_ids: []`, a draft
written with nothing retrieved at all, presented in the panel as ready to send.

### Decision

**`misattributedFigures(draft, evidence)`** — per sentence, which passage is this
sentence *about*? Distinctive-word overlap against each chunk picks a best match.
If a figure in the sentence occurs only in *other* chunks, and the best match
beats every chunk that owns the figure by `ATTRIBUTION_MARGIN = 2` words, the
figure has been moved and the critique says so, naming both passages.

Three deliberate restrictions:

- **Absolute margin, not a ratio.** Same reason as `repeatsThread`: the repair
  pass shortens text, so a ratio gets *easier* under exactly the pressure meant
  to tighten it.
- **Digits are not words.** `contentWords` splits on punctuation, so `840,000`
  arrives as the tokens `840` and `000`. Left in, a stolen figure votes for the
  passage it was stolen from — and votes harder the longer the number is, so the
  clearest thefts were the ones that went unreported. `prose()` strips them. This
  was caught by the first test written against it, not by review.
- **Fewer than two chunks, no opinion.** With one passage there is no other piece
  of work to have taken the figure from.

A sentence that genuinely draws on two passages about equally does not fire, and
there is a test asserting that. The check is conservative on purpose: both ways
out are real fixes, but a rule that fires on an honest draft burns both repair
passes and discards every rewrite (ADR-050, RULES.md).

**The zero-evidence gate is not a critique problem.** With `evidence: []` the
complaint "nothing here is supported" is unsatisfiable — no rewrite can clear it,
so it would burn both passes and discard every candidate, every time. It is
recorded instead as `review.evidenceCount === 0` and shown in the panel (ADR-054)
as *"Nothing in this message came from your resume."* The draft is not blocked;
the user is told, which is the only honest thing available when retrieval found
nothing.

### Consequences

- Only works on top of ADR-052. On line-break chunks the figure and the claim
  usually lived in the same chunk, so there was nothing to compare.
- `critiqueDraft` gains one more thing `repairDraft` ranks candidates by, and the
  message is written as an instruction — rewrite the claim, or drop the figure —
  because ADR-050's repair loop feeds critique text straight back as the repair
  prompt.

## ADR-054 — A draft carries its own review, and the panel shows it

**Status:** Accepted · 2026-10-01 · supersedes part of ADR-050 · migration 0012

### Context

`repairDraft` returns its best candidate after `MAX_REPAIR_PASSES` whether or not
the critique is satisfied. That is correct — a draft the user can edit beats no
draft — but the panel rendered a surviving objection identically to a clean one.
The 07:32 batch recorded `critique_problems: 1` on two messages; both were read,
approved and sent. The telemetry knew. The user had no way to.

`draft_runs` could not fix this: it is write-only observability, keyed by run and
never read by the panel, and it is explicitly allowed to fail silently (ADR-041).

### Decision

Migration **0012** adds `messages.review jsonb`, holding the shared `DraftReview`
contract: `{ evidenceCount, problems[], ungroundedFigures[], repairPasses }`,
computed on the **final** text after the shorten pass and figure repair have both
had their turn, and written in the same insert as the draft.

Nullable with no default. A default of `{ problems: [] }` would state that every
pre-0012 draft was checked and clean, which is a lie told by a column definition;
`review.nullish()` in the zod contract and an explicit line in the card —
*"Written before drafts were checked, so nothing has reviewed this one"* — say
the true thing instead.

`DraftCard` renders three states: no evidence (warning), findings that survived
(warning, listed, with the repair-pass count), clean (one quiet grey line naming
how many passages it was checked against). The clean state is not silent on
purpose — silence is what shipped the 07:32 batch.

### Consequences

- The review is a snapshot of the draft as saved. If the user edits the text in
  the panel the review is about the text the agent wrote, not the text they are
  about to send, and it is shown next to the editor where that is legible.
- `recordDraftRun` now reports from the same `review` object the panel shows, so
  telemetry and UI can no longer disagree — they did before, since telemetry was
  scored before the shorten pass.
- Skipping 0012 breaks `POST /draft` on insert (unknown column).

## ADR-055 — A rounded figure is repaired arithmetically, never by asking again

**Status:** Accepted · 2026-10-01 · relates to ADR-039, ADR-050

### Context

`eval:drafting` has held faithfulness at **0.833** through a prompt rule, a
critique rule and a repair pass. The failure is always the same shape: asked for
a short message, the model writes "over 32,000" where the resume says 32,330.
The recipient can hold the message next to the resume on the same application.

Rounding is the one hallucination with a *deterministic* fix — the correct answer
is in the evidence and nothing has to be inferred — so asking a language model to
stop doing it is using the wrong tool.

### Decision

`repairFigures(draft, evidence)` rewrites a drafted figure to the evidence figure
it is a rounding of, and leaves everything else alone. Four guards, each with a
test:

- **Magnitude.** A rounding never changes the integer-digit count or the leading
  digit, and never moves more than 10%. Without this, "100 hours" becomes "96
  hours" the moment the resume mentions 96 of anything. An earlier draft of this
  function had exactly that bug.
- **Direction.** The drafted number must be *rounder* than the source — more
  trailing zeros, or fewer decimals. Otherwise the repair runs backwards.
- **Ambiguity.** Exactly one candidate, or nothing happens. 90 is a plausible
  rounding of both 96 and 99, and the real resume contains both.
- **Years.** 2020 is one trailing zero from 2021 and passes every test above. An
  excluded `^(19|20)\d\d$` keeps dates out of it.

The hedge is consumed with the number — `over 32,000` → `32,330`, not
`over 32,330` — because the whole matched span is replaced. A hedge in front of
an *already exact* figure is left alone: this repairs figures, not wording, and
widening it would put a deterministic rewriter in competition with the repair
loop.

It runs in two places: on every repair candidate inside `repairDraft`, and once
more after `shortenToLimit`, which is the pass most likely to re-round a figure
and previously had the last word. The post-shorten repair is rejected if it
pushes the draft over the character limit, which the shorten pass has already
been paid for enforcing.

### Consequences

- Only the figure is touched. `ungroundedNumbers` still reports anything repair
  declined to fix, so a refusal is visible rather than silent.
- Does nothing on an empty corpus — there is no source figure to restore — which
  is correct and leaves ADR-039's strictest case intact.

## ADR-056 — A contact with no application retrieves across the whole corpus

**Status:** Accepted · 2026-10-01 · relates to ADR-023, ADR-044 · migration 0013

### Context

`rag/store/types.ts` carries the invariant *"every method is scoped to one
`jobId`. Retrieval must never cross applications."* `tools.ts` enforced it with
`if (!ctx.jobId) return { hits: [] }`.

7 of 31 contacts have no linked application — `captureMissedInvitations` reads
the Sent-invitations page, which gives a name and a headline and no employer, so
there is nothing for `companiesMatch()` to match. For all of them the search tool
returned zero hits and the agent wrote from the headline alone. Daniel R. is the
live instance.

The invariant exists to stop *leakage between applications*: a draft about the
Stripe job must not quote a resume tailored for the Datadog one, because the
recipient can tell. That reasoning has no force when there is no application at
all — there is nothing to leak into.

### Decision

Migration **0013** restates both RPCs from 0006 with one line changed in each,
`where c.job_id = p_job_id` → `where (p_job_id is null or c.job_id = p_job_id)`,
and the carve-out is made explicit in the invariant comment: `jobId: null` means
*general networking*, and only that. The type is `string | null` through
`VectorStore`, `retrieveLegs`, `hybridSearch` and `searchResumeForRecipient`, so
the carve-out is visible in every signature rather than buried in one branch.

When `ctx.jobId` is null the search tool attaches a `provenance` note telling the
model the passages come from resumes written for *other* roles, and forbidding it
to mention applying, a role, a referral or a resume. The passages are the user's
own career either way; what would be false is the framing.

The `qdrant` adapter spreads the filter conditionally. An empty `must` array
matches nothing, which would have reproduced the zero-hits bug silently in the
one backend with no tests against a live index — there is a comment saying so.

### Consequences

- A general-networking draft now has the user's actual experience behind it.
- **Rejected:** fetching the profile to learn the employer. PRD §6 forbids bulk
  third-party profile fetches during a sweep, and this would be one per unlinked
  contact. The remedy for a *missing employer* stays manual — visit the `/in/`
  profile once — because that is a capture problem, not a retrieval one.

## ADR-057 — A job title is validated where it is written, not where it is read

**Status:** Accepted · 2026-10-01 · relates to ADR-045, ADR-033

### Context

Three live rows were filed as "Share negative feedback", "Share negative
feedback" and "Remote". LinkedIn renders a feedback button and a filter pill
where a heading or a job link goes, and the scraper read them.

This looked like a data-entry annoyance. It is a retrieval bug: the title feeds
`extractRoleKeywords`, the concern lens (ADR-045) and the rerank rubric, so every
ranking signal for those three applications was steered by a button label.

The scraper rule already existed. Two holes remained. It lived in
`extension/src/lib/scrapers/linkedin.ts`, where **the extension has no test
runner**, so the rule could not be tested. And `POST /jobs` is not only called by
the scraper — the manual "I applied" flow and the ATS scrapers call it too, and
the server accepted anything.

### Decision

`looksLikeJobTitle` moves to `@crm/shared/job-title`, a **zod-free subpath** for
the same two reasons as `constants`, `profile-text` and `vault`: a content script
importing the `@crm/shared` barrel gets zod bundled and dies at load, and shared
code can be tested from the server's runner. Verified after the move — zod count
is still 0 in all five bundles.

`POST /jobs` and `PATCH /jobs/:id` validate through `assertJobTitle()` and return
**400** naming the string, not a silent `null`: a title the server quietly
dropped is how one of these rows was created.

The rules are **exact matches**, a point the tests pin. "Remote" alone is the
filter pill; "Remote Data Entry Administrator" is somebody's job, and a prefix
rule would refuse it. The list is observed damage only — every entry has been
written to the database.

### Consequences

- Same TS-twin discipline as `escapeLikePattern()` / `escape_like()`: one rule,
  two callers, one definition.
- **The three existing rows are not repaired by this.** Their real titles are not
  recoverable from anything stored, and guessing them would poison the same
  ranking signals in a quieter way. They need the user to supply the titles.

## ADR-058 — A draft is checked against the job advert, not only against the resume

**Status:** Accepted · 2026-10-03 · relates to ADR-050, ADR-053, ADR-054

### Context

Every grounding check this codebase has ever had asks one question: *is this in
the resume?* On 2026-10-03 a draft went to Nadia Haddad, the Vantage Staffing recruiter
who posted the ad, reading "I have over 5 years of experience developing and
deploying AI solutions in production environments". Her advert reads "3-5 years
of experience developing and deploying AI or machine-learning solutions in
production environments".

`review` recorded `problems: [], ungroundedFigures: []`, and every check was
right on its own terms. The figure 5 is in the resume. The phrasing is not,
because nothing was comparing against the advert — the JD is in the prompt as
*material*, and material in a prompt is something a model will reach for when it
has nothing better to say.

This is the worst possible reader to do it to. She wrote those words. A message
quoting someone's own job posting back at them is the clearest signal available
that it was machine-written.

### Decision

`echoesJobDescription(draft, jdText, { evidence, roleTitle, company })` reuses
the trigram machinery `repeatsThread` already runs on prior messages, pointed at
the advert instead.

Three exclusions, each load-bearing rather than tidy:

- **The role and the employer.** RULE 2 *requires* an opening message to name
  both. Counting them would flag compliance as plagiarism, and the repair loop
  would rewrite forever — the unsatisfiable-critique failure this file has
  already shipped twice.
- **Anything in the retrieved resume text.** The ad and the CV both say
  "retrieval augmented generation" because that is what the work is called.
  Flagging a phrase the candidate genuinely owns would push the model *off* its
  own evidence, which is the opposite of the goal.
- **The closing question**, via `claimText`. Quoting the advert back as a
  question is the draft proving it read the thing, which RULE 6 asks for. The
  damage is in the claims.

It reports **one problem however many runs matched**. `repairDraft` ranks
rewrites by problem count, so three fragments of one sentence would let a rewrite
that deleted a clause outscore one that actually rephrased the claim.

`JD_PROMPT_CHARS` is shared between the prompt builder and the critique on
purpose. The check must judge the draft against the text the model actually saw,
or it reports coincidence as theft.

### Consequences

- Replayed against the stored row, the check returns "years experience
  developing", "experience developing deploying", "solutions production
  environments" — the three real carried runs.
- This is a **structural** check, not a deny-list, for the ADR-050 reason: the
  critique text is fed back as the repair instruction, so a list of banned
  phrasings is a specification of the cheapest evasion.

## ADR-059 — The company and the role cannot anchor a question they were required to contain

**Status:** Accepted · 2026-10-03 · relates to ADR-050, ADR-049

### Context

The abstract-question check (ADR-050) fires when a question's subject is a
category noun AND nothing in it ties the question to this recipient. The anchor
set included the company and the role title.

RULE 2 *requires* every opening message to name both. So every opening message
carried a free anchor it never had to earn, and the check was off for the entire
message type it was written for. Nadia Haddad was sent "What specific challenges
do you see for this role at Vantage Staffing?" — `ABSTRACT_SUBJECT` matched
"challenges", "Vantage Staffing" anchored it, `critique_problems` recorded 0. Delete her
name and her employer and that question is askable of every recruiter alive,
which is precisely the test RULE 6 states.

### Decision

`askAnchors(headline, { roleTitle, company })`. The obliged words are
**subtracted from the headline**, not merely withheld from the anchor list.

That distinction is the entire fix, and the first attempt proved it by failing.
Withholding the company changed nothing on the live row, because a LinkedIn
headline usually *leads* with the employer: hers is "Recruiter @ Vantage Staffing UAE |
IT Recruitment…", so "lancesoft" came straight back as a headline word and the
check stayed silent on the draft it exists to stop. There is a test pinning this
specific regression.

Both employer strings are subtracted. `ctx.company` prefers the contact's
profile ("Vantage Staffing UAE"); RULE 2 makes the draft name the one on the posting
("Vantage Staffing Middle East"). On this very row they differ, and subtracting one
leaves the other free to anchor.

Category nouns are dropped from the headline too. Nikos Pallas's headline is
"Recruitment Manager | Matching Skills to Opportunities | FinTech" — without that
filter her own tagline excuses "What specific skills are you prioritizing in
candidates?".

The problem text was rewritten in the same pass. It used to advise naming "their
company, the role", which is now exactly what does not anchor — a repair
instruction pointing at a fix the check rejects is a loop that cannot terminate.

### Consequences

- Accepted cost: a genuinely pointed question whose only distinctive term is the
  employer is now flagged if it also reaches for a category noun. Both ways out —
  name something that is theirs, or end on the fact — are improvements.
- Generalises the rule `repeatsThread` already wrote down: **what the draft is
  obliged to say must be excluded from every check that measures what the draft
  chose to say.**

## ADR-060 — A figure found only in the summary is reported to the reader, not to the repair loop

**Status:** Accepted · 2026-10-03 · relates to ADR-053, ADR-052

### Context

`misattributedFigures` (ADR-053) compares *across* chunks: it finds which chunks
own a figure and which chunk the sentence most resembles, and complains when they
differ. A sentence assembled from a single chunk is therefore unfalsifiable by
it — `owners.includes(best)` short-circuits.

The PROFESSIONAL SUMMARY is exactly that chunk, and it ranks first in retrieval.
It is where every headline figure sits beside every skill with the work that
earned them stripped out. Nadia's draft took a CSAT the resume earns under "led
weekly stakeholder reviews through six weeks of go-live support, explaining SQR /
PeopleCode logic in plain language" — chunk 17, which was not retrieved — and
wrote "built systems that maintain client satisfaction above 9.5/10". Payroll
support work, re-tagged as AI systems. Grounded, because the only thing compared
was "9.5".

### Decision

`isSummaryChunk` matches the section headers a summary is written under.
`summaryOnlyFigures(draft, evidence)` returns the figures the draft uses that
appear in a retrieved summary chunk and in no retrieved body chunk. It goes on
`DraftReview` and is rendered in the panel.

It is **deliberately not a critique problem.** The repair pass has the same
evidence and cannot verify attribution either; all it could do is delete the
figure, and RULE 4 requires one concrete fact. Feeding both instructions to one
loop is how a critique becomes unsatisfiable — twice already in this file.

`isSummaryChunk` returns `false` on a chunk with no recognisable header, which is
thirteen of sixteen resumes until they are re-uploaded under the ADR-052 chunker.
No opinion beats a wrong one.

### Consequences

- The one finding in the panel that nothing upstream has tried to fix, which is
  why it is rendered above `review.problems`.
- `summaryOnlyFigures` carries `.default([])` so rows written before the field
  existed parse to an empty list and the panel never tests for undefined.
- It is **not a fault**. The figure is the user's own. The evidence simply cannot
  say whether the claim the draft wrapped around it is the claim the resume made.

## ADR-061 — The review names its checks, never a verdict

**Status:** Accepted · 2026-10-03 · relates to ADR-054, ADR-060

### Context

With no findings, `DraftReviewNotice` read "Checked against 3 resume passages —
nothing left to fix."

The checks compare figures and phrasing against retrieved text. They have no
opinion on whether a message is true, well aimed, or worth sending. "Nothing left
to fix" is a claim about the message that they cannot support, and one draft
passed every one of them while re-tagging five years of payroll work as five
years of AI.

### Decision

The clean state names what ran: "No invented figures, reused phrasing or job-ad
wording found against the N resume passages this came from. Read it before you
send."

### Consequences

- A reviewer that overstates its remit is worse than no reviewer, because the
  user stops reading it. The closing sentence exists to keep the human in the
  loop that PRD §6 requires anyway.

## ADR-062 — Repair attempts and repairs that were kept are two different numbers

**Status:** Accepted · 2026-10-03 · relates to ADR-041, ADR-050 · migration 0014

### Context

`repair_passes` (0008) counts model calls. `repairDraft` ranks each rewrite and
keeps it only if it scores **strictly better**, so a run can spend both calls and
ship the draft it started with.

Nadia's row reads `repair_passes: 2, critique_problems: 0`. That means either "it
was dirty and the loop cleaned it" or "both rewrites were discarded and what
shipped is the model's first answer". Those call for opposite responses — one
says the loop works, the other says it is burning tokens for nothing — and there
was no way to ask.

### Decision

`repairDraft` returns `{ text, passes, accepted }`. `draft_runs.repair_accepted`
stores it. `repair_passes > 0 and repair_accepted = 0` is now a query.

Default 0, unlike 0012's deliberately-null `review`: a count of kept rewrites is
not a verdict about the draft, so backfilling the arithmetic truth for older rows
asserts nothing false. Every one of those runs predates the counter.

### Consequences

- Skipping 0014 rejects every `draft_runs` insert for an unknown column.
  `recordDraftRun` swallows that by design — telemetry must never fail a draft —
  so the symptom is a `[draft_runs] insert failed` warning in the server log and
  a table that silently stops growing.

## ADR-063 — Migrations apply themselves, from a ledger, in a container that exits

**Status:** Accepted · 2026-10-08 · supersedes the manual step in README §Setup ·
relates to ADR-040 (pure logic is testable logic)

### Context

Fourteen migrations were applied by hand through the Supabase SQL editor, in
order, by a human reading `README.md`. Three failure modes followed from that and
all three actually happened:

- **Skipped.** 0006 and 0013 both fail *quietly* — the server starts, drafting
  degrades, nothing errors. `docs/MEMORY.md` carried "0013 not applied" for days
  after it had been applied, and then carried it as evidence.
- **Applied twice.** `0001` has 26 DDL statements and 5 of them are guarded with
  `if not exists`. It is not idempotent. Nothing stopped a second run.
- **Edited after the fact.** `docs/RULES.md` says "never edit a migration that
  has been run". Nothing enforced it, and nothing could: the database keeps the
  old shape, the repository shows the new text, and no artefact relates them.

A reader cannot run this project without being told, in prose, to execute
fourteen files in the right order. That is not a setup step, it is a ritual.

### Decision

A `schema_migrations` ledger table — `version`, `filename`, `checksum`,
`applied_at` — and a runner that reads it.

`src/migrate/plan.ts` holds the decision and touches nothing: no database, no
`env`, no network. That is the ADR-040 pattern, for the ADR-040 reason —
`src/env.ts` throws at import, so anything in its graph is unreachable from a
unit test, and a rule nobody can test is a rule nobody keeps. 20 tests.

`src/migrate/run.ts` holds the Postgres. It takes `pg_advisory_lock` (two
containers starting together must not both run `0001`), creates the ledger,
plans, applies, exits.

Three refusals, all of them stops rather than guesses:

- two files sharing a version — they cannot be ordered;
- a ledger row with no file on disk — the database is ahead of the code;
- a checksum that no longer matches — `RULES.md`'s append-only rule, finally
  enforceable.

Files that Postgres refuses to run inside a transaction block —
`alter type … add value` (0003, 0004) and `create index concurrently` — are
detected from the SQL **with comments stripped**, because 0003, 0004 and 0006
all carry header comments that *discuss* those statements and a detector reading
raw text flags the prose. Those files run bare and are recorded afterwards, so a
half-applied one stays unrecorded and the next run stops on it.

**The runner is its own process and its own container, and `DATABASE_URL` lives
only there.** The connection string is a superuser password; the only thing that
needs it is DDL, for two seconds. A long-running HTTP server that holds it keeps
that credential resident for hours to use it once. `src/env.ts` does not know the
variable exists.

A `--baseline` mode records the existing fourteen as applied without running
them, for the one database that predates the ledger. It refuses unless
`resume_chunks` already exists — otherwise it would write "fully migrated"
across an empty schema and every later run would believe it.

### Consequences

- A new user runs `docker compose up` and never reads a migration list. Future
  migrations apply on the next start with no instruction at all.
- A failed migration is **loud and non-zero**, and the server does not start
  behind it. This is deliberately the opposite of the current behaviour, where
  the interesting failures are silent.
- `DATABASE_URL` is a second credential to hold, on top of the service-role key.
  Accepted: it is write-scoped to schema changes, used by a process that exits,
  and can be omitted from a deployed server's environment entirely.
- The checksum makes an edited migration a hard failure on the next deploy
  rather than a divergence discovered months later. Restoring the file and
  adding a new migration is the only route through, which is what `RULES.md`
  already demanded.
