# Project Memory

Current state. Overwrite this file as the project moves; do not append a log.
Permanent decisions live in `docs/DECISIONS.md` and are not repeated here.

**Last updated:** 2026-10-08

---

## Current status

**All five PRD features are implemented end to end.** The extension tracks
applications, files resumes, maps contacts to jobs, drafts persona-aware
outreach against the submitted resume, and drives the follow-up state machine.

The build is green:

```
pnpm -r typecheck                  ✅
pnpm --filter @crm/server test     ✅ 260 tests / 52 suites
pnpm --filter @crm/extension build ✅ no content-script bundle contains zod
```

### Prepared for a public repository (2026-10-03)

The repo is MIT-licensed and carries `CONTRIBUTING.md`, a root `SECURITY.md`
reporting policy, `server/.env.example` (which `README.md` and `env.ts` both
told people to copy and which did not exist), and a CI workflow running
`pnpm verify` plus the content-script zod grep.

**Every real person and employer in this repo has been replaced by a fictional
cast**, in code comments, tests, fixtures, migration comments and these docs.
The fixture resume was already fictional (Priya Raghavan / Northwind Logistics /
Helios / Brightfold) and the cast extends it. The mapping is recorded once, here,
so that a future reader does not "restore" a name from an old transcript:

| was | is |
| --- | --- |
| the agency recruiter | Nadia Haddad |
| her agency | Vantage Staffing (UAE / Middle East) |
| the candidate | Arjun Nair |
| the other named contacts | Omar Faruq, Lena Hartmann, Nikos Pallas, Daniel R. |
| the employers applied to | Clearwater Labs, Trellis Digital, Cedar Union, Vector AI, Verdant, Lumera |

Technology names (Oracle Fusion HCM, PeopleSoft, Kafka, Greenhouse, hibob) are
*not* PII and were deliberately left alone — they are what the code is about.

**Done 2026-10-08.** All four credentials were rotated before the first push —
`OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRM_AUTH_TOKEN` and the database
password — and the new values were verified end to end (27 job rows returned
through a containerised server using every one of them). The service-role key
came back as `sb_secret_…` rather than the previous `eyJ…` JWT, so it is
demonstrably a different key and not a re-read of the old one. Keys pasted into
a chat window during development are burned regardless of what was committed;
that is why this was a prerequisite rather than a tidy-up.

### Published 2026-10-08

`github.com/kssharda0717-dev/job-search-crm`, public, MIT. Before the first
commit the 139 files that git would track were scanned for provider keys, JWTs,
the project ref, emails, phone numbers, absolute home paths and real names:
nothing but the `YOUR-PROJECT-REF` placeholder in `server/.env.example`. The
ignore rules were tested against concrete paths in a scratch repository rather
than read — `.env` alone did not cover `server/.env.bak`, so `.env.*` (plus
`*.pem`, `*.key`, `*.p12`) was added and `!.env.example` re-asserted after it.

**CI caught a real defect on the first run, and the defect was in the test
story rather than the product.** `pnpm verify` reported 260 passing locally;
GitHub reported 238 with two suites dead at import. `rerank.test.ts` and
`draft-reuse.test.ts` imported pure functions out of `rag/rerank.ts` and
`agent/draft.ts`, both of which reach `env.ts` through `openai`/`db` — and
`env.ts` throws at import. A developer machine has `server/.env` beside the
code, so dotenv satisfied it and 20 tests had never once run clean. Fixed by
extraction (`rag/grades.ts`, `agent/draft-policy.ts`), not by giving CI dummy
secrets, which would have deleted the only enforcement of the rule. CI also
moved 20 → 22 to match the `node:22-slim` the Dockerfile ships.

### Released v1.0.0, 2026-10-08 — installing needs no toolchain

Pushing a `v*` tag runs `.github/workflows/release.yml`: re-run `pnpm verify`
against the *tagged* commit (a tag can point at a commit no branch ever built),
multi-arch buildx push to GHCR, then `gh release create` with the built
extension zip. `permissions: {packages: write, contents: write}`; the repo's own
`GITHUB_TOKEN` is enough.

Verified live rather than assumed: the GHCR manifest fetched with an
**anonymous** token lists `linux/amd64` + `linux/arm64` (arm64 selected natively
on Apple Silicon), the release carries `job-search-crm-extension-v1.0.0.zip`
(121 KB), and a `pull` + `up` on a clean machine ran `migrate` to exit 0, left
`server` `Up (healthy)`, answered `/health` with `{"ok":true}` and still 401'd
`/api/jobs`.

Three things that are easy to get wrong and are load-bearing:

- **`docker-compose.yml` carries no `build:` key, deliberately.** Compose
  *builds* rather than pulls whenever both are present, so a `build:` there
  would make every first-time user compile the dependency tree — the entire cost
  the published image removes. Building is opt-in via
  `docker-compose.build.yml`, which also retags to `jobsearchcrm:local` so a
  hand-built image cannot squat the name `pull` resolves.
- **`up -d` returns before the server is listening.** Docker's published port
  accepts the connection and closes it, so the ~8 s startup window reads as
  `curl: (52) Empty reply from server` — a crash, not a race. The documented
  command is `up -d --wait`, which blocks on the Dockerfile `HEALTHCHECK`
  (measured 7.9 s).
- **GHCR packages are created PRIVATE even from a public repo.** Flip once by
  hand: github.com/\<user\>?tab=packages → the package → Package settings →
  Danger Zone → Change visibility. Until then every `docker compose pull` fails
  with an auth error that says nothing about visibility.

The version lives in three places — the tag, `package.json`,
`extension/package.json` — and the workflow fails on disagreement. The server
and the extension always share one version; they are two halves of one private
protocol.

**There is no auto-update, on purpose.** An image-watcher such as Watchtower
restarts `server` without knowing `migrate` exists, so the first release
carrying a migration would run new code against an old schema — and
`recordDraftRun` swallows unknown-column errors by design, so the failure is
silent. Updating goes through `docker compose pull && up -d --wait`, the only
path that re-runs `migrate` first. An unpacked extension cannot auto-update at
all; Chrome does that only for Web Store installs, and the Reload click is the
price of staying off the store.

### Fixed in the same pass

- **The proxy bound to `0.0.0.0`.** `serve` defaults to it, the startup log said
  "localhost" either way, and `docs/SECURITY.md` asserted a loopback bind that
  nothing configured. Now `hostname: "127.0.0.1"`.
- **`DELETE` was missing from `allowMethods`** while `DELETE /api/messages/:id`
  existed, so discarding a draft failed its CORS preflight and looked like a
  network error.
- **Every zod string field is now bounded**, with the ceilings in
  `constants.ts`, plus a `bodyLimit` at the socket — the schemas only run after
  the body is in the heap.
- **Résumé capture was armed on every http(s) page and on all of
  `linkedin.com`.** Any PDF chosen in any file input anywhere was read and
  uploaded. It is now gated on the page being a job application, evaluated per
  file-choice rather than at script load (both callers live in SPAs), and
  disclosed in the Settings tab.
- **`repairFigures` could import a figure across units** — "about 30 seconds"
  against a resume's "31 days" wrote "31 seconds", a precise number taken from
  an unrelated claim, under the user's name. A unit guard (`measuresTheSameThing`)
  now requires the tokens following the figure to overlap. Two regression tests;
  238 → 240.
- **The evals leaked rows on a crash.** `seedEvalCorpus()` sat outside the `try`
  in both runners, and eval contacts had no marker, so a killed run left
  `status: 'Accepted'` contacts that the follow-up sweep would then spend real
  tokens drafting to. The marker now rides in `linkedin_url` and teardown
  deletes them.

**Migrations 0001–0014 are applied and verified against the live project.
Next free number is `0015`.** 0013 and 0014 were applied on 2026-10-03 and
verified the only way either can be — not by report, but by calling
`sparse_search_resume_chunks` with `p_job_id: null` and getting chunks back
(0013), and by watching six fresh `draft_runs` rows insert with a
`repair_accepted` value (0014). Both failures are silent, so a report that they
ran is not evidence that they took.

**As of 2026-10-08 migrations are no longer applied by hand** —
`pnpm --filter @crm/server migrate` reads a `schema_migrations` ledger and
applies what is missing (ADR-063). This database predated the ledger and was
**baselined on 2026-10-08**: all 14 recorded as applied, nothing re-run.
Adding 0015 is now the whole deployment step; nobody opens the SQL Editor again,
and editing an applied file fails the next run by name.

- **`0012_message_review.sql`** — `messages.review jsonb`, nullable, no default.
  Skipping it breaks `POST /draft` on insert (unknown column). → ADR-054.
  **Applied; verified 2026-10-03** by reading a populated `review` off a live
  message row, not by report.
- **`0014_record_accepted_repairs.sql`** — `draft_runs.repair_accepted integer
  not null default 0`. `repair_passes` counts model calls; this counts the
  rewrites that scored better and were kept. Skipping it does not break
  drafting: `recordDraftRun` swallows the insert error by design, so the symptom
  is a `[draft_runs] insert failed` warning and a table that quietly stops
  growing. → ADR-062.
- **`0013_corpus_wide_search_for_unlinked_contacts.sql`** — both RPCs from 0006
  restated with `where (p_job_id is null or c.job_id = p_job_id)`. Skipping it
  does **not** error — `where c.job_id = null` is simply never true, so every
  unlinked contact silently keeps getting a message written from zero evidence,
  exactly as before. That is the dangerous kind of skip: it looks like it
  worked. → ADR-056.

For `0001`–`0009`, checked directly rather than reported:
`resume_chunks.embedding_model` reads back
`text-embedding-3-small` for every row; `draft_runs` exists; `escape_like()`
returns the right answer for `Stripe`, `100% Remote`, `Node_Labs` and `a\b`;
`match_jobs_by_company('100% Remote')` matches **0 of 7** jobs rather than all
7; an upsert naming `(resume_id, chunk_index)` is accepted, so the constraint is
really there; and all 51 chunks have distinct pairs.

**`0010_contact_profile_text.sql`** adds `contacts.profile_text` and
`contacts.profile_read_at`. Confirmed by a live enrich round-trip, not by
report: a `/in/` visit populated both columns for a real contact and the values
read back.

**`0011_one_unsent_draft_per_contact.sql`** is applied. Evidence rather than a
report: the 07:02 sweep on 2026-10-01 produced exactly **4 drafts for 4
contacts**, where the sweep before it produced 7 for 4 in 19 seconds.

**Live data as of 2026-10-01, read directly:** 15 jobs, 13 resumes
(2 jobs hold none), 31 contacts — **23 Pending / 8 Accepted / 0
Follow_Up_Required**, 6 of 31 unlinked, 13 messages and **0 unsent drafts**.

Roughly 8,700 lines across 60 source files in four workspace packages. The
directory is **not a git repository**.

---

## Completed

- **Feature 1 — application tracking.** LinkedIn Easy Apply from the DOM;
  external ATS via the pre-navigation handshake parked in
  `chrome.storage.local`; an "I applied" fallback in the side panel.
- **Feature 2 — Document Vault.** Two-phase resume stash with `documentRank()`,
  server-side PDF extraction, canonical `<Name>_<Company>_<Role>.pdf`, private
  bucket, 60 s signed download, chunk + embed, re-index deletes prior chunks.
- **Feature 3 — entity mapping.** Order-independent matching on both job writes
  and both contact writes; single-match auto-link; ambiguity prompt; enrichment
  from `/in/` pages that fills null columns only.
- **Feature 4 — drafting.** Rule-first persona classification with a veto,
  two-lens hybrid retrieval closed by an LLM reranker (ADR-037), a four-tool
  ReAct loop, and a pure critique pass with one repair turn.
- **Feature 5 — polling and follow-up.** One minimized window reading the
  user's own Sent-invitations and Connections pages, jittered 30–90 min, quiet
  hours 22:00–07:00, passive `OBSERVE_ACCEPTED`, `CheckNow`, and the stale-
  contact sweep that drafts the follow-up.
- **Panel UX repair.** Contacts filter pills with counts; a state sentence per
  contact; the Drafts tab rebuilt as three Sections with a follow-up countdown.
- **Documentation.** `docs/` — PRD, ARCHITECTURE, DESIGN, RULES, TASKS,
  DECISIONS, MEMORY, TEST_PLAN, SECURITY, EVALUATION.
- **Swappable vector store (TASK-906).** RRF extracted from SQL into
  `rag/fuse.ts`; migration `0006` splits the hybrid RPC into dense and sparse
  functions; `rag/store/` holds a `VectorStore` interface with pgvector and
  Qdrant implementations, chosen by `VECTOR_STORE`.
- **Evaluation harness (TASK-907).** Six labelled retrieval cases against a
  committed fixture resume; `eval:retrieval` scores dense, sparse and fused
  separately; `eval:drafting` scores deterministic faithfulness, critique pass
  rate and cross-recipient evidence overlap. See `docs/EVALUATION.md`.
- **Pre-deployment RAG audit (TASK-1007).** Four gaps found and closed:
  the tool response still told the model its evidence came from three lenses in
  lens order after lens C was deleted and reranking was added; `resume_chunks`
  did not record which model embedded it (migration `0007` + `embedding-guard`,
  ADR-040); no drafting run was recorded anywhere (migration `0008` +
  `observability/`, ADR-041); and both eval runners printed "FAIL" while exiting
  0 (`eval/gates.ts`, `pnpm verify` / `verify:release`, ADR-043). A semantic
  cache was considered and **refused** — ADR-042.

---

## Current task

None in flight. **TASK-901** (watchlist clamp), **TASK-904** (stale README),
**TASK-906** (vector store), **TASK-907** (evals), **TASK-902**
(`follow_up_days`), **TASK-1004** (reranking), **TASK-1007** (RAG audit),
**TASK-908** (the first-real-outreach pass, below), **TASK-909** (the
recipient's full profile), **TASK-910** (job-blind ranking, below),
**TASK-1012** (the vault filing CVs one application behind), **TASK-1013**
(the one-shot, self-repeating follow-up engine — ADR-048), **TASK-1014**
(7 drafts in 19 seconds — ADR-049) and **TASK-1015** (the survey-question check
that trained its own evasion — ADR-050) are done. **TASK-1006, TASK-1009,
TASK-1010, TASK-1011, TASK-1016** and the Known issues §13 scraper guard were
all closed on 2026-10-01 — ADR-052 through ADR-057.

**TASK-1017** (the five holes the Nadia Haddad draft found — ADR-058 through
ADR-062) was closed on 2026-10-03.

**That batch is now live apart from the corpus, re-verified 2026-10-03.** `0012`,
`0013` and `0014` are all applied, and `eval:drafting` has been re-run **twice**,
holding both times: **numeric faithfulness 0.833 → 1.000** (6/6), clean-draft
rate 1.000, evidence overlap 0.480, all four gates pass. The number may now be
described as moved. **Do not raise the floors** — six cases, one flip is 0.167,
and the floors sit under the baseline on purpose (`docs/EVALUATION.md` §7).

What is still outstanding is the **corpus, not the code**: the ADR-052 chunker is
live only for the three most recent resumes (Sundus 19/19, Vantage Staffing
20/20, Stealth Startup 10/19); the other thirteen are **still old line-break
chunks**, so on those `isSummaryChunk` and `misattributedFigures` have nothing to
work with. Re-upload them before claiming the grounding batch covers the whole
corpus. Note what the eval does and does not prove: it seeds its **own** corpus
through `chunkResumeText`, so 1.000 is the score on a correctly-chunked corpus —
exactly the thirteen resumes' condition *after* re-upload, and not before. And
it seeds a **job**, so every case runs with a non-null `job_id`: the drafting
eval does **not** exercise 0013 at all. 0013 was verified separately by calling
the RPC with `p_job_id: null`. See `docs/MEMORY.md` → Manual steps, and
`docs/TASKS.md`.

### The PROFESSIONAL SUMMARY chunk is a grounding laundromat

Read this before adding any grounding check. On 2026-10-03 a draft to Nadia
Haddad — the recruiter who *posted* the Vantage Staffing ad — passed every guard with
`problems: [], ungroundedFigures: []`, and told her the candidate had five years
of AI experience he does not have, in wording she had written herself.

Each guard was right on its own terms, which is the point:

- `ungroundedNumbers` saw `5`, `9.5`, `10`, all literally present in the
  retrieved text.
- `misattributedFigures` compares figures *across* chunks. The whole sentence
  came from chunk 1, so `owners.includes(best)` short-circuited. **A sentence
  assembled from a single chunk is unfalsifiable by it.**
- Nothing at all compared the draft against the **job advert**. The JD is in the
  prompt as material, and material in a prompt is what a model reaches for when
  it has nothing better to say.

Chunk 1 is `PROFESSIONAL SUMMARY`, it ranks first in retrieval, and it is where
every headline figure sits beside every skill with the work that earned them
stripped out. The CSAT the draft credited to "systems I built" is earned in
chunk 17 by explaining SQR / PeopleCode logic in go-live support. Chunk 17 was
not retrieved.

Fixed by `echoesJobDescription` (ADR-058), `askAnchors` subtracting the obliged
words (ADR-059) and `summaryOnlyFigures` (ADR-060). The lesson that outlives
them: **a check that can only compare the draft to one chunk is not a grounding
check.**

### TASK-1015 — the critique rule the model rewrote its way out of

The checks added in TASK-1014 were defeated by the first batch of drafts written
after they shipped, on the same day. The cause is structural and generalises:
`repairDraft` ranks candidates by `critiqueDraft().problems.length` **and feeds
the critique text back as the repair instruction**, so a deny-list of phrasings
is a written specification of the cheapest edit that scores better. Two repair
passes were spent turning "What qualities or experiences are you prioritizing in
candidates for this position?" into "What **specific** skills or experiences are
you prioritizing in candidates for this position?", and the run recorded
`critique_problems: 0`.

`GENERIC_ASK` is deleted. `ABSTRACT_SUBJECT` + `askAnchors()` check the *shape*
of the question instead: a category noun as the subject, with nothing in the
sentence tying it to this recipient. Category nouns are filtered out of the
anchor set, because Nikos Pallas's own headline contains "Skills" and would
otherwise have excused the exact draft the rule was written for. The
repeated-ask threshold became `shared >= 3 || ratio >= 0.5` — Lena's
reworded question measured 38% and shipped under a pure ratio. ADR-050.

**The rule to carry forward:** before adding a critique check, ask what the
cheapest edit past it is. If the answer is a reword, the check is wrong.

### TASK-1016 — `Follow_Up_Required` was a one-way edge

`POST /messages/:id/sent` wrote `messages` and nothing else, so a contact the
user had just chased stayed flagged "Follow-up required" forever and the panel
kept telling them to do the thing they had done. The route now clears the flag
in the same request, scoped `.eq("status", "Follow_Up_Required")` so it cannot
clobber `Replied`. The four stuck rows were reconciled by hand with the same
transition. ADR-051.

**The invariant, generalised:** *any write that changes what the system should
do next must reconcile the state that decides it, in the same request.* A 30–90
minute sweep is not a substitute. This is the same shape as the company-matching
invariant below.

The second half of TASK-1016 is **not built**: `repairDraft` returns its best
candidate after two passes whether or not problems survive, and two of the
drafts sent that morning recorded `critique_problems: 1`. The telemetry knew;
the panel said nothing. See Known issues §12.

### TASK-910 — every ranking signal was job-blind

The role the user applied to reached `buildTaskPrompt` and **nothing else**.
Both dense queries, both sparse queries and the rerank rubric were all answering
"what is most impressive about this candidate?", never "about this job". The
symptom: a recruiter screening an Oracle Fusion HCM vacancy was sent a
client-satisfaction score from an unrelated reconciliation tool — top-ranked,
and perfectly on-brief for the question the system had actually asked.
`Technical_Recruiter.caresAbout` literally says "has already done *this job*
somewhere real", which is unevaluable when the grader is never told what the job
is.

Three changes, in causal order:

1. **`extractTechKeywords` → `extractRoleKeywords`** (`rag/keywords.ts`).
   Measured, not guessed: the old function returned `""` for the real 2,714-char
   Oracle JD, because `TECH_VOCAB` was a closed backend-hiring allow-list with no
   `oracle`, `hcm`, `fusion` or `payroll`. The JD contributed **zero** terms to
   retrieval, so Lens B's sparse leg degraded to persona verbs alone — and
   `clients` / `supported` are exactly what the CSAT chunk matches. The allow-list
   is now a deny-list (`JD_BOILERPLATE`) plus weights. ADR-045.
2. **`rag/lens-query.ts`** — a new pure module holding `concernLensQuery`, which
   names the role inside Lens B's dense query. It is a separate file for the same
   reason `embedding-guard.ts` is: `rag/search.ts` reaches `rag/embeddings.ts`,
   which builds the OpenAI client from `env` at import and throws, so nothing in
   that import graph is unit-testable.
3. **The reranker was told what the job is.** `RerankTarget` gained `roleTitle`
   and `roleKeywords`, and the rubric gained a domain test that decides grade 2
   against grade 1 — explicitly *not* a test of how impressive a passage is. A
   quantified achievement from unrelated work is a 1; a weaker number in the
   role's own domain is a 2.

Verified by a read-only ablation against the live Oracle job and the recipient's
real profile — role withheld, rank 0 was a tooling inventory (`PeopleTools
8.59/9.1, SFTP/FTP, PGP keys, Control-M`); role supplied, rank 0 was
`PeopleSoft payroll onto Fusion: Pay Calendars → Payroll Definitions,
PeopleCode → Fast Formula`.

Same pass, a separate defect: **an introduction was being redrafted after it had
been sent.** Hassan Amr's initial outreach was created 08:51:06, marked sent
09:08:17, and written again at 10:48:47 — the reuse lookup filtered
`.is("sent_at", null)`, so a sent message was invisible to it and every
acceptance sweep was another chance to re-introduce the user to someone they had
already written to. `isOncePerContact()` in `agent/draft.ts` now returns the sent
message for `connection_note` and `initial_outreach`; `follow_up` stays
repeatable, being the one type whose purpose is to be sent again. ADR-046.

### TASK-909 — the recipient stopped being a slogan

A draft joins the JD, the tailored resume and the person. The third was a
headline, and a headline is marketing: "Talent Partner | We're hiring!", or
blank. `contacts.profile_text` now carries condensed About + Experience + Skills,
read only from a profile page the user has opened themselves. It steers Lens A
(dense excerpt + the profile's frequent nouns on the sparse leg) and is quoted
into the task prompt inside a fenced REFERENCE-ONLY block.

The load-bearing constraint, which must not be relaxed: **the profile is
query-side only.** It is never embedded and never enters `resume_chunks`. The
corpus is the *candidate's* resume; putting the recipient's career in it would
make their achievements retrievable as evidence about the sender, which is
literally how "improved time-to-fill by 30%" happened. Query-side, the profile
can only change which of the candidate's real bullets is picked. ADR-044.

### TASK-908 — what the first two real messages exposed

Two drafts were sent to recruiters at the company the user had just applied to.
They were the first end-to-end output on a real job search, and they failed in
four ways that were all one causal chain. Recorded because each fix is a rule
that must not be relaxed:

1. `SYSTEM_PROMPT` opened with "You draft LinkedIn outreach for **a software
   engineer**". The candidate is an Oracle Fusion HCM functional consultant, and
   the model believed the prompt over the evidence: the message said "I'm
   currently exploring opportunities in software engineering" to a recruiter who
   sources Oracle consultants. The prompt now says "a candidate" and forbids
   naming the field unless the job title or a retrieved chunk says it.
2. `ungroundedNumbers()` returned `[]` when **no** evidence was retrieved, on the
   reasoning that an unverifiable claim is not a false one. Backwards: with zero
   chunks every figure is necessarily invented, so that is the strictest case,
   not an exemption. It was switched off exactly when it was needed, and shipped
   "improved time-to-fill by 30% through targeted outreach" — a recruiter's own
   job description, attributed to the sender. The phrase "candidate pipeline"
   traces to the *recipient's* profile text. Two tests encoded the old contract
   and were inverted.
3. `OUT_OF_REMIT` listed exact nouns. `implementations?` does not match the
   gerund, so a recruiter was asked "the biggest challenge your team faces when
   **implementing** Oracle Fusion HCM solutions" — a delivery question she cannot
   answer, the clearest tell of a mass-produced message. Now stems
   (`implement\w*`, `integrat\w*`, `migrat\w*`, `configur\w*`, `customi[sz]\w*`,
   `roll[\s-]?out`, `trade[\s-]?offs?`).
4. The contact was never linked to the job, so `roleTitle` was null and the
   "name the role you applied to" rule never fired — the single highest-value
   fact was dropped. See Known issues §3.

### Recorded eval numbers

Run against the live Supabase project. Both harnesses seed and tear down a
throwaway job, so these are reproducible but not free.

| | before this round | 2026-09-28 | latest |
|---|---|---|---|
| `eval:retrieval` pipeline nDCG@3 | 0.544 | 0.710 | **0.732** (10-08) |
| `eval:retrieval` pipeline MRR | 0.500 | 0.667 | **0.639** (10-08) |
| `eval:retrieval` pipeline hit-rate | 0.667 | 0.833 | **1.000** (10-08) |
| forbidden-chunk violations | 5 / 6 | 1 / 6 | **1 / 6** (10-08) |
| `eval:drafting` numeric faithfulness | 1.000 | 0.833 | **1.000** (10-03) |
| `eval:drafting` clean drafts | 6 / 6 | 5 / 6 | **6 / 6** (10-03) |
| `eval:drafting` evidence overlap | 0.527 | 0.507 | **0.480** (10-03) |

**All eight gates pass and nothing in this table is stale.** Detail and the
per-leg breakdown live in `docs/EVALUATION.md` §6.

The 10-08 retrieval run improved hit-rate decisively (0.833 → **1.000** — every
recipient now gets its gold chunk in the top 3) while **MRR fell, 0.667 →
0.639**. Do not quote either as a trend. MRR moves 0.083 when a single case
slips rank 1 → 2, which is three times the observed drop and inside the ±1 rank
wobble below. One run is not a trend; a second must agree first.

The drafting rows are from 2026-10-03 and faithfulness **is** now 1.000 — the
TASK-1006 rounding defect ("over 32,000" for 32,330) is fixed. Evidence overlap
is near its arithmetic floor on a six-chunk fixture — three slots drawn from
roughly four usable chunks forces a pairwise Jaccard around 0.5 — so it means
little until the fixture grows.

Retrieval is also no longer fully deterministic: `gpt-4o-mini` at temperature 0
returns slightly different grades between runs, so a ±1 rank wobble in
`eval:retrieval` is noise, not a regression. → TASK-1005.

---

## Known issues

### 1. Reply drafting does not exist

`checkForReplies()` sends `OBSERVE_REPLY` with `{ linkedinUrl }` only. The reply
**text is never captured**, and `MessageType` has no reply value. Building it
needs a Postgres enum migration, thread scraping and agent work. Do not let any
doc, commit message or answer imply otherwise — it has been claimed before.
→ TASK-903.

### 2. Robustness audit, 2026-09-29 — Tier 1 fixed, Tier 2 open

A full read of every file found the system in far better shape than its size
suggests; the density of *why* comments means most oddities are documented
decisions, not accidents. Seven genuine defects were fixed:

- `background/network-scan.ts` — the `tabId === undefined` early return sat
  *before* the `try/finally`, orphaning a minimized LinkedIn window per sweep.
- `rag/store/qdrant.ts` — `this.ready ??=` cached a **rejected** promise, so one
  transient outage disabled the dense leg for the process lifetime. Also
  `?? []` wrote an empty vector, which Qdrant rejects for the whole batch.
- `rag/index-resume.ts` — the old object, vectors and row were destroyed
  *before* the upload and embed were attempted. Now everything fallible runs
  first, and the old object is only removed when its key actually changed
  (the key is deterministic, so it usually does not).
- `agent/tools.ts` — Tavily fetch had no timeout.
- `extension/src/lib/api.ts` — no `AbortController` on any request; 30s default,
  120s for `/drafts` and `/resumes`, and network errors now name themselves.
- `services/followup.ts` — `lastSent.sent_at > cutoff` compared PostgREST's
  timestamptz rendering against a JS ISO string **lexicographically**.
- `agent/draft.ts` — a non-function tool call was skipped without emitting a
  `tool` message, which the API rejects on the following turn.

A second pass then closed six of the eight behaviour-changing items:

- `services/contacts.ts` — `captureContact` was a blanket upsert, so a second
  Connect click on an accepted contact wrote `status: "Pending"`, a fresh
  `connected_at` and a recomputed `job_id`. It now fills blanks only, exactly
  like `enrichContact`; an explicit `jobId` (the disambiguation toast) is the
  one thing that overrides stored state. `candidateJobs` is narrowed to the
  linked job, because the toast names `candidateJobs[0]`.
- `shared/constants.ts` + `shared/api.ts` — `MAX_RESUME_BYTES` (10MB) enforced
  in the contract, and checked in `resume-capture.ts` on `file.size` *before*
  the bytes are read and base64-expanded into `chrome.storage.local`.
- `server/index.ts` — `onError` no longer returns `err.message`. It logs an
  8-char reference next to the stack and returns only that, so a user can point
  at the exact log line without the server naming tables or connection strings.
- `server/env.ts` — `.superRefine` rejects `VECTOR_STORE=qdrant` without
  `QDRANT_URL` at boot rather than at first retrieval.
- Migration **0009** — `escape_like()` applied to both sides of
  `match_jobs_by_company`'s containment test, and a unique key on
  `resume_chunks(resume_id, chunk_index)` (with a dedupe delete first).
  `escapeLikePattern()` in `services/company-match.ts` is its TypeScript twin
  and is used by `check_company_message_history`, whose argument comes from the
  model. **Keep the two in step.**
- `rag/store/pgvector.ts` — `upsertChunks` is now an actual upsert on that key
  rather than a bare insert.

Still open, both deliberately deferred: `unwrap()` turns "row not found" into a
500 across every route (cosmetic, wide blast radius); `linkContactsForJob`
(all contacts × all jobs per job write) and `sweepStaleContacts` (3 round trips
per Accepted contact) are O(n) and only matter past a few hundred rows.

Not a defect, despite appearances: `REMIT` in `agent/critique.ts` omits
`Founder_Executive`, `Engineering_Leader` and `Peer_Engineer` deliberately —
those recipients *can* answer a technical question. The `Partial<>` is the
signal.

### 3. A recovered contact has no employer, so it cannot be auto-linked

**The auto-link logic is correct. The data it needs is missing.** This is worth
stating precisely, because the symptom ("I have to pick the application from a
dropdown myself") looks like the matcher is broken, and it is not.

`captureMissedInvitations()` in `background/poller.ts` recovers contacts off the
user's own **Sent invitations** page, which renders a name and a headline and
nothing else. It therefore posts `company: null`, and the server falls back to
`companyFromHeadline()`. Recruiter headlines almost never name the employer —
"Technical Talent Acquisition Specialist" and "Senior Technical Talent
Acquisition" both do — so there is no company to match on, `matchingJobs()`
returns nothing, and the contact lands in General networking. Correctly: a
guessed link silently poisons every future draft for that person, and the same
`roleTitle: null` that follows is what dropped "I applied for your Oracle Fusion
HCM Functional Consultant role" out of the message in TASK-908.

The remedy already exists and is one click: **open the contact's LinkedIn
profile once.** `contents/linkedin-profile.ts` fires `ENRICH_CONTACT` on every
`/in/` page, `scrapeProfile()` reads the current employer from
`PROFILE_COMPANY_SELECTORS`, `enrichContact()` fills the null column, and
`POST /contacts/enrich` re-runs `matchingJobs()` when it learns an employer for
an unlinked contact. The link then appears on its own.

What is *not* acceptable as a fix: fetching profiles in bulk during a sweep to
harvest employers. That turns two self-page reads into N third-party profile
views and breaks the anti-ban posture in PRD §6, which is the one thing this
system cannot afford to get wrong. The honest options are the profile visit
above, or surfacing "no employer on file" in the panel so the remedy is
discoverable. Left as the former.

### 4. The chunker splits on line breaks ✅ CODE FIXED · DATA NOT RE-INDEXED

**Code fixed 2026-10-01 → ADR-052.** `sectionHeader()` now decides boundaries.
**The live corpus has not changed.** Existing `resume_chunks` rows were written
by the old chunker and stay exactly as described below until each resume is
re-uploaded. Until then, a draft produced live is evidence about the *old*
chunker — do not read one as proof the fix works, and do not quote an improved
draft as a result. The fix is proven by the fixture (8 chunks, one per section)
and by tests, which is the only proof available without re-indexing.

The original write-up, still true of the data:

**The most-retrieved chunk in the corpus is malformed, and it is the root cause
under the 2026-09-30 draft review.** `chunkResumeText` (`rag/chunk.ts:18`)
split on `/\r?\n/`. A PDF's visual line-wrap is therefore treated as a semantic
boundary, and section headers are invisible to it. Chunk 1 of the Oracle resume
is 635 characters holding three unrelated facts *plus* the CORE SKILLS wall:
the Fusion migration mapping, the reconciliation app built for a broker, the
CSAT figure, then `CORE SKILLS` and the comma-separated technology list.

Three consequences, all structural rather than incidental:

1. **Adjacency reads as causation.** The agent wrote "implementing Payroll
   Definitions and Fast Formula, **along with** a consistent client satisfaction
   score above 9.5/10" — welding a figure from the broker tool onto the Fusion
   work. Nothing in the chunk says which sentence the number belongs to, so that
   is the grammatically correct rendering of what the chunk actually contains.
2. **The reranker cannot reject the skills wall.** `applyGrades` scores per
   chunk, and the wall — the exact artefact the reranker exists to score 0 — now
   sits inside the single most valuable chunk in the corpus. It has become
   un-gradeable.
3. **It is not an outlier.** Chunk `1b5c6bcd` appears in the citations of every
   row in `draft_runs`. Chunk 0 also ends mid-sentence (`"…and mapping my"`),
   because the overlap carry is line-based too.

→ TASK-1009 ✅. Fixed before anything else in the drafting stack, because it
silently capped what the reranker and the critique pass could achieve.

### 5. `critiqueDraft` checks figures, not attribution ✅ FIXED

`ungroundedNumbers` asks only whether a figure appears *somewhere* in the
retrieved text. It cannot ask whether the figure belongs to the claim the
sentence attaches it to. The conjoined-attribution draft above scored **0
critique problems, 0 ungrounded figures, 0 repair passes** — the system believes
it is clean.

Related, and from the same telemetry read: the 11:00:41 run recorded
`evidence_chunk_ids=[]` and **also** scored 0 critique problems.
`ungroundedNumbers` was correctly hardened for the empty-corpus case (see
`docs/DECISIONS.md`), but every other check still passes on a draft built from
no evidence at all. There is no "did retrieval return anything?" gate.
→ TASK-1010.

**Fixed 2026-10-01 → ADR-053, ADR-054.** `misattributedFigures()` answers the
attribution question per sentence. The zero-evidence case is *not* a critique
problem — it would be unsatisfiable and would burn both repair passes — it is
`messages.review.evidenceCount`, shown on the card as "Nothing in this message
came from your resume." Note what is still true: the attribution check only works
on top of §4's chunking fix, so **it will not catch anything on the live corpus
until the resumes are re-indexed**, because on old chunks the figure and the
claim usually sit in the same chunk.

### 6. A contact with no linked application gets a content-free draft ✅ FIXED

`agent/tools.ts` returns `{ hits: [] }` with a "write a general networking
message and make no specific claims" note whenever `ctx.jobId` is null. Measured
on the live project 2026-10-01: **6 of 31 contacts (19%) have no linked
application**, so roughly one draft in five is written with zero evidence. This
is the ordinary case for a plain LinkedIn connection, not an edge case.

The invariant in `rag/store/types.ts:26` — "retrieval must never cross
applications" — is what forbids the obvious fix. The carve-out that would honour
it: permit cross-job retrieval **only when `job_id IS NULL`**, i.e. when there is
no application to stay inside. Cost is a migration, because both the dense
and sparse RPCs take `job_id` as a required argument.
→ TASK-1011.

**Decided and built 2026-10-01 → ADR-056.** The carve-out is taken, in migration
**0013** (0012 went to `messages.review`). `jobId` is `string | null` through
every layer so the carve-out is visible in the signatures, and the tool attaches
a `provenance` note forbidding the model to mention a role, a referral or a
resume. **0013 applied and verified live 2026-10-03** — the skip is silent, so
"it ran" is not evidence; the verification that counts is calling
`sparse_search_resume_chunks` with `p_job_id: null` and getting chunks back,
which an unapplied 0013 cannot do (`where c.job_id = null` is never true, so it
returns zero hits exactly as before rather than erroring).

### 7. One application still holds another's CV — DATA, not code · MOSTLY REPAIRED

The code is fixed (TASK-1012 / ADR-047). Two of the three corrupted rows were
repaired by the user on 2026-10-01 at 05:47. **Re-verified by hashing the stored
documents' own extracted text, not inferred from filenames** — a vault filename
is generated from the job and therefore proves nothing about content:

| job | holds | state |
| --- | --- | --- |
| Cedar Union CRM / AI Engineer | its own CV (8,772 ch, 14 chunks) | ✅ repaired 05:47:53 |
| Raw Ventures / Backend Engineer | its own CV (8,500 ch, 14 chunks) | ✅ repaired 05:47:18 |
| Trellis Digital / AI Field Deployment Engineers | the **Cedar Union CRM** CV | ❌ still wrong |

Trellis Digital's document is **byte-identical** to the Cedar Union one (same SHA-1 of
`extracted_text`, both 8,772 chars). Its own tailored CV was the object
overwritten in place at 03:13:31 and Supabase Storage keeps no version, so this
row cannot be repaired from inside the system — it needs the original PDF, or a
newly tailored one, attached through the application card's **Replace** control.
Until then, every draft for a contact at Trellis Digital cites a CV written for a
different company.

**Also unrepairable:** the Solutions Engineer application has no row at all. It
was committed against a stale Trellis Digital handshake, and because the
requisition id matched, `POST /jobs` took its `UPDATE` branch and overwrote that
row instead of creating one (visible as `created_at` 02:52:34 against
`applied_at` 03:06:07).

### 8. Two of the three groundless applications are fixed; one remains ✅ MOSTLY

Not a retrieval bug — the corpus was wrong or absent. State after the user's
2026-10-01 uploads, read back from `resumes` and `resume_chunks`:

| contact | application | corpus |
| --- | --- | --- |
| Omar Faruq | Clearwater Labs / AI-LLM Systems Engineer | ✅ real CV, 8,280 ch, 14 chunks (07:11:30) |
| Lena Hartmann | Vector AI / PM of AI Applications | ✅ real CV, 9,279 ch, 15 chunks (07:14:58) |
| Daniel R. | — (no linked job) | ❌ still nothing to retrieve from |

Two things to keep straight about this repair, because both were initially read
the wrong way round:

1. **The drafts the user reviewed at 07:02 predate both uploads.** Omar's run
   recorded `evidence_chunk_ids: []`, and the chunks Lena's run cited no
   longer exist — they belonged to the deleted cover letter. Two of the four
   drafts in that batch were being judged against a corpus the system did not
   yet have.
2. **Replacing the cover letter did not remove the 9.5/10 figure.** The real
   Vector AI CV *also* contains "kept client satisfaction above 9.5/10 for nine
   consecutive months", so the draft was correctly grounded both before and
   after. The objection to it is editorial, not factual: a support metric is the
   wrong evidence for an AI PM role. That is TASK-1009/1010 territory
   (attribution and chunking), not a grounding bug.

**A cover letter should never be a job's only indexed document.** `documentRank`
already distinguishes them (cover letter 0 < unknown 1 < resume 2), but
`acceptsDelivery` accepts the *first* document of any rank. Still not fixed.

### 9. The stranded follow-ups are resolved ✅

The old one-shot sweep left Omar Faruq, Daniel R. and Nikos Pallas in
`Follow_Up_Required` with no message of any kind since 2026-09-24 / 09-25. The
widened sweep (TASK-1013 / ADR-048) drafted for all four — and immediately
exposed TASK-1014: ~25 profile opens fired ~25 overlapping sweeps, producing 7
drafts for 4 contacts in 19 seconds. All 7 were discarded through the DELETE
route.

Migration **0011** is now applied and it holds: the next sweep, at 07:02, wrote
exactly 4 drafts for 4 contacts. All four were sent. `Follow_Up_Required` is
now 0 across the table.

### 10. Contact profile text: now complete, but it does not backfill itself

**Resolved for the current 31 contacts.** Verified live on 2026-10-01 after the
observer fix: 31 of 31 rows have `profile_text`, read between 06:22 and 06:27.
Before the fix it was 3 of 31.

It does **not** backfill, though, and PRD §6 forbids bulk-fetching profiles to
make it. Any contact captured from the Sent-invitations page still arrives with
a headline only; their profile has to be opened once. Note also that several
rows are thin (Mike James 67 chars, Mahmoud Ahmed 85) — non-null is not the same
as useful.

### 11. Loose files in the repo root

`Profile.pdf`, `Profile (4).pdf`, `Arjun_Nair_Resume_ClearwaterLabs.pdf`,
`1790349042597-Arjun_Nair_CV.pdf`, and a stale
`extension/build/chrome-mv3-dev` directory. None should be committed if git is
initialised. → TASK-905. Keep the CVs until Known issues §7 is repaired — they
may be the only copies of the misfiled documents.

### 12. A draft the critique still objects to is presented as ready ✅ FIXED

`repairDraft` runs at most `MAX_REPAIR_PASSES = 2` and then returns its best
candidate **whether or not problems remain**. On 2026-10-01 two of the four
drafts in the 07:32 batch recorded `critique_problems: 1`; Nikos's went out
ending "What qualities are you prioritizing in candidates for this role?" after
both passes were spent. The user approved and sent two messages the system
itself had flagged, because `DraftCard` renders a draft identically whether the
checker is satisfied or not.

Shipping anyway is the correct default — a flawed draft the user can edit beats
no draft — but it must be visible. Surviving problems should be returned from
`generateDraft` and rendered above the Approve control as the system's own
reservations. → TASK-1016.

**Fixed 2026-10-01 → ADR-054, migration 0012.** The review is persisted on the
message rather than only in `draft_runs` (which is write-only and may fail
silently), and `DraftCard` renders three states. The clean state is deliberately
not silent. **The two already-sent messages are not retroactively annotated** —
their rows predate 0012 and `review` is null, which the card states outright
rather than defaulting to "clean".

### 13. Three job rows are scraper garbage, and two hold no resume
     ⚠️ CODE FIXED · THE THREE ROWS ARE UNREPAIRED AND NEED THE USER

Read live 2026-10-01, from `jobs` joined to `resumes`:

| row | problem |
| --- | --- |
| `CloudMotiv` / **"Remote"** | the title is the location; `680cc301`; no resume |
| `Danube Properties` / **"Share negative feedback"** | the title is a LinkedIn UI control |
| `Instrumental` / **"Share negative feedback"** | same; `78f2d988`; no resume |

"Share negative feedback" is a button LinkedIn renders inside the job card, so
`JOB_TITLE_SELECTORS` is matching a control rather than the heading on at least
one layout. "Remote" is the workplace-type pill. These are capture defects, not
data entry — a wrong title reaches `extractRoleKeywords`, `concernLensQuery` and
the rerank rubric, so every ranking signal for those applications is steered by
a word from the chrome.

**Code fixed 2026-10-01 → ADR-057.** The scraper rule existed already; what was
missing was that it lived where **the extension has no test runner**, and that
`POST /jobs` — also called by the manual "I applied" flow and the ATS scrapers —
accepted anything. `looksLikeJobTitle` moved to the zod-free `@crm/shared/job-title`
subpath with 5 tests, and both `POST /jobs` and `PATCH /jobs/:id` now return 400
naming the offending string rather than dropping it silently.

**The three rows are still wrong.** Their real titles are not recoverable from
anything stored, and guessing them would steer the same ranking signals more
quietly. This needs the user to supply the titles, or to say the rows should go.
Nothing has been written to them. → Manual steps.

Note also that **`a7029307` — Clearwater Labs / AI-LLM Systems Engineer — is no
longer a stray row to delete.** It was created by a verification curl, but it
now holds a real indexed CV and Omar Faruq is linked to it. Deleting it would
destroy a working application. The old instruction to remove it has been
withdrawn.

---

## Manual steps not confirmed done

These are on the user's machine, not in the code. Nothing verified them.

- [x] Migrations `0003`–`0006` are in. Both eval harnesses now run green
      against the live project, which they could not do without
      `dense_search_resume_chunks` / `sparse_search_resume_chunks`. That is
      evidence, not a report from the user — nobody typed "done".
- [x] **`0007`, `0008` and `0009` are applied.** Verified by querying the live
      project, not by report. 0007 backfilled existing chunks with
      `text-embedding-3-small`, so a corpus indexed before that day is assumed
      to have been embedded by the current model. That is true here; it is an
      assumption, and it is the only one.
- [x] **`0010` is applied.** Verified by a live enrich round-trip — a `/in/`
      visit filled `contacts.profile_text` and `profile_read_at` for a real
      contact and both read back. Not a report from the user.
- [x] **`0011_one_unsent_draft_per_contact.sql` is applied.** Evidence, not a
      report: the 07:02 sweep wrote exactly 4 drafts for 4 contacts, where the
      previous one wrote 7 for 4 in 19 seconds.
- [x] **The real CV is attached to the Vector AI application** (9,279 ch, 15
      chunks, 07:14:58) and to **Clearwater Labs** (8,280 ch, 14 chunks, 07:11:30).
      Verified by reading `resumes.extracted_text` and counting `resume_chunks`.
- [x] **Cedar Union CRM and Raw Ventures hold their own CVs again** (05:47). Verified
      by hashing the extracted text, not by trusting the filename.
- [x] **`0012_message_review.sql` is applied.** Verified 2026-10-03 by reading a
      populated `review` object off a live `messages` row, not by report.
- [x] **`0013_corpus_wide_search_for_unlinked_contacts.sql` is applied**
      (2026-10-03). Its skip is silent — unlinked contacts keep getting
      zero-evidence drafts exactly as before — so the user's report that it ran
      is not evidence. What is: calling `sparse_search_resume_chunks` with
      `p_job_id: null` returned chunks, which an unapplied 0013 cannot do.
- [x] **`0014_record_accepted_repairs.sql` is applied** (2026-10-03). Verified
      by six fresh `draft_runs` rows inserting with a `repair_accepted` value.
      That is the only check that works: `recordDraftRun` swallows the insert
      error by design, so an unapplied 0014 leaves drafting working and only a
      `[draft_runs] insert failed` warning in the log.
- [x] **The migration ledger is baselined** (2026-10-08, ADR-063). Evidence, not
      a report: `schema_migrations` holds 14 rows, versions 1–14; a second
      `migrate` printed "Database is up to date.", which it cannot do unless
      every checksum matches disk and no row is orphaned; and the append-only
      guard was fired on purpose — 0014 was edited, `migrate` refused it by name
      and exited non-zero, and the restored file hashed identical to the
      checksum already in the ledger.
- [ ] **Re-upload the remaining thirteen resumes.** The chunker changed
      (ADR-052) and nothing rewrites existing rows. Three are already on the new
      chunker — Sundus (19/19 chunks section-labelled), Vantage Staffing (20/20) and
      Stealth Startup (10/19) — and the other thirteen are still line-break
      chunks, where `isSummaryChunk` and `misattributedFigures` have nothing to
      work with and any draft produced is evidence about the *old* chunker.
      Chunk ids change, so older `draft_runs` citations will not resolve —
      accepted.
- [ ] **Attach a correct CV to the Trellis Digital application.** It still holds a
      document byte-identical to the Cedar Union CRM CV. Known issues §7.
- [ ] **Reload the unpacked extension** at `chrome://extensions`. The panel code
      changed (`contactStateLine`, the Draft-outreach gate, and now the
      `DraftCard` review notice); the server already picked its changes up
      through `tsx watch`. Reload open LinkedIn tabs too — content scripts are
      only re-injected on a real navigation.
- [ ] Set **`userName` = `Arjun Nair`** in the extension Settings tab.
      Missing it degrades every vault filename to `Company_Role.pdf`.
- [ ] Add the Norton Blake Easy Apply job manually from the Jobs tab.
- [ ] **Supply the real titles for the three malformed job rows** in Known issues
      §13 (`CloudMotiv / Remote`, two × `Share negative feedback`), or say the
      rows should be deleted. The scraper and the server now refuse these
      strings, but nothing can recover what the titles were meant to be, and
      guessing them would poison the same ranking signals more quietly.
- [x] **All four credentials rotated** (2026-10-08, before the first push): the
      database password, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` and
      `CRM_AUTH_TOKEN`. None was ever committed — `server/.env` is gitignored —
      but each had appeared in a terminal transcript, and a key displayed
      anywhere is burned. Evidence: 27 job rows returned through a containerised
      server using all of them, and the new service-role key is a `sb_secret_…`
      rather than the previous `eyJ…` JWT, so it is demonstrably not a re-read.
- [ ] **Flip the GHCR package to public** if a future fork republishes it.
      Already done for this repo, but GHCR creates packages private even from a
      public repo and nothing warns you: github.com/\<user\>?tab=packages →
      package → Package settings → Danger Zone → Change visibility. Until then
      `docker compose pull` fails with an auth error that never mentions
      visibility.

---

## Next step

**TASK-1006, 1009, 1010, 1011, 1016 and Known issues §13 are code-complete as of
2026-10-01** (ADR-052…057), and **TASK-1017 as of 2026-10-03** (ADR-058…062) —
**260 tests / 52 suites green, no zod in any content script**. As of 2026-10-03
`0012`, `0013` and `0014` are all applied, `eval:drafting` has been re-run twice
at **1.000** numeric faithfulness, and TASK-905 is closed. The repo is public
and **v1.0.0 is released** (2026-10-08): migrations apply themselves (ADR-063),
the server ships as a published multi-arch image and the extension as a zip, so
installing needs neither Node nor pnpm. What is left is the corpus and two live
observations:

1. **Re-upload the remaining thirteen resumes**, then read one new
   `resume_chunks` row and confirm it starts with a section name. On old chunks
   the attribution check has nothing to catch and `isSummaryChunk` has no
   opinion, so ADR-052, ADR-053 and ADR-060 are all inert there. This is the
   single highest-value item left: the eval seeds its own correctly-chunked
   corpus, so 1.000 describes the state these thirteen are *not* in.
2. **Re-run `eval:retrieval` once more to settle the MRR movement.** Done
   2026-10-08: hit-rate 0.833 → 1.000, nDCG 0.710 → 0.732, MRR 0.667 → 0.639,
   all four gates pass. The MRR drop is smaller than the documented ±1-rank
   wobble, so a second run is what decides whether it is a trade or noise.
   Spends real credit; ask first. Note the harness seeds its **own** fixture
   corpus, so this measures the pipeline, not the state of step 1's thirteen
   resumes — the two are independent.
3. **Watch one general-networking draft end to end** for an unlinked contact
   (Daniel R.) and confirm `evidence_chunk_ids` is no longer empty. The drafting
   eval seeds a job, so it never exercises the `jobId: null` path; 0013 is
   verified at the RPC but not yet through the agent. Read-only — do not
   hand-insert anything to make it pass.
4. **Draft one new message to a recruiter who posted the ad** and confirm
   `echoesJobDescription` fires in the panel rather than only in a replay.
   Nadia's stored row is the regression fixture; a fresh run is the proof.
5. **Confirm `repair_accepted` ever goes above 0.** Every row holding it today
   is backfill or a clean run, so the column 0014 exists to populate has not yet
   been populated by a real repair. Until one is, "the repair loop earns its
   tokens" is still unmeasured.
6. **Supply the three real job titles**, or decide the rows go. Nothing in the
   data can recover them.
7. **TASK-903** — reply drafting. The only genuinely missing feature, and the
   largest: an enum migration (now `0015`), scraping, prompt, critique rules,
   tests, UI.

Before starting any of them, read `docs/RULES.md` → Before coding.
