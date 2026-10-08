# Tasks

One TASK-ID at a time. Do not batch. A task is done when the three
verification commands in `docs/RULES.md` → Testing pass, not when the code
compiles.

Phases 1–8 are **already implemented**. They are recorded here so that an agent
reading this file knows what exists and does not rebuild it. Phase 9 onward is
the open work.

Legend: `[x]` shipped · `[ ]` not started · `[~]` partially there

---

## Phase 1 — Foundations

- [x] **TASK-101** pnpm workspace: `packages/shared`, `server`, `extension`,
      `supabase`.
- [x] **TASK-102** `packages/shared`: domain types, zod API contracts
      (`src/api.ts`), constants (`src/constants.ts`), plus the
      `@crm/shared/constants` subpath export so extension bundles never pull in
      zod.
- [x] **TASK-103** Supabase migration `0001_init.sql` — five enums, five
      tables, trigram + HNSW indexes, `hybrid_search_resume_chunks`,
      `match_jobs_by_company`.
- [x] **TASK-104** Migration `0002_storage_and_rls.sql` — private `resumes`
      bucket, RLS enabled on all five tables with **no policies**.
- [x] **TASK-105** Hono server skeleton: `env.ts` (zod, throws at import),
      CORS allowlist, `x-crm-token` middleware with constant-time compare,
      `app.onError` → `HttpError`.
- [x] **TASK-106** Plasmo MV3 extension skeleton: side panel, background
      worker, `lib/api.ts`, `lib/settings.ts`.

## Phase 2 — Feature 1, application tracking

- [x] **TASK-201** LinkedIn job-page scraper (`lib/linkedin-scrape.ts`):
      company, title, location, URL, full description.
- [x] **TASK-202** Easy Apply detection — match the control's **visible text**,
      not an `aria-label`.
- [x] **TASK-203** External-ATS handshake: capture the JD before navigation,
      park it in `chrome.storage.local` with a 2 h TTL, commit on a genuine ATS
      success signal.
- [x] **TASK-204** `POST /jobs` + `PATCH /jobs/:id`, with `findJobId()`
      read-then-write dedupe (PostgREST cannot `on_conflict` a partial index).
- [x] **TASK-205** Side-panel **"I applied"** fallback for sites where submit
      cannot be detected.
- [x] **TASK-206** Jobs tab: list, status `<select>`, pending-application
      prompts.

## Phase 3 — Feature 2, Document Vault

- [x] **TASK-301** `lib/resume-capture.ts` — capture-phase listener on every
      `input[type=file]`, `STASH_RESUME` to the worker.
- [x] **TASK-302** `background/resume-stash.ts` — per-tab stash in
      `chrome.storage.local`, TTL = `HANDSHAKE_TTL_MS`.
- [x] **TASK-303** `documentRank()` — a cover letter attached after the CV must
      not overwrite it; unrecognised filenames still count.
- [x] **TASK-304** `POST /resumes` — upload to the private bucket at
      `<jobId>/<sanitized name>`, delete the previous object first.
- [x] **TASK-305** `resume-name.ts` — canonical
      `<Name>_<Company>_<Role>.pdf`, degrading to `Company_Role.pdf` when
      `userName` is unset.
- [x] **TASK-306** `GET /resumes/:id/download` — 60 s signed URL with
      `download: fileName` so Content-Disposition names the file.
- [x] **TASK-307** Server-side PDF text extraction (`rag/pdf.ts`), 422 when no
      text can be read.
- [x] **TASK-308** Chunk + embed (`CHUNK_TARGET_CHARS` 700 / overlap 100,
      `text-embedding-3-small`, 1536 dims). Re-index deletes prior chunks.
- [x] **TASK-309** Vault tab: list, download, re-upload.

## Phase 4 — Feature 3, entity mapping

- [x] **TASK-401** `POST /contacts/capture` on Connect — upsert on
      `linkedin_url`.
- [x] **TASK-402** `match_jobs_by_company` RPC + `companiesMatch()` in TS, with
      a 3-char floor so "AI" / "Co" cannot wildcard.
- [x] **TASK-403** Order-independence: `linkContactsForJob()` on `POST /jobs`
      **and** `PATCH /jobs/:id`.
- [x] **TASK-404** Ambiguity toast — two or more matches asks the user; it never
      guesses. Actionable toasts have `timeoutMs = 0`.
- [x] **TASK-405** `POST /contacts/enrich` — fills **only null columns**, never
      touches `status`, re-runs the match if it learns the employer. Unknown
      profiles are a no-op, not a 404.

## Phase 5 — Feature 4, persona-aware drafting

- [x] **TASK-501** `personaFromHeadline()` — rules first, and it **vetoes** the
      model's `classify_persona` when they disagree.
- [x] **TASK-502** Five personas across migrations `0001`, `0003`, `0004` (one
      `alter type … add value` per file).
- [x] **TASK-503** Hybrid search — pgvector cosine + `ts_rank_cd` fused with RRF
      (k = 60). Superseded by TASK-906: the legs are now separate RPCs and
      fusion moved into `rag/fuse.ts`.
- [x] **TASK-504** `toOrQuery()` — `websearch_to_tsquery` ANDs bare words, so
      the sparse leg was matching nothing on every draft ever generated.
- [x] **TASK-505** Migration `0005` — `ts_rank_cd` normalization flag `1`, so
      the longest chunk stops always winning.
- [x] **TASK-506** Multi-lens retrieval (`rag/search.ts`): recipient headline /
      persona concerns. Shipped as three lenses interleaved; TASK-1004 deleted
      the JD-only lens and replaced `interleave()` with cross-lens RRF.
- [x] **TASK-507** ReAct loop (`agent/draft.ts`) — `gpt-4o-mini`, `MAX_TURNS` 6,
      four tools.
- [x] **TASK-508** `agent/critique.ts` — banned phrases, exclamation marks,
      >1 question, first-name opener, `mentionsRole()`, out-of-remit asks, and
      **every figure checked against the retrieved chunks**.
- [x] **TASK-509** Repair turns, kept only if they fix more than they break.
      Now up to two, scored lexicographically on (ungrounded figures, style
      problems) — see ADR-038.
- [x] **TASK-510** Insert into LinkedIn's composer and outline the native Send
      button — never click it.

## Phase 6 — Feature 5, polling and follow-up

- [x] **TASK-601** `background/network-scan.ts` — one minimized window reading
      the user's **own** Sent-invitations and Connections pages. No profile
      visits.
- [x] **TASK-602** `runSweep()` reconciles the whole `Pending` watchlist against
      one snapshot; withdrawn/expired contacts are dropped, not reported
      `accepted: false`.
- [x] **TASK-603** Jittered alarm 30–90 min, quiet hours 22:00–07:00,
      `ensureSweepScheduled()` (re-arming unconditionally pushed the alarm out
      on every dev reload, so it never fired).
- [x] **TASK-604** `captureMissedInvitations()` — up to 20 new contacts per
      sweep from sent invitations not already tracked.
- [x] **TASK-605** Passive `OBSERVE_ACCEPTED` from 1st-degree `/in/` pages and
      the Connections page.
- [x] **TASK-606** `sweepStaleContacts()` — Accepted + last sent > N days + no
      unsent follow-up → `Follow_Up_Required` + a drafted follow-up.
- [x] **TASK-607** `draftFor()` writes the drafts for `needsDraft`; a badge
      alone was not enough.
- [x] **TASK-608** `CheckNow` in the Contacts tab — `force: true`, skips quiet
      hours, and distinguishes "checked 4, no change" from "could not read
      LinkedIn".

## Phase 7 — Side-panel UX repair

- [x] **TASK-701** Contacts filter pills — All / Waiting / Connected / Replied,
      always with counts including zero. User's words, not the enum's.
- [x] **TASK-702** `contactStateLine()` — one plain sentence per contact ending
      in a fact or the next thing the system will do.
- [x] **TASK-703** Drafts tab rebuilt as three Sections — **Needs your
      approval** / **Sent · waiting for a reply** / **Replied** — with the
      follow-up countdown. Marking a message sent used to empty the page.
- [x] **TASK-704** "Draft follow-up early" button; safe to press twice because
      `generateDraft()` returns the existing unsent draft.

## Phase 8 — Correctness fixes already made

- [x] **TASK-801** Never short-circuit `syncObservations()`. All three callers
      early-returned on an empty observation list, so the follow-up engine
      switched itself off precisely when every invitation had been accepted —
      i.e. on success.
- [x] **TASK-802** Gate `draftFor()` and `DATA_CHANGED` on
      `needsDraft.length > 0 || updated > 0`. The stale sweep's transitions
      never increment `updated`.
- [x] **TASK-803** Seed `ctx.persona` from `personaFromHeadline` in `draft.ts` —
      nothing forces the model to call `classify_persona` first, and when it
      skipped, retrieval fell back to the JD-only lens.
- [x] **TASK-804** Broad content-script match patterns. Chrome only injects on a
      real navigation and LinkedIn is a SPA, so a narrow path list silently lost
      every client-side route.

---

## Phase 9 — Open work

### TASK-901 — Raise the watchlist limit *(bug, small)* ✅ DONE

`GET /sync/watchlist` clamped `limit` to `Math.min(Math.max(limit, 1), 10)`
while the extension passes `MAX_CONTACTS_PER_SWEEP = 100`. A sweep therefore
reconciled **at most 10 contacts**, silently, no matter how many were pending.

- [x] Clamp raised to `MAX_CONTACTS_PER_SWEEP`, imported from
      `@crm/shared/constants` rather than re-typed.
- [x] A missing or non-numeric `limit` now defaults to the full sweep size;
      `Number(undefined)` is `NaN`, and `Math.min(Math.max(NaN, 1), 100)` is
      `NaN`, which is not a limit.
- [x] Confirmed O(1): `runSweep()` calls `scanNetwork()` **once** and the
      per-contact work is a `Set.has` lookup, so 100 costs exactly what 10 did.

### TASK-902 — Expose `follow_up_days` in Settings *(done)*

`followUpDays` existed in `lib/settings.ts`, was never rendered in
`Settings.tsx`, and the server read its own `FOLLOW_UP_DAYS` env var regardless.
The side panel promised "a follow-up will be drafted in N days" using a number
that nothing enforced.

- [x] `<input type="number">` in the Settings tab, bounded by
      `MIN_FOLLOW_UP_DAYS` / `MAX_FOLLOW_UP_DAYS` and coerced through
      `clampFollowUpDays()` (shared, pure, tested).
- [x] `SyncObservationsRequest.followUpDays` carries it to the server, which
      passes it into `sweepStaleContacts(followUpDays)`.
- [x] `env.FOLLOW_UP_DAYS` **deleted** from `env.ts` and `server/.env`. One
      source of truth, not a fallback that can disagree with the panel.
- [x] `api.syncObservations()` attaches the setting itself, so none of the three
      call sites (alarm sweep, `OBSERVE_ACCEPTED`, `OBSERVE_REPLY`) can forget.
- [x] Every panel string that states a deadline reads `useFollowUpDays()`:
      `contactStateLine`, the Drafts empty state, and `SentCard`'s countdown.

**Done when:** setting 3 makes the Drafts tab count down from 3 *and* the server
sweeps at 3. — Covered by `test/follow-up-days.test.ts` (7 tests) over the clamp
and the wire contract.

### TASK-1004 — Rerank retrieved chunks *(done — was deferred)*

Deferred until the eval could show fusion was the ceiling. It did: across the
six labelled recipients the skills wall and the education block took **11 of 18
evidence slots**, ranked top-2 by *both legs of both lenses*, and the chunk that
is gold for two cases was never retrieved at all.

- [x] `src/rag/rerank.ts` grades each fused candidate 0/1/2 on whether it states
      something the candidate did that *this reader* would care about.
- [x] Reorder-and-drop only; fails open to the fused order; never returns empty.
- [x] Pure `applyGrades` / `parseGrades` split out and tested (11 tests).

**Measured 2026-09-28:** pipeline nDCG@3 0.482 → 0.710, MRR 0.417 → 0.667,
hit-rate 0.667 → 0.833, forbidden-chunk violations 4 → 1. These are the figures
*this task* moved; for the current pipeline see `docs/EVALUATION.md` §6.

### TASK-1007 — Pre-deployment RAG audit ✅ DONE

The system was audited against the standard pre-deployment RAG checklist. Four
of the seven items were not actually met, one was met, one was already correct,
and one was refused with a reason.

- [x] **Stale evidence description.** `execute_hybrid_search` still told the
      model its passages "came from three different searches… prefer (1)… fall
      back to (3)". Two of those three lenses no longer existed and the order is
      now rerank-grade order, not lens order — so the model was handed a false
      description of its own evidence on every draft. Now says "best-first",
      which is true and stays true if the lenses change again.
- [x] **Embedding consistency.** Migration `0007` records
      `resume_chunks.embedding_model`; `rag/embedding-guard.ts` +
      `retrieveLegs()` refuse a corpus embedded by any other model. Catches the
      same-width swap nothing else catches. 5 tests. → ADR-040.
- [x] **Production observability.** Migration `0008` `draft_runs` +
      `src/observability/`: evidence chunk ids, ungrounded figures, critique
      problems, repair passes, tokens and calls across the *whole* run, latency,
      and failures. 4 tests on the meter. → ADR-041.
- [x] **The eval is now a gate.** `src/eval/gates.ts` + `enforce()`; both
      runners exit non-zero. `pnpm verify` and `pnpm verify:release`.
      → ADR-043.
- [x] *Already met:* answers are grounded in retrieved context only, figures are
      checked against it (`critique.ts` + two lexicographic repair passes), and
      an empty retrieval produces an explicit no-evidence tool response rather
      than `hits: []`.
- [ ] *Refused:* a semantic cache. Near-identical queries for two different
      recipients **must** produce different drafts, and `eval:drafting` gates on
      exactly that. → ADR-042.
- [ ] *Reframed:* a 2 s P95. The drafting loop is 10–30 s and runs on a
      background alarm; the real SLO is "a draft is waiting when the panel
      opens". `draft_runs.latency_ms` makes that checkable rather than asserted.

### TASK-1008 — Robustness audit ✅ DONE

A full read of every source file. Seven leaks and lifecycle defects fixed
first, then six behaviour-changing corrections. Written up in `docs/MEMORY.md`
→ Known issues #2; only the parts a future reader could undo are listed here.
Migration 0009 is applied and verified against the live project.

- [x] **Resource and lifecycle.** The minimized sweep window leaked one per
      sweep when the tab had no id (`network-scan.ts` early return sat outside
      the `try/finally`); `QdrantStore.ready` cached a *rejected* promise, so
      one outage disabled the dense leg for the process lifetime;
      `indexResume` destroyed the old object, vectors and row **before**
      attempting the upload and embed.
- [x] **Unbounded waits.** `AbortSignal.timeout` on the Tavily call (6 s) and
      on every extension request (30 s; 120 s for `/drafts` and `/resumes`).
- [x] **`services/followup.ts`** compared PostgREST's timestamptz rendering
      against a JS ISO string **lexicographically**. Now compared as instants.
- [x] **`agent/draft.ts`** skipped a non-function tool call without emitting a
      `tool` message, which the API rejects on the following turn.
- [x] **`captureContact` no longer resets a known contact.** It was a blanket
      upsert: a second Connect click wrote `status: "Pending"`, a fresh
      `connected_at` and a recomputed `job_id`. It now fills blanks only, like
      `enrichContact`. An explicit `jobId` (the disambiguation toast) is the one
      thing that overrides stored state, and `candidateJobs` is narrowed to the
      linked job because the toast names `candidateJobs[0]`.
- [x] **`MAX_RESUME_BYTES` (10 MB)** in `@crm/shared/constants`, enforced in the
      zod contract and checked on `file.size` in `resume-capture.ts` *before*
      the bytes are read and base64-expanded into `chrome.storage.local`.
- [x] **`app.onError` no longer returns `err.message`.** It logs an 8-char
      reference beside the stack and returns only that reference.
- [x] **`env.ts` `.superRefine`** rejects `VECTOR_STORE=qdrant` with no
      `QDRANT_URL` at boot rather than at first retrieval.
- [x] **Migration `0009`** — `escape_like()` on both sides of
      `match_jobs_by_company`'s containment test, and a unique key on
      `resume_chunks(resume_id, chunk_index)` after a dedupe delete.
      `escapeLikePattern()` in `services/company-match.ts` is its TypeScript
      twin, used by `check_company_message_history` whose argument comes from
      the model. **Keep the two in step.**
- [x] **`PgVectorStore.upsertChunks`** is a real upsert on that key. It
      therefore **fails until `0009` is applied** — this is the one item here
      that is not yet in force.
- [ ] *Deferred:* `unwrap()` turns "row not found" into a 500 on every route
      (cosmetic, wide blast radius). `linkContactsForJob` (all contacts × all
      jobs per job write) and `sweepStaleContacts` (3 round trips per Accepted
      contact) are O(n) and only matter past a few hundred rows.

Not a defect despite appearances: `REMIT` in `agent/critique.ts` omits
`Founder_Executive`, `Engineering_Leader` and `Peer_Engineer` deliberately —
those recipients *can* answer a technical question. The `Partial<>` is the
signal.

### TASK-903 — Reply drafting *(the one real missing feature)*

`checkForReplies()` reports `{ linkedinUrl, replied: true }`. The **reply text
is never captured**, and `message_type` has no reply value. `docs/PRD.md` lists
this under Known gaps; do not let any doc or commit message imply it works.

- [ ] Migration `0012`: `alter type message_type add value 'reply'` — its own
      file, no other statements. (`0001`–`0011` are taken and all applied.)
- [ ] Scrape the thread body in `contents/linkedin-messaging.ts` and extend
      `ObserveReplyRequest` with the text.
- [ ] Store the inbound message so a draft can quote it.
- [ ] Agent work: a reply prompt is not the outreach prompt. It answers what
      they actually asked. New critique rules, with tests.
- [ ] A fourth Drafts section, or fold replies into "Needs your approval".

**Done when:** a reply arrives, its text is stored, and a grounded response is
waiting in the panel without the user asking for it.

### TASK-904 — Fix the stale README *(docs)* ✅ DONE

`README.md` claimed sweeps were "capped at 5 profiles per sweep, with 4–11 s
human-scale pauses between page visits" — the **abandoned profile-visiting
design**. Four other sections were stale too.

- [x] Rate limiting rewritten to match `background/network-scan.ts`, plus a
      fifth constraint: a contact's profile is never opened.
- [x] Setup lists **all five** migrations and says what breaks if 0003/0004/0005
      are skipped. It previously said "both migrations".
- [x] Drafting section: four tools, not three; three-lens retrieval; the
      critique pass. *(The lens count was corrected again later — TASK-1004
      deleted lens C, and TASK-910 rewrote what the remaining two ask.)*
- [x] Follow-ups section: automatic drafting on acceptance, and an explicit
      statement that reply drafting does not exist.
- [x] Development section: all three verification commands plus the zod bundle
      check; the test description now matches the actual suites.
- [x] A `docs/` table near the top; the README no longer restates architecture.

### TASK-905 — Repo hygiene *(chore)*

- [ ] Delete the stale `extension/build/chrome-mv3-dev` directory.
- [ ] Move or delete the loose PDFs in the repo root (`Profile.pdf`,
      `Profile (4).pdf`, `Arjun_Nair_Resume_ClearwaterLabs.pdf`,
      `1790349042597-Arjun_Nair_CV.pdf`).
- [ ] If git is initialised: `.gitignore` for `server/.env`, `build/`, `*.pdf`.

### TASK-906 — Swappable vector store, fusion in TypeScript *(done)*

- [x] Migration `0006`: `dense_search_resume_chunks` +
      `sparse_search_resume_chunks`, dropping `hybrid_search_resume_chunks`.
- [x] `rag/fuse.ts` — RRF extracted from SQL, pure and unit-tested.
- [x] `rag/store/` — `VectorStore` interface returning ranks not scores, with
      `PgVectorStore` (default) and `QdrantStore` implementations, selected by
      `VECTOR_STORE`.
- [x] `search.ts` and `index-resume.ts` rewired onto the store; the resume
      delete is now explicit, because nothing cascades into an external store.

### TASK-907 — Evaluation harness *(done)*

- [x] `src/eval/metrics.ts` — precision@k, recall@k, MRR, nDCG@k, hit rate.
      Pure, total, zero-not-NaN on empty inputs.
- [x] `src/eval/faithfulness.ts` — deterministic grader; no LLM judge.
- [x] `src/eval/dataset.ts` — marker-phrase labels resolved at run time,
      throwing on a stale marker.
- [x] `eval/fixtures/resume.txt` + `eval/retrieval-cases.ts` — six cases, each a
      failure this codebase actually shipped.
- [x] `eval:retrieval` scores dense, sparse and fused **separately**, and warns
      when the sparse leg hit nothing across every case.
- [x] `eval:drafting` scores faithfulness, critique pass rate and cross-recipient
      evidence overlap.
- [x] `docs/EVALUATION.md`.

### TASK-908 — First real outreach, and the four panel defects behind it *(done)*

Triggered by two messages actually sent to recruiters. Draft quality and the
reported UX bugs turned out to be one causal chain, not two lists.

Draft quality:

- [x] `agent/draft.ts` — `SYSTEM_PROMPT` no longer says "a software engineer".
      It says "a candidate", and forbids naming the field, discipline or
      seniority unless the job title or a retrieved chunk states it. The hardcode
      beat the evidence: an Oracle HCM consultant opened with "I'm currently
      exploring opportunities in software engineering".
- [x] `agent/draft.ts` RULE 4 — with **zero** retrieval, state no achievement,
      no metric and no number, and in particular do not describe experience that
      belongs to the recipient's own job.
- [x] `agent/critique.ts` — `ungroundedNumbers()` no longer exempts an empty
      corpus. That exemption switched the check off in the one case where every
      figure is guaranteed invented, and shipped "improved time-to-fill by 30%".
- [x] `test/faithfulness.test.ts` + `test/rag.test.ts` — the two tests that
      encoded the old exemption inverted, and each split so the "no *style*
      problem is invented" intent survives separately from the figure rule.
- [x] `agent/critique.ts` — `OUT_OF_REMIT` widened from exact nouns to stems.
      `implementations?` missed "implementing", so a recruiter was asked a
      delivery question.

Panel and capture:

- [x] `background/resume-stash.ts` — `rememberJobForTab()` also records
      `lastTrackedJob`, and `jobForTab()` falls back to it inside
      `HANDSHAKE_TTL_MS`. `claimResume` already had a most-recent fallback; the
      job side did not, and the asymmetry stranded every resume uploaded *after*
      pressing "I applied" — the normal order when the ATS asks for the file on
      a later step, or when Workday opens a second tab.
- [x] `background/poller.ts` — `sweepOnPanelOpen()`, throttled to one LinkedIn
      read per 10 minutes, honouring quiet hours and `pollingEnabled`, and
      calling `runSweep({ force: true })` so it does **not** re-arm the alarm
      (the panel remounts on every open; re-arming would starve the unattended
      sweep, the same defect `ensureSweepScheduled` exists to prevent).
- [x] `sidepanel/hooks.ts` — the panel sends `PANEL_OPENED` on mount and on
      `visibilitychange`. Reloading the panel only re-read the database, and the
      database knows nothing about an acceptance until a sweep has looked, so
      "Check now" was the only thing that moved it.
- [x] `sidepanel/tabs.tsx` — a search box on Applications (role, company,
      location) and on Contacts (name, headline, company, **and the linked
      job's** title and company). Substring, not fuzzy: a matcher loose enough
      to return "Verdant" for "next" returns four other things with it, which is
      worse than scrolling because it looks like an answer.
- [ ] Contact → job auto-link when the employer is unknown. **Not a code
      defect** — see `docs/MEMORY.md` → Known issues §3. The matcher is correct;
      the Sent-invitations page carries no employer, so there is nothing to
      match. Visiting the profile once enriches and links it. Harvesting
      profiles during a sweep would fix it and break PRD §6.

---

### TASK-909 — The recipient's whole profile, in retrieval and in the prompt *(done)*

A draft is meant to join three things: the JD, the tailored resume, and the
person. The third was a headline — a slogan, and often an empty one. ADR-044.

- [x] `supabase/migrations/0010_contact_profile_text.sql` — `contacts.profile_text`
      and `contacts.profile_read_at`. Applied and verified by a live enrich
      round-trip; without it every capture and enrich fails on an unknown column.
- [x] `packages/shared/src/profile-text.ts` — `dedupeAdjacent`, `capProfileText`,
      `condenseProfile`. Pure and shared, because the server re-caps whatever a
      content script hands it and DOM-walking code cannot be unit tested.
- [x] `packages/shared/src/api.ts` — `profileText` on `CaptureContactRequest` and
      `EnrichContactRequest`, bounded by `MAX_PROFILE_TEXT_CHARS`.
- [x] `extension/src/lib/scrapers/linkedin.ts` — `scrapeProfile()` now reads
      About, Experience and Skills, locating each section by its in-page nav
      anchor id (a URL contract) rather than by hashed class names, and derives a
      headline from the current role when the headline field is blank.
- [x] `extension/src/contents/linkedin-profile.ts` — `reportProfileDetails()`
      sends `profileText` on every `/in/` visit; `fromCard()` sends null, since
      reading the open page would attribute it to whoever's card was clicked.
- [x] `server/src/services/contacts.ts` — `profilePatch()`: overwrite on a
      *longer* read, re-cap server-side, stamp `profile_read_at`.
- [x] `server/src/rag/search.ts` — Lens A's dense query carries a 700-char
      excerpt; its sparse leg carries the profile's 30 most frequent content
      terms alongside the headline's.
- [x] `server/src/agent/tools.ts` + `draft.ts` — `ToolContext.recipientProfile`,
      forwarded to retrieval and quoted into the task prompt inside a fenced,
      REFERENCE-ONLY `<recipient_profile>` block.
- [x] `sidepanel/tabs.tsx` — a contact with no profile says so, and names the
      one click that fixes it.
- [x] `server/test/profile-text.test.ts` — 13 tests.

### TASK-910 — Every ranking signal was job-blind *(done)*

The role the user applied to reached `buildTaskPrompt` and nothing else. Both
dense queries, both sparse queries and the rerank rubric were all answering
"what is most impressive about this candidate?". ADR-045, ADR-046.

- [x] `server/src/rag/keywords.ts` — `extractTechKeywords` → `extractRoleKeywords`.
      Measured first: the old function returned `""` for the real 2,714-char
      Oracle Fusion HCM JD, because `TECH_VOCAB` was a closed backend-hiring
      allow-list. The allow-list is now a ×3 boost; a ~200-word `JD_BOILERPLATE`
      deny-list filters instead; title terms carry ×5; a plain body word must
      appear twice or it is prose.
- [x] `server/src/rag/lens-query.ts` — **new pure module.** `concernLensQuery`
      names the role inside Lens B's dense query. Separate file because
      `rag/search.ts` → `rag/embeddings.ts` builds the OpenAI client from `env`
      at import and throws, so nothing in that graph is unit-testable. Same
      precedent as `rag/embedding-guard.ts`.
- [x] `server/src/rag/rerank.ts` — `RerankTarget` gains `roleTitle` and
      `roleKeywords`; the rubric gains a domain test that decides grade 2 against
      grade 1, stated explicitly as *not* a test of impressiveness.
- [x] `server/src/rag/search.ts` — `roleTitle` param threaded to
      `extractRoleKeywords`, `concernLensQuery` and `rerankForRecipient`.
- [x] `server/src/agent/tools.ts` + `draft.ts` — `ToolContext.roleTitle`;
      the tool response now tells the model the ranking already accounts for the
      role, and that a metric from unrelated work reads as a mass mailing.
- [x] `server/src/agent/draft.ts` — `isOncePerContact()`. The reuse lookup
      filtered `.is("sent_at", null)`, so a **sent** introduction was invisible
      to it: Hassan Amr's initial outreach was created 08:51:06, sent 09:08:17,
      and written again at 10:48:47. `connection_note` and `initial_outreach`
      are now final per contact; `follow_up` stays repeatable.
- [x] `server/src/eval/run-retrieval.ts` + `eval/retrieval-cases.ts` — a
      `JOB_TITLE` constant, and `scoreLegs` calls `concernLensQuery` instead of
      holding a second copy of the string.
- [x] Tests — `extractRoleKeywords` 8 → 9, new `concernLensQuery` suite (3),
      new `isOncePerContact` suite (2). Suite total 162 / 32.
- [x] Verified by a read-only ablation against the live Oracle job and the
      recipient's real profile. Role withheld → rank 0 was a tooling inventory;
      role supplied → rank 0 was the PeopleSoft-to-Fusion migration mapping.

---

## Phase 10 — Open, found by the 2026-09-30 draft review

These came out of reading one real draft end to end. They are ordered by cause,
not by size: (1009) is upstream of (1010), and both are upstream of draft
quality. Full write-ups in `docs/MEMORY.md` → Known issues §4–§6.

### TASK-1009 — Section-aware chunking *(the root cause)* ✅ DONE

**Done 2026-10-01 → ADR-052.** `sectionHeader()` decides where a chunk starts; a
header is never emitted alone, is prefixed to every chunk cut below it, and
overlap is not carried across one. 7 new tests built from the real failing lines
(`ORACLE CORPORATION — Bengaluru, India` is a header; `AWS — migrated the fleet
to Graviton` is not). The eval fixture now yields **8 chunks, one per section**,
skills wall isolated and labelled, every retrieval marker still resolving.

`chunkResumeText` split on `/\r?\n/` (`rag/chunk.ts:18`), so a PDF's visual
line-wrap is a semantic boundary and section headers are invisible. Chunk 1 of
the Oracle resume holds three unrelated facts *plus* the CORE SKILLS wall, and
it is cited in **every** `draft_runs` row. Two consequences: adjacency reads as
causation (the agent wrote "implementing Payroll Definitions and Fast Formula,
along with a consistent client satisfaction score above 9.5/10", welding a
figure from a different project onto the Fusion work), and the reranker can no
longer score the skills wall 0 because grading is per chunk.

- [x] Split on section boundaries, not line breaks. A resume's section headers
      (`CORE SKILLS`, `EXPERIENCE`) are the real boundaries.
- [x] Never let a skills wall share a chunk with an achievement.
- [x] Extend chunk coverage: it tested size and overlap, and nothing tested that
      a chunk holds one idea.
- [ ] **Re-index every resume.** Nothing in the database has changed — existing
      `resume_chunks` were written by the old chunker, so until each resume is
      re-uploaded the live corpus is still the old one, and a draft produced from
      it is evidence about the old chunker. Chunk ids change, so `draft_runs`
      citations from before the change will not resolve — accepted.

### TASK-1010 — An attribution check, and a zero-evidence gate ✅ DONE

**Done 2026-10-01 → ADR-053, ADR-054.** `misattributedFigures()` asks which
passage each *sentence* is about and reports a figure that only occurs in other
passages, by an absolute margin of 2 distinctive words. The zero-evidence case is
deliberately **not** a critique problem — it is unsatisfiable, so it would burn
both repair passes and discard every candidate — it is `review.evidenceCount`,
persisted by migration 0012 and shown on the card.

`ungroundedNumbers` asked only whether a figure appears *somewhere* in the
retrieved text. It cannot ask whether the figure belongs to the claim the
sentence attaches it to, so the conjoined-attribution draft scored 0 critique
problems, 0 ungrounded figures and 0 repair passes. Separately, the 11:00:41 run
recorded `evidence_chunk_ids=[]` and also scored 0 problems — every check other
than `ungroundedNumbers` passes happily on a draft built from no evidence.

- [x] A check that a figure and the claim it is attached to come from the same
      chunk, not merely from the same result set.
- [x] A gate that marks a draft built from no evidence as such in the panel
      rather than presenting it as ready. It does **not** refuse to ship: a draft
      the user can read and reject beats no draft and no explanation.

### TASK-1011 — Retrieval for a contact with no linked application ✅ DONE

**Decided and done 2026-10-01 → ADR-056, migration 0013.** The carve-out is
taken: `jobId: null` means general networking and retrieves across the whole
corpus. The invariant stops leakage *between applications*, and there is no
application to leak into. `string | null` runs through `VectorStore`,
`retrieveLegs`, `hybridSearch` and `searchResumeForRecipient` so the carve-out is
visible in every signature. A `provenance` note tells the model the passages came
from resumes for other roles and forbids mentioning a role, a referral or a
resume. Migration number is **0013**, not 0012 as guessed below — 0012 went to
`messages.review`.

`agent/tools.ts` returned `{ hits: [] }` whenever `ctx.jobId` was null. Measured
live on 2026-10-01: **6 of 31 contacts (19%)** have no linked application, so
roughly one draft in five is written with zero evidence. This is the ordinary
case for a plain LinkedIn connection.

The invariant in `rag/store/types.ts:26` — "retrieval must never cross
applications" — forbids the obvious fix. Proposed carve-out, **not yet decided**:
permit cross-job retrieval only when `job_id IS NULL`, i.e. when there is no
application to stay inside. Costs a migration, because both RPCs take `job_id`
as a required argument.

- [x] Decide the carve-out before writing the migration.
- [ ] **A contact recovered from the Sent-invitations page still has no
      employer.** That is a capture gap, not a retrieval one, and this task does
      not close it. Remedy stays manual: visit the `/in/` profile once. Bulk
      profile fetches during a sweep would fix it and violate PRD §6.

### TASK-1012 — The vault filed every CV one application behind ✅ DONE

Found 2026-10-01 from two user reports: an application recorded under a posting
the user had only browsed, and an application the extension said it had captured
a resume for that showed none. Both were the same mechanism. Full causal chain,
with the live timeline and the proof from the stored PDFs' own text, in
**ADR-047**.

- [x] `@crm/shared/vault` — `documentRank`, `acceptsDelivery`, `DeliveryTarget`,
      `DELIVERY_WINDOW_MS` (10 min, was `HANDSHAKE_TTL_MS` at 2 h). Zod-free
      subpath, because `resume-stash.ts` is reachable from a content script.
- [x] `documentRank` — `\b` replaced with a filename-separator class. `\b` does
      not match across `_`, so `Arjun_CV.pdf` ranked as unrecognised and the
      cover-letter protection never fired for the names people actually use.
- [x] `resume-stash.ts` — `jobForTab(tabId, fileName)` takes the filename and
      defers to `acceptsDelivery`; new `markResumeDelivered(jobId, fileName)`
      records the rank on every binding for that job after a *successful*
      upload, so a rejected one leaves the job still able to accept.
- [x] `POST /resumes` — **409** when the job already holds a resume and
      `replace` is not set. `deliverResume` already re-stashes on failure, so a
      misrouted upload now reaches the application it belongs to by itself.
- [x] `indexResume` — timestamped storage key, and the old object removed last,
      after the replacement row is committed. The upload used to destroy the
      previous bytes in place, before anything else had succeeded.
- [x] `handshake.ts` — the cross-tab fallback requires a handshake under ten
      minutes old *and* that there be exactly one. Ambiguity returns null, which
      surfaces the manual "Track this application?" toast.
- [x] `linkedin-jobs.ts` — `refreshCache()` drops the cached posting when the
      requisition id on screen no longer matches it, instead of answering with
      the previously browsed job's company, title, URL and requisition id.
- [x] `ResumePicker` on the application card — attach or replace by hand. Needed
      because refusing bad deliveries otherwise makes a job holding the wrong CV
      permanently unrecoverable.
- [x] `server/test/vault-routing.test.ts` — 11 tests, including a replay of the
      21-minute gap that misfiled the Cedar Union CV onto the Trellis Digital job.

**Not covered by a test:** the handshake fallback rule. It lives in the
extension, which has no test runner; extracting it into `@crm/shared` purely to
reach one would put browser-tab logic in a package the server also imports.

### TASK-1013 — The follow-up engine fired once, and repeated itself when it did ✅ DONE

Found 2026-10-01 from a user report that a follow-up read worse than the opener
it was chasing. It did, and three further defects sat behind it. Evidence,
reasoning and the rejected alternatives in **ADR-048**.

- [x] `sweepStaleContacts` — `.in("status", ["Accepted", "Follow_Up_Required"])`.
      The old `.eq("status", "Accepted")` meant the sweep that found a contact
      was the last one that could ever see them: one attempt, and no retry if it
      failed. 3 of 4 stale contacts had been stranded without a draft since
      2026-09-24.
- [x] `MAX_FOLLOW_UPS_PER_CONTACT = 2`, counted from messages **sent**, not
      drafted. A recurring status needs a stop condition; a discarded draft is
      not a chase the recipient received.
- [x] `server/src/agent/thread.ts` — `priorThread` (sent only, oldest first) and
      `threadBlock` (dated, `sent_text` over `draft_text`, and the three
      repetition failure modes named). Its own file because `draft.ts` reaches
      `env` through `rag/embeddings` at import.
- [x] `draft.ts` — the thread is loaded unconditionally and rendered **above**
      the reflection section. It used to be reachable only through
      `check_company_message_history`, an optional tool scoped by company, which
      `draft_runs` shows the model never called on the offending message.
- [x] `follow_up` intent prompt rewritten — a nudge earns its place by carrying
      something the first message did not.
- [x] `DELETE /api/messages/:id` + a confirmed Discard button on `DraftCard`.
      Without it a rejected draft was undeletable *and* silently excluded that
      contact from every future sweep.
- [x] `linkedin-profile.ts` — bounded, throttled `MutationObserver` in place of
      three fixed timers, and a toast when a known contact's profile window
      expires with the server still holding no `profile_text`.
- [x] `server/test/thread.test.ts` — 7 tests replaying the real thread.

**Not covered by a test:** the observer itself, and the toast. Both are
extension-side DOM behaviour against a page that is not reproducible offline.
The pure half — what goes in the prompt — is what the tests pin.

---

### TASK-1014 — Seven drafts in nineteen seconds, and they still repeated themselves ✅ DONE

Found 2026-10-01 immediately after TASK-1013 shipped. Evidence and reasoning in
**ADR-049**.

- [x] `supabase/migrations/0011_one_unsent_draft_per_contact.sql` — partial
      unique index on `(contact_id, type) WHERE sent_at IS NULL`. The sweep's
      "don't stack drafts" guard was a read-then-write race; ~25 profile opens
      fired ~25 overlapping sweeps, each of which read "no draft exists".
- [x] `generateDraft` — an `inFlight` map keyed `contactId:type`, so a second
      request joins the first instead of running a second agent. The index
      stopped the duplicate *rows*; three full ReAct loops had already been paid
      for by then.
- [x] `generateDraft` — a `23505` on insert returns the draft that won the race
      rather than throwing. Losing is a normal outcome.
- [x] `critique.ts` `repeatsThread()` — repeated figure, repeated ask (≥50%
      content-word overlap), repeated claim (shared 3-content-word run). Wired
      into `critiqueDraft` so the repair pass acts on it. The role title is
      excluded from all three, or the critique becomes unsatisfiable.
- [x] `critique.ts` `GENERIC_ASK` + RULE 6 rewritten — the closing line must
      fail the "delete the name and company; does it still make sense?" test,
      and no question is explicitly better than a generic one.
      **`GENERIC_ASK` was wrong by construction and was deleted the same day —
      see TASK-1015.** RULE 6 stands; the enforcement does not.
- [x] `server/test/repetition.test.ts` — 10 tests, all replaying real messages.

**Not fixed by this task, because it is data:** Clearwater Labs has no resume, Daniel
F. has no linked application, and Vector AI is indexed on a **cover letter**
rather than a CV — which is where the 9.5/10 CSAT figure the user objected to
comes from. It is correctly grounded; the corpus is wrong. See `docs/MEMORY.md`
→ Known issues. *(Clearwater Labs and Vector AI were both repaired by the user on
2026-10-01 — real CVs, 14 and 15 chunks. Daniel R. is still unlinked. The 9.5/10
figure is in the real Vector AI CV too, so replacing the cover letter did not
remove it; it is grounded, and it is the wrong evidence for an AI PM role.)*

---

### TASK-1015 — The survey-question check taught the model to evade it ✅ DONE

Found 2026-10-01, in the first batch of follow-ups written **after** TASK-1014
shipped. Three of the four drafts defeated the checks added that morning.
Evidence and reasoning in **ADR-050**.

The mechanism is the part worth keeping: `repairDraft` ranks candidates by
`critiqueDraft().problems.length` and feeds the critique **text** back as the
repair instruction. A deny-list of surface phrasings is therefore a specification
of the cheapest edit that scores better. The 07:02 run spent two repair passes
turning "What qualities or experiences are you prioritizing in candidates for
this position?" into "What **specific** skills or experiences are you
prioritizing in candidates for this position?" and recorded
`critique_problems: 0`.

- [x] `GENERIC_ASK` (5 phrase regexes) **deleted**. Replaced by
      `ABSTRACT_SUBJECT` — the question is flagged when its subject is a
      category noun (`skills`, `challenges`, `insights`, `trends`, …) *and*
      nothing in it anchors to this recipient. Wording is irrelevant; shape is
      not.
- [x] `askAnchors(company, roleTitle, headline)` — the terms that make a
      question this person's. Category nouns are **filtered out of the anchor
      set**: Nikos Pallas's own headline reads "Recruitment Manager |
      Matching Skills to Opportunities | FinTech", so without that filter her
      tagline excuses "What specific skills are you prioritizing in
      candidates?" and the check goes silent on the draft it was written for.
      Caught before shipping only by re-running the probe against the real
      `contacts` row instead of an invented one.
- [x] `repeatsThread` — the repeated-ask test is now `shared >= 3 ||
      ratio >= 0.5`. Lena's reworded question measured 3 of 8 content words
      = 38%, under the ratio, and shipped. A ratio alone rewards padding and
      punishes brevity, which is backwards when the repair pass shortens the
      ask.
- [x] `repeatsThread` — the **company** joins the role title in the exclusion
      set. The draft is required to name both.
- [x] `contentWords` trims leading and trailing dots, so a sentence-final
      `team.` reaches the stopword set.
- [x] `critiqueDraft` context gained `company` and `anchors`; `draft.ts` and
      `repairDraft` pass them through.
- [x] 6 new tests in `server/test/repetition.test.ts` (197 / 40 green), each
      replaying a real 2026-10-01 draft.

**Verified by re-running the four real drafts through the real code**, before
and after: 0 problems on all four before; Nikos, Daniel and Lena caught
after, with a hand-written good control still passing clean. Omar's draft is
correctly *not* caught — "the AI systems" is anchored by his role title
`AI-LLM Systems Engineer`; his defect was an empty corpus, not the ask.

### TASK-1016 — A draft the critique still objects to ships silently ✅ DONE

Found 2026-10-01 while reading `draft_runs` for the batch above.
**Done 2026-10-01 → ADR-054, migration 0012.**

`repairDraft` runs at most `MAX_REPAIR_PASSES = 2` and then returns its best
candidate **whether or not problems remain**. Two of the drafts the user
approved and sent that morning recorded `critique_problems: 1` — Nikos's went
out ending "What qualities are you prioritizing in candidates for this role?"
after both passes were spent. The telemetry knew. The panel said nothing, so the
user approved a message the system itself had flagged.

Shipping anyway is the right default — a flawed draft the user can edit beats no
draft — but it must be **visible**.

- [x] Persist the surviving critique **on the message**, not only in telemetry:
      `messages.review jsonb` (0012), shared contract `DraftReview`, computed on
      the final text after shortening and figure repair.
- [x] Render it on `DraftCard` as the system's own reservations rather than an
      error. Three states — no evidence, surviving findings, clean — and the
      clean state is not silent, because silence is what shipped the 07:32 batch.
- [x] Pre-0012 messages say so explicitly instead of defaulting to "clean". A
      default of `{ problems: [] }` would be a lie told by a column definition.
- [x] Decide auto-approval: **unchanged.** Nothing is auto-sent — PRD §6 forbids
      clicking Send — so the only gate that exists is the user reading the card,
      and the card now tells them.

**Done when:** a draft with `critique_problems > 0` cannot reach the clipboard
without the user having been shown what the checker objected to. ✅

---

### TASK-1017 — The draft that passed every check and was still false ✅ DONE

Found 2026-10-03 by reading one live message end to end — the row, the contact,
the job, the retrieved chunks and the stored review. **Done 2026-10-03 →
ADR-058 … ADR-062, migration 0014.**

The message sent to Nadia Haddad, the Vantage Staffing recruiter who posted the ad,
recorded `problems: [], ungroundedFigures: [], repairPasses: 2`. It told her the
candidate had over five years of AI experience — he has five years of Oracle HCM
payroll work and about one of AI — in a sentence lifted almost whole from her own
advert, and credited a client-satisfaction score earned in go-live support to
"systems I built".

Every guard passed it and every guard was correct. The holes were in what no
guard was looking at. See `docs/MEMORY.md` → "The PROFESSIONAL SUMMARY chunk is a
grounding laundromat".

- [x] **`echoesJobDescription`** — compare the draft's claims against the advert
      with the trigram machinery `repeatsThread` already runs on prior messages.
      Excludes the role, the employer, anything the resume genuinely contains,
      and the closing question; reports **one** problem however many runs match,
      because `repairDraft` minimises problem count. ADR-058.
- [x] **`askAnchors(headline, { roleTitle, company })`** — the obliged words are
      *subtracted from the headline*, not merely withheld. The first attempt
      withheld them and changed nothing live, because her headline is "Recruiter
      @ Vantage Staffing UAE | …" and the employer came back through her own tagline.
      Both employer strings are subtracted; `ctx.company` and `job.company`
      differ on this row. The problem text was rewritten too — it used to advise
      naming the company, which is now exactly what does not anchor. ADR-059.
- [x] **`isSummaryChunk` / `summaryOnlyFigures`** — a figure whose only retrieved
      source is a summary section is surfaced to the reader and **not** given to
      the repair loop, which has the same evidence and could only delete it.
      ADR-060.
- [x] **Clean-state wording names the checks, not a verdict.** "Nothing left to
      fix" was a claim about the message that these checks cannot support.
      ADR-061.
- [x] **`draft_runs.repair_accepted`** (0014) — `repair_passes: 2,
      critique_problems: 0` could not distinguish "the loop cleaned it" from
      "both rewrites were discarded". ADR-062.
- [ ] **Re-upload the remaining thirteen resumes.** Deliberately excluded from
      this batch by the user; it is a manual data step, not code. Until it is
      done, `isSummaryChunk` returns `false` on those corpora and the new check
      has nothing to find there.

**Done when:** replaying the stored Nadia row through the current critique
returns the JD-echo problem, the abstract-question problem and
`summaryOnlyFigures: ['5', '9.5', '10']`, where the stored review returned
nothing. ✅ — verified by read-only replay against the live rows, 2026-10-03.

---

### TASK-1018 — Fourteen migrations that only a human could apply ✅ DONE

Found 2026-10-08 while working out whether a stranger could run this project.
They could not, without first executing fourteen SQL files in the right order
from prose instructions. **Done 2026-10-08 → ADR-063.**

The ritual had already failed three ways in this repository: `docs/MEMORY.md`
carried "0013 not applied" for days after it had been applied, and then cited
itself as evidence; `0001` has 26 DDL statements and 5 guards, so a second run
is not a no-op; and `docs/RULES.md`'s "never edit a migration that has been run"
was unenforceable, because nothing related the database's shape to the
repository's text.

- [x] **`src/migrate/plan.ts`** — the decision, pure: no database, no `env`, no
      network, for the ADR-040 reason. `checksum`, `parseVersion`,
      `stripSqlComments`, `requiresOwnTransaction`, `planMigrations`. 20 tests,
      three of them run against `supabase/migrations` itself rather than
      fixtures, because a fixture cannot catch a renumbering mistake in the
      directory the runner actually reads.
- [x] **`src/migrate/run.ts`** — the Postgres. `pg_advisory_lock`, so two
      containers starting together cannot both run `0001`; the
      `schema_migrations` ledger; transactional execution for most files and
      bare execution for the ones Postgres refuses to wrap, recorded only on
      success so a half-applied one stops the next run.
- [x] **`DATABASE_URL` is read only here**, never in `src/env.ts`. It is a
      superuser password needed for two seconds of DDL; a long-running HTTP
      server has no business holding it for hours.
- [x] **Three refusals, each a stop rather than a guess** — two files sharing a
      version, a ledger row with no file on disk, a checksum that no longer
      matches.
- [x] **`--baseline`** for the one database that predates the ledger. Refuses
      unless `resume_chunks` already exists, so it cannot write "fully migrated"
      across an empty schema.

**Done when:** `pnpm --filter @crm/server migrate` on a fresh project builds the
whole schema with no human reading a migration list, and a second run prints
"Database is up to date." ✅ 2026-10-08 — baselined against the live project (14
rows, versions 1–14), second run clean. The append-only guard was then proved
*live*, not only in the unit test: 0014 was edited, `migrate` refused it by name
with a non-zero exit, and the file was restored and re-hashed identical. Its
SHA-256 matches the checksum the ledger had already stored, which is independent
confirmation that the stored value is real.

---

### TASK-1019 — One image, so the install is not "have the right Node" ✅ DONE

2026-10-08. `Dockerfile`, `.dockerignore`, `docker-compose.yml`.

- [x] **The bind address, which is the part that would have silently broken.**
      `index.ts` bound `127.0.0.1` literally, for the good reason recorded in
      `docs/SECURITY.md`. Inside a container that is the *container's* loopback,
      and Docker forwards a published port to the bridge address — so the
      server would have started, logged, passed its own health check and
      refused every request from the host. `HOST` now defaults to `127.0.0.1`
      and the container sets `0.0.0.0`, with the loopback guarantee moved to the
      `127.0.0.1:8787:8787` publish address. **Both directions verified against
      the running server**, not reasoned about: with the default, the machine's
      LAN address refuses the connection; with the override, it answers 200.
- [x] **`migrate` is a separate service that must exit 0 before `server`
      starts**, and is the only one given `DATABASE_URL` — the ADR-063 property,
      now enforced by the compose file rather than by intention. Variables are
      listed one by one for that reason; an `env_file:` would hand the
      long-running server a superuser password.
- [x] **The install filter is checked, not assumed**: `pnpm --filter
      "@crm/server..."` resolves to `@crm/server` + `@crm/shared` and nothing
      else, so the Plasmo toolchain — most of the tree, and native — stays out
      of the image.
- [x] **Run end to end, 2026-10-08** (Docker 29.8.2, Compose v5.5.1). The image
      builds in ~24 s; `corepack enable` pulls pnpm 10.33.4 from the
      `packageManager` field, `node:22-slim` resolves `pdfjs-dist` with no
      native build tools, the layer order holds. `migrate` printed "Database is
      up to date." and exited 0; `server` then started; `curl localhost:8787
      /health` → `{"ok":true}`; `docker compose ps` → `Up (healthy)`, so the
      fetch-based healthcheck works too. The LAN address still refuses and
      `/api/jobs` without a token is still 401 — containerising did not cost
      either guarantee.
- [x] **`DATABASE_URL` must be the session pooler under Docker**, and the first
      run proved why: `migrate` died with `getaddrinfo ENOTFOUND
      db.<ref>.supabase.co`, which reads like a typo. `db.<ref>.supabase.co` has
      an AAAA record and no A record, and Docker's Linux VM has no global IPv6
      address, so `net.connect`'s `ADDRCONFIG` resolution discards the only
      record and returns nothing. Confirmed inside the image: a plain
      `dns.lookup` returns the v6 address, the same lookup with
      `hints: dns.ADDRCONFIG` returns ENOTFOUND. The session pooler is IPv4 and
      free; Supabase's IPv4 add-on is paid and would become a prerequisite for
      every reader of the README, so it is not the answer. Written into
      `server/.env.example` and the README.
- [x] **`--env-file` is needed on every compose subcommand, not just `up`** —
      Compose interpolates before it does anything, so `ps` fails with five
      "required variable is missing a value" errors and no hint that a flag is
      missing. The README's follow-up commands omitted it; fixed.

**Done when:** ~~`docker compose --env-file server/.env up` answers `/health` and
`docker compose logs migrate` shows "Database is up to date."~~ Both observed
2026-10-08. Remaining gap, deliberately not claimed: this was run on a machine
that *does* have Node, so "works with no Node installed" is inferred from the
image carrying its own runtime rather than demonstrated on a clean host.

### TASK-1020 — Publish the image and the extension, so installing needs no toolchain ✅ DONE

2026-10-08, **v1.0.0**. `.github/workflows/release.yml`, `docker-compose.yml`,
`docker-compose.build.yml`, `CHANGELOG.md`, README → Install / Updating.

TASK-1019 removed "have the right Node" from *running the server* but not from
*getting the extension*: the install still said clone, `pnpm install`,
`pnpm build`. A `build:` key in the compose file also meant a first-time user
compiled the whole dependency tree, because **Compose prefers building over
pulling whenever both are present** — the opposite of what a published image is
for.

- [x] **A `v*` tag publishes both halves.** The workflow re-runs `pnpm verify`
      against the *tagged* commit — a tag can point at a commit no branch ever
      built, so trusting the earlier CI run is trusting a different tree — then
      buildx-pushes `linux/amd64` + `linux/arm64` to GHCR and `gh release
      create`s with the built extension zip. `permissions: {packages: write,
      contents: write}`; the repo's own `GITHUB_TOKEN` suffices, no PAT.
- [x] **The version lives in three places and the workflow fails on
      disagreement** — the tag, `package.json`, `extension/package.json`. The
      server and the extension always share one version; they are two halves of
      one private protocol, and versioning them separately only creates a
      compatibility matrix nobody maintains.
- [x] **`docker-compose.yml` carries no `build:` key.** Building is opt-in via
      `docker-compose.build.yml`, which also retags to `jobsearchcrm:local` so a
      hand-built image cannot squat the name everyone's `pull` resolves.
      `CRM_IMAGE` overrides for pinning or a fork.
- [x] **The documented command is `up -d --wait`.** Plain `up -d` returns ~8 s
      before the server is listening; Docker's published port accepts the
      connection and closes it, so the race reads as `curl: (52) Empty reply
      from server` — a crash. `--wait` blocks on the Dockerfile `HEALTHCHECK`
      (measured 7.9 s, then the curl succeeds first try). Found on the first
      real install from the published image, because the README had the two
      commands on adjacent lines.
- [x] **GHCR creates packages PRIVATE even from a public repo**, and nothing
      says so: every `docker compose pull` fails with an auth error that never
      mentions visibility. Flipped once by hand (Package settings → Danger Zone
      → Change visibility), then **proved** public by fetching the OCI manifest
      with an *anonymous* ghcr.io token — both architectures present, arm64
      selected natively on Apple Silicon with no emulation.
- [x] **No auto-update, on purpose** — ADR candidate, and the one place the
      popular answer is wrong. An image-watcher such as Watchtower restarts
      `server` without knowing `migrate` exists, so the first release carrying a
      migration runs new code against an old schema, and `recordDraftRun`
      swallows unknown-column errors by design, so it fails *silently*. It also
      wants the Docker socket (root-equivalent) in a project whose whole story
      is "keys never leave loopback". Updating is `docker compose pull && up -d
      --wait`, the only path that re-runs `migrate` first. An unpacked extension
      cannot auto-update at all — Chrome does that only for Web Store installs,
      and the Reload click is the price of staying off the store.

**Done when:** ~~a user with neither Node nor pnpm can install both halves.~~
Observed 2026-10-08: `pull` fetched the published image, `migrate` exited 0,
`server` came up `Up (healthy)`, `/health` → `{"ok":true}`, `/api/jobs` → 401,
and the release carries `job-search-crm-extension-v1.0.0.zip` (121 KB). Same
caveat as TASK-1019: verified on a machine that has Node, so "no toolchain
needed" rests on the image carrying its own runtime and the zip being prebuilt,
not on a clean-host run.

---

## Phase 11 — Deferred, deliberately

Not bugs. Recorded so they are not "discovered" again and built by accident.

- [ ] **TASK-1001** Per-contact follow-up cadence (currently one global N).
- [ ] **TASK-1002** Retry/backoff on OpenAI 429s. Single-user, low volume — the
      failure is visible and manual retry is fine.
- [ ] **TASK-1003** A settings toggle for the drafting model. One call site; an
      env var is enough.
- [ ] **TASK-1005** A *cross-encoder* reranker, replacing the LLM one in
      `rag/rerank.ts`. Would remove an API call and make retrieval fully
      deterministic — `gpt-4o-mini` at temperature 0 still returns different
      grades across runs, which is noise the eval cannot distinguish from a
      regression. Costs a ~400 MB ONNX model inside a single-user local proxy,
      which is why it is not the default. Revisit if rerank latency or run-to-run
      variance becomes the thing blocking a decision.
- [x] **TASK-1006** Deterministic figure repair — **done 2026-10-01 → ADR-055**,
      promoted out of "deferred" because the deferral reasoning was wrong: three
      instruction-shaped attempts had already failed, and rounding is the one
      hallucination whose correct answer is sitting in the evidence.
      `repairFigures()` substitutes the exact grounded figure under four guards
      (magnitude, direction, single candidate, years excluded), runs on every
      repair candidate and once more after `shortenToLimit`. 8 tests.
      **Re-measured 2026-10-03:** `eval:drafting` run against the live project
      with 0012–0014 applied — numeric faithfulness **0.833 → 1.000**, clean
      drafts 6/6, evidence overlap 0.480, all four gates pass. Six cases, so this
      is a cleared gate and not a proven property.
      **`eval:retrieval` re-run 2026-10-08:** hit-rate **0.833 → 1.000**, nDCG@3
      0.710 → 0.732, MRR 0.667 → 0.639, forbidden chunks 1/6 unchanged, all four
      gates pass. Both halves now describe the current pipeline. The MRR drop is
      below the documented ±1-rank reranker wobble and is **not** being claimed
      as a trade until a second run agrees — `docs/EVALUATION.md` §6.

**Out of scope permanently** — see `docs/PRD.md` → Out of scope. Multi-user
auth, hosted deployment, private LinkedIn APIs, mass outreach sequences, and
anything that clicks Send.
