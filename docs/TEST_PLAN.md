# Test Plan

What "working" means. A feature is not done because it compiles and not done
because a draft appeared — it is done when the checks below pass.

## The three commands

Run all three after every change. They are also in `docs/RULES.md`.

```bash
pnpm -r typecheck
pnpm --filter @crm/server test
pnpm --filter @crm/extension build
```

Or, as one command that stops at the first failure:

```bash
pnpm verify
```

Plus the bundle check, because a content script that carries zod is a
regression a build will happily ship:

```bash
cd extension/build/chrome-mv3-prod && grep -c zod *.js ; true
```

Every count must be `0`. (`grep` exits 1 on zero matches, which breaks an `&&`
chain — hence the `; true`.)

---

## Automated tests

`server/test/*.test.ts`, `node:test`, **260 tests across 52 suites**. Everything
tested is pure: arguments in, value out, no database, no network, no `env`.

| Suite | Tests | Guards against |
| --- | --- | --- |
| `critiqueDraft` | 15 | Banned phrases, exclamation marks, >1 question, missing first-name opener, unnamed role, ungrounded numbers, out-of-remit asks; and that the role check does **not** demand the team qualifier after the comma, which made it unsatisfiable inside 300 characters |
| `personaFromHeadline` | 5 | "VP of Engineering" → `Engineering_Leader` not `Founder_Executive`; "HR Coordinator" → `Technical_Recruiter`; contentless headline → `null` |
| `canonicalResumeName` | 4 | Missing `userName` degrades to `Company_Role.pdf`, never to the original filename |
| `chunkResumeText` | 9 | Target size, overlap, no chunk lost at the boundary — and now that a chunk holds **one idea**: the real `ORACLE CORPORATION` / `CORE SKILLS` failure, where the skills wall shared a chunk with an achievement and was then cited in every `draft_runs` row; that every chunk is labelled with the section it came from; that overlap is not carried across a section boundary |
| `sectionHeader` | 4 | Both halves of the rule, each from a real resume line. A shouted employer line (`ORACLE CORPORATION — Bengaluru, India`) is a header; a bullet with the same dash (`AWS — migrated the fleet to Graviton`) and a mixed-case role line are not; a trailing colon is stripped; the comma-heavy skills wall itself is never mistaken for the heading above it |
| `misattributedFigures` | 4 | The failure every other grounding check passed: 840,000 from the startup chunk welded onto the Kafka work, asserting a causal link the resume never made. Plus the three cases it must **not** fire on — every figure owned by the passage described, a sentence drawing on both passages about equally (firing there would make the critique unsatisfiable, ADR-050), and a single chunk, where there is no other work to have taken the figure from |
| `repairFigures` | 8 | The 0.833 faithfulness failure: `over 32,000` → `32,330`, hedge consumed. Then the four guards, each a real way this goes wrong — 840,000 written as "nearly 1 million" is a rewrite, not a rounding; `2020` passes every rounding test against the resume's `2021` and must not be touched; `90` is a plausible rounding of both `96` and `99` and the chunk contains both, so nothing happens; an exact quotation and an empty corpus are left alone |
| `looksLikeJobTitle` | 5 | The three strings that reached the live `jobs` table — two × "Share negative feedback", one "Remote" — and why the rules are **exact matches**: "Remote Data Entry Administrator" is somebody's job and a prefix rule would refuse it. Blank and null are "nothing was read", not a title |
| `extractRoleKeywords` | 9 | Keyword extraction from a real job description, **including a non-software posting** — the closed `TECH_VOCAB` allow-list returned `""` for a 2,714-char Oracle Fusion HCM JD; title terms outrank body terms; a word the posting used once is dropped as prose |
| `concernLensQuery` | 3 | The role applied to is named in Lens B; the query still varies by recipient (so this is not the deleted JD lens); no role degrades cleanly rather than interpolating `null` |
| `toOrQuery` | 5 | ` or ` join, dedupe, strips `"()` and a leading `-` |
| `normalizeCompany` | 2 | Suffix and punctuation stripping |
| `companiesMatch` | 3 | Containment, and the 3-char floor so "AI"/"Co" cannot wildcard |
| `companyFromHeadline` | 3 | "Engineer at Stripe" → `Stripe` |
| `polling cadence` | 2 | `nextPollDelayMinutes` inside 30–90; `isQuietHours` across midnight |
| `fuseRrf` | 7 | A chunk both legs agree on beats a single strong hit; a single-leg chunk survives (the SQL was a full outer join); per-leg ranks reported; ties broken by index |
| `fuseLenses` | 5 | One vote per lens, not per leg; `LENS_RRF_K = 1` keeps rank meaningful across six-element lists where k=60 degenerates into counting appearances; ties broken by `chunk_index` |
| `applyGrades` | 6 | A zero-graded chunk that fusion ranked first is dropped; ties fall back to the fused order, not the model's; **all-zero falls back rather than returning an empty context**; fewer than the limit rather than padding with rejects |
| `parseGrades` | 5 | A malformed or out-of-range grade row is ignored, not trusted; a hallucinated id cannot shift the meaning of a real one; a bad response throws so the caller can fail open |
| `draftPredatesProfile` | 6 | A draft written before the profile was read is superseded; **instants are compared, not wall-clock text** — PostgREST renders `timestamptz` in the connection's offset, and the same string-compare bug already shipped once in `services/followup.ts`; never-read and unparseable both keep the waiting draft rather than burning an agent run |
| `repeatsThread` | 6 | A replay of the real openers and the follow-ups that repeated them: the same question reworded ("aligned with the specific needs of government clients" → "tailored to meet the unique needs of government clients"), reused evidence when the question *was* new, a figure already sent; and the two things it must **not** flag — naming the role the opener named (RULE 2 requires it; flagging it makes the critique unsatisfiable) and a follow-up that genuinely brings new evidence |
| `critiqueDraft` — closing question | 12 | The six survey closers that actually shipped, each askable of anyone alive; reported once rather than once per overlapping pattern; a question anchored to the recipient passes, and so does a message with no question at all. Then the four that prove the check is **structural, not lexical** (ADR-050): one adjective inserted between "what" and the noun does not defeat it — that single edit is how the repair pass escaped and recorded 0 problems; a survey question beginning "are there…" is caught although no phrase pattern ever began with "are"; a category noun in the **recipient's own headline** cannot anchor the ask — Nikos Pallas's headline contains "Skills", which would have silenced the check on the exact draft it was written for; and a question naming something only this recipient has passes clean. Finally the four from the live Nadia Haddad row (ADR-059): the **employer** cannot anchor a survey question and neither can the **role title**, because RULE 2 puts both in every opening message; the obliged words must be *subtracted from the headline* rather than merely withheld, since hers reads "Recruiter @ Vantage Staffing UAE | …" and the first attempt at the fix changed nothing live; and a non-category word she put in her own headline ("sourcing") still anchors |
| `repeatsThread` — the 07:02 follow-ups | 2 | A reworded question sharing only 3 of 8 content words with the original — under the 50% ratio the check first shipped with, so it went out; and that naming the **employer** is compliance rather than repetition, for the same reason as the role title |
| `echoesJobDescription` | 7 | The live 2026-10-03 draft that read Vantage Staffing's own advert back to the recruiter who posted it — "3-5 years of experience developing and deploying AI … solutions in production environments" returned as "over 5 years of experience developing and deploying AI solutions in production environments", with every existing guard recording 0 problems. Reports **one** problem however many runs matched, because `repairDraft` ranks by problem count and three fragments of one sentence would let a clause deletion outscore a real rewrite. Then the four it must **not** fire on: a phrase the resume genuinely contains (the ad and the CV both say "retrieval augmented generation" because that is what the work is called); the role and the employer, which RULE 2 requires; the closing question, where quoting the advert is RULE 6 compliance; and two texts that merely share a subject. No job description means no opinion |
| `isSummaryChunk` | 3 | The headers a summary is written under; a section that records *work* is not one; and a chunk indexed before headers existed gets **no opinion rather than a wrong one** — thirteen of sixteen resumes are still old line-break chunks |
| `summaryOnlyFigures` | 4 | The live case: `9.5/10` sits in the PROFESSIONAL SUMMARY and nowhere else retrieved, so nothing in the evidence says it was earned by explaining PeopleCode in go-live support rather than by the systems the draft credited it to — chunk 17 was not returned. Goes quiet once that chunk *is* retrieved, and has no opinion at all when no summary chunk was |
| `priorThread` | 2 | An unsent draft is excluded — the recipient never saw it, so it cannot be something to avoid repeating; oldest first regardless of row order |
| `threadBlock` | 5 | A replay of the 2026-10-01 thread, where a six-day-late follow-up repeated its own opener because `buildTaskPrompt` never carried the conversation: `sent_text` wins over `draft_text` (what was read, not what was proposed), each message is dated so staleness is visible, nothing sent renders as `null` rather than an empty thread, and all three repetition modes — opening line, achievement or figure, same question reworded — are named |
| `isOncePerContact` | 2 | An introduction is final (`connection_note`, `initial_outreach`); `follow_up` stays repeatable, being the one type whose purpose is to be sent again |
| `clampFollowUpDays` + `SyncObservationsRequest.followUpDays` | 7 | Non-numeric and zero fall back to the default; bounds clamped at both ends; the wire contract defaults when absent and rejects 0, negatives, fractions and >90 |
| `evaluateRanking` / `aggregate` | 13 | Zero rather than NaN on an empty gold set or empty result; recall counted against the gold set not `k`; nDCG sees ordering that precision cannot; averaging per query, not pooled |
| `scoreFaithfulness` | 9 | "over 30,000" caught against `32,330`; thousands separators ignored; a figure-free draft scores 1 not 0; a question about the recipient is not scored as unsupported |
| `embeddingMismatch` | 5 | The same-width swap nothing else catches (`ada-002` is also 1536, so `vector(1536)` accepts it and cosine keeps returning numbers); a half-re-indexed corpus split across two models; an empty corpus is **not** a mismatch, because "no resume indexed" is a handled state; the message names the way out |
| `escapeLikePattern` / `migration 0009` | 9 | `%`, `_` and `\` in a company name are literals, not wildcards — `100% Remote` matched all seven jobs; the TS helper and the SQL `escape_like()` are asserted to agree, because they are two copies of one rule |
| `dedupeAdjacent` / `capProfileText` / `condenseProfile` | 10 | LinkedIn renders every profile line twice (visible + screen-reader); the cap cuts on a boundary, not mid-word; a profile that is all whitespace condenses to null rather than to `""` |
| `CaptureContactRequest.profileText` | 3 | `MAX_PROFILE_TEXT_CHARS` enforced on the wire, so an oversized scrape is rejected at the contract rather than at the column |
| `UploadResumeRequest.fileBase64` | 5 | `MAX_RESUME_BYTES` enforced in the contract, stated as base64's 4-per-3 expansion of the byte limit |
| `documentRank` | 4 | A resume outranks a cover letter and an unrecognised name sits between them; **underscore-separated names are read** — `\b` does not match across `_`, so `Arjun_CV.pdf` scored as unrecognised and the protection never fired for the names people actually use; `precvetkov.pdf` is not a CV |
| `acceptsDelivery` | 6 | A replay of 2026-10-01: a CV picked 21 minutes after the *previous* application was tracked is refused, where the old two-hour window accepted it and filed three consecutive CVs one application behind; a job accepts one document; a resume still displaces a cover letter already filed; the window boundary is exact |
| `UploadResumeRequest.replace` | 2 | Replacement is absent by default, so the server refuses to overwrite a resume that cannot be recovered |
| `UsageMeter` | 4 | A call the API returned no `usage` for still increments `calls`, so an under-reported run shows as a visible discrepancy rather than a silent shortfall; a missing field does not zero the running total |
| The labelled eval set | 9 | Every marker still resolves against the live chunker; no chunk labelled both relevant and forbidden; the skills wall is in no gold set; a stale marker throws |
| `parseVersion` | 3 | `0008` parses as 8, not 0 — the missing-radix bug; a name that does not lead with digits is not a migration, so `rollback_0009.sql` is skipped rather than ordered |
| `stripSqlComments` | 3 | A `--` inside a string literal is data: `escape_like()` in `0009` is built from literals, and treating their contents as a comment silently truncates the statement. Doubled quotes end nothing |
| `requiresOwnTransaction` | 4 | Both statements Postgres refuses inside a transaction block; and the real case for stripping comments — `0003` and `0004` carry header comments *explaining* that `alter type … add value` cannot run in one, so a detector reading raw text flags every file that documents the hazard |
| `planMigrations` | 7 | Numeric ordering, not lexicographic (`100_x.sql` before `0009`); applied files skipped; and the three states where the database and the repository disagree, each of which throws rather than guessing — two files sharing a version, a ledger row with no file on disk, and a file edited after being applied. That last one is `RULES.md`'s append-only rule, which until now nothing could check |
| The real migrations directory | 3 | Run against `supabase/migrations` itself, not fixtures: `0003` and `0004` are detected as non-transactional and `0001` is not. A fixture cannot catch a renumbering mistake in the directory the runner actually reads |

### Rules for adding tests

- **A test must encode the real failure, not a synthetic one.** The suite quotes
  actual bad drafts that shipped. Keep doing that.
- Every new critique rule, persona rule and parsing helper gets a test.
- Never weaken an assertion to make a test pass.

### What is deliberately not unit-tested

Anything that needs Postgres, OpenAI or a live DOM: the RPCs, the agent loop,
the scrapers, the routes. They are covered by the eval runners below and by the
manual checklists. Do not mock a database to manufacture coverage.

---

## Evals

The unit suite cannot see retrieval quality, because retrieval quality is not a
property of any one pure function. That gap is covered by two runners against a
committed fixture resume and six labelled cases:

```bash
pnpm --filter @crm/server eval:retrieval   # per-leg precision/recall/MRR/nDCG
pnpm --filter @crm/server eval:drafting    # faithfulness + evidence overlap

pnpm verify:release                        # verify + both evals, in order
```

**Both now exit non-zero when a floor in `src/eval/gates.ts` is breached.** They
used to print "FAIL" and return success, which meant the one defect the persona
pipeline exists to prevent — two recipients getting a byte-identical draft —
could ship past the script written to catch it. The floors are set *below* the
recorded baseline on purpose: the reranker is an LLM call, so ±1 rank of wobble
between identical runs is noise, and a gate that fires on noise gets bypassed.
Never lower a floor to make a run pass (ADR-043).

`verify:release` is a **release** gate, not a per-change one. The evals cost
real OpenAI credit and touch the live project; run `pnpm verify` per change and
`pnpm verify:release` before loading the extension for real use or keeping any
retrieval/prompt change.

Both seed and tear down a throwaway job in the configured Supabase project, so
do not run them against a database you care about. Run `eval:retrieval` after
**any** change to `rag/search.ts`, `rag/fuse.ts`, `rag/rerank.ts`,
`rag/keywords.ts`, `PERSONA_CONCERNS`, the chunker, or the vector store — it is
the only check that can see a retrieval leg die.

`eval:retrieval` is **no longer fully deterministic**, because the pipeline now
ends in a `gpt-4o-mini` call. A ±1 rank difference between runs is noise. Do not
chase one. → TASK-1005.

Run `eval:drafting` as well after any change to the lenses or to fusion: it is
the only measurement that compares recipients to each other, and cross-recipient
sameness is invisible to `eval:retrieval` (EVALUATION.md §4).

What a bad number means, and why there is deliberately no LLM judge:
[EVALUATION.md](EVALUATION.md).

---

## Manual checklist — Feature 1, application tracking

- [ ] **Easy Apply.** Apply to a LinkedIn Easy Apply job. Without typing
      anything, the job appears in the Jobs tab with company, title, location,
      URL and the full description text.
- [ ] **External ATS.** Open a LinkedIn posting, click Apply, complete the
      application on the company's own site. The job is tracked **with the
      LinkedIn job description**, not an empty one.
- [ ] **Handshake TTL.** Start an external application, wander off for >2 h,
      then submit. It is not tracked, and nothing invents a record.
- [ ] **Undetectable ATS.** On a site where submit cannot be detected, the side
      panel offers "I applied" and confirming it files the job.
- [ ] **Dedupe.** Applying to the same posting twice produces one job row.
- [ ] **SPA navigation.** Navigate from the feed to a job post by clicking, not
      by reloading. The extension still works. (This is the failure mode a
      narrow content-script match list causes, and it looks like the extension
      being dead.)

## Manual checklist — Feature 2, Document Vault

- [ ] Attach a resume, submit, then open the Vault. The file is listed as
      `Arjun_Nair_Stripe_Backend_Engineer.pdf`.
- [ ] Download it. It lands in Downloads **under that name**, not under a
      timestamp-prefixed one.
- [ ] Clear `userName` in Settings and file another application. The name
      degrades to `Stripe_Backend_Engineer.pdf` — never to the original
      filename.
- [ ] **Cover letter after CV.** Attach the CV, then a cover letter, then
      submit. The filed document is the CV.
- [ ] **Unrecognised name.** Attach `Arjun_Nair.pdf` alone. It is still
      filed; an unrecognised name is not a discard.
- [ ] **Re-upload.** Upload a different resume for the same job. The old object
      is gone from Storage and the old chunks are gone from
      `resume_chunks` — a draft must never be able to cite a resume that was
      not sent.
- [ ] **Unparseable PDF.** Upload an image-only scan. The panel shows a 422
      error **next to the upload control**, not in an `alert()` and not only in
      the console.

## Manual checklist — Feature 3, entity mapping

- [ ] **Apply then connect.** Apply to Stripe, then connect with someone at
      Stripe. The contact shows as linked to that application.
- [ ] **Connect then apply.** Connect with someone at Stripe first, then apply.
      The contact links **retroactively**. This is the normal order and it was
      broken for a long time.
- [ ] **Ambiguity.** Two applications at one company, then connect with someone
      there. A toast asks which one. It does **not** auto-dismiss.
- [ ] **No match.** Connect with someone at a company you never applied to. The
      contact is created as general networking, with no error.
- [ ] **Enrichment.** Connect from a card that renders no headline, then visit
      that person's profile. The headline and company fill in, and their status
      is **unchanged** — an Accepted contact must not fall back to Pending.
- [ ] **Unknown profile.** Visit a stranger's profile. **No CRM record is
      created.** Looking at someone is not a relationship.

## Manual checklist — Feature 4, drafting

This is the feature most likely to pass a smoke test and still be broken.

- [ ] **The persona test.** Generate a draft for a CTO, a technical recruiter
      and a support coordinator **at the same company, on the same
      application**. Read all three side by side. If any two would work
      interchangeably, the feature has failed even though every sentence is
      true.
- [ ] **Named role.** Each draft names the role applied to, with the title's
      distinctive words adjacent and in order.
- [ ] **One grounded fact.** Each draft contains exactly one concrete fact from
      the resume.
- [ ] **Every number is real.** Take every figure in the draft and find it in
      the retrieved chunks. "Over 30,000" for 32,330 is a failure — the
      recipient can hold the message next to the resume attached to the same
      application.
- [ ] **Answerable question.** Exactly one question, and one the recipient's job
      makes answerable. A recruiter cannot answer an inference-latency question.
- [ ] **Zero-hit behaviour.** Draft for a contact whose application has no
      indexed resume. The model must **not** fill the silence with invented
      enthusiasm.
- [ ] **Character limits.** connection_note ≤ 280, initial_outreach ≤ 600,
      follow_up ≤ 400, and truncation lands on a word boundary.
- [ ] **Insert, never send.** "Insert into LinkedIn" fills the composer and
      outlines LinkedIn's Send button. Watch the network tab: nothing is sent.
- [ ] **Idempotence.** Press the draft button twice. One draft, not two.

## Manual checklist — Feature 5, follow-up engine

- [ ] **Acceptance without a profile visit.** Have an invitation accepted, then
      press **Check now**. The contact moves Waiting → Connected. Open
      LinkedIn's "Who viewed your profile" as that person: your visit is not
      there.
- [ ] **A draft is waiting.** On acceptance a draft exists **without the user
      asking for it**.
- [ ] **The engine runs when nothing is pending.** Accept every outstanding
      invitation so the Pending list is empty, then trigger a sweep. The
      stale-contact sweep must still run — this is exactly when it used to
      switch itself off (ADR-014).
- [ ] **Follow-up after N days.** Back-date a `sent_at` by
      `followUpDays + 1` and sweep. The contact becomes `Follow_Up_Required`
      **and a follow-up draft is written**, and the panel redraws — the sweep's
      transitions never increment `updated`.
- [ ] **No duplicate follow-up.** Sweep again. No second follow-up.
- [ ] **The countdown is not a lie.** Set "Days of silence before a follow-up"
      to `2` in Settings. The Drafts tab's *Sent · waiting for a reply* card
      must count down from 2, **and** a contact silent for 3 days must actually
      become `Follow_Up_Required` on the next sweep. Before TASK-902 the panel
      rendered the setting and the server ignored it, so the first half of this
      check passed while the second failed silently.
- [ ] **A stale worker is caught, not absorbed.** After changing the setting,
      reload the unpacked extension. `followUpDays` travels on the
      `POST /sync/observations` body; an old worker bundle omits it and zod
      fills in 5, which looks like the setting being ignored again.
- [ ] **Withdrawn invitation.** Withdraw a sent invitation. The contact is
      dropped from observations, not reported `accepted: false`.
- [ ] **Broken scrape.** Sign out of LinkedIn, press **Check now**. The panel
      says *"Could not read LinkedIn. Make sure you are signed in."* — **not**
      "checked 4, no change". This is the worst failure mode in the codebase.
- [ ] **Quiet hours.** At 23:00 the alarm does not sweep, but **Check now**
      (`force: true`) still does.
- [ ] **Jitter.** Consecutive scheduled sweeps are 30–90 min apart and not a
      fixed interval.
- [ ] **Missed invitations.** Send an invitation outside the extension. A sweep
      creates the contact, capped at 20 new per sweep.

## Manual checklist — side panel

- [ ] **No screen goes silent.** Visit all five tabs with an empty database.
      Every one says what will make content appear, naming the event.
- [ ] **Mark as sent.** Approve a draft, mark it sent. It **stays on screen**
      under "Sent · waiting for a reply" with the countdown visible. The page
      does not go blank.
- [ ] **Counts including zero.** The Contacts filter pills show `Waiting 0`
      rather than hiding the pill.
- [ ] **User's words.** No tab renders `Follow_Up_Required` or `Pending` as
      prose. Badges may carry the enum text; sentences must not.
- [ ] **State sentences.** Every contact card has a sentence ending in either a
      fact about the other person or the next thing the system will do.
- [ ] **Three async states.** Every button: idle → disabled with a
      present-participle label (`Drafting…`, `Checking…`) → resolved.
- [ ] **Errors in place.** Stop the server and press every button. Each error
      renders next to the control that failed. No `alert()`, nothing
      console-only.
- [ ] **First run.** With no token configured, the panel opens on Settings and
      says why.
- [ ] **Width.** Drag the panel to 320 px and to 500 px. Nothing overflows;
      every long name truncates; every button row wraps.
- [ ] **Dark mode.** Switch the OS theme. Both the panel and an injected toast
      follow it.
- [ ] **Keyboard.** Tab through every control. They are real `<button>` and
      `<select>` elements and each is reachable.

## Manual checklist — security

Full list in `docs/SECURITY.md`. The ones to actually perform:

- [ ] `grep -r "sk-\|service_role" extension/build` finds nothing.
- [ ] A request to `/api/jobs` with no `x-crm-token` returns 401.
- [ ] A request with a wrong-length token returns 401 and does not leak timing.
- [ ] A request from a disallowed origin is rejected by CORS.
- [ ] A malformed body returns 400 with a zod error, not a 500.
- [ ] The Supabase anon key, used directly against the REST API, can read
      nothing from any of the five tables.
- [ ] A resume signed URL stops working after 60 s.
- [ ] No token, key or resume body appears in any server log line.

---

## Before calling a change done

1. The three commands pass, plus the zod bundle check.
2. The manual checklist for the feature you touched passes.
3. If you added a critique rule, persona rule or parsing helper, there is a new
   test and it encodes the **real** failure.
4. `docs/MEMORY.md` reflects the new state, and `docs/TASKS.md` has the box
   ticked.
