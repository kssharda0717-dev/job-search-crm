# Development Rules

The rulebook for anyone — human or AI — changing this codebase.

Rules marked **[HARD]** are non-negotiable and come from the PRD's constraints.
Breaking one is grounds for reverting the change, not for a discussion.

## General

- **TypeScript everywhere.** No `.js` source files. No `any` — use `unknown`
  and narrow.
- **Read before you write.** Do not propose a change to a file you have not
  read. Do not add a helper before grepping for one that exists.
- **Do not duplicate logic.** `companiesMatch`, `personaFromHeadline`,
  `critiqueDraft`, `toOrQuery`, `relativeTime` each exist once. Import them.
- **Do not modify unrelated files.** A bug fix does not come with a refactor of
  the surrounding code, a new abstraction, or reformatting.
- **Keep functions small and named for what they decide**, not for how they do
  it (`contactStateLine`, `ungroundedNumbers`, `looksLikeApplyFlow`).
- **Comments explain *why*, never *what*.** This codebase's comments record the
  failure that motivated the code — "the button's name is often just its
  visible text, so submitting an Easy Apply recorded nothing." Preserve that
  style. Do not add a comment that restates the line below it.
- **Delete rather than deprecate.** No `_unused` renames, no re-exported dead
  types, no `// removed` markers. This is not a published library.

## Before coding

1. Read `docs/PRD.md` for what the feature is supposed to do, and
   `docs/DECISIONS.md` for whether the approach you are about to take was
   already tried and rejected.
2. Read `docs/MEMORY.md` for current state and known issues.
3. Inspect the existing implementation. Most features already have a partial
   one.
4. For anything touching retrieval or drafting, read
   `docs/ARCHITECTURE.md` → "Drafting a message" first.
5. Write a plan for anything spanning more than two files.

## Architecture

- **Routes parse and delegate.** No business logic in `server/src/routes.ts`.
- **Nothing outside `server/src` imports `env.ts`** — it throws at import time
  and would make pure modules untestable.
- **Content scripts never call `fetch` against the proxy.** They send runtime
  messages; only `background/` imports `lib/api.ts`. **[HARD]**
- **MV3-durable state goes in `chrome.storage.local`**, never a module-level
  variable. The worker dies after ~30 s idle.
- **Any write that could change a company relationship must reconcile it.**
  `POST /jobs`, `PATCH /jobs/:id`, `POST /contacts/capture`,
  `POST /contacts/enrich`.
- **Link a contact to a job only on a *single* match.** Never guess between two
  applications at one employer.

## Imports and bundling

- In extension code, import shared values from **`@crm/shared/constants`**, not
  `@crm/shared`. The barrel pulls in zod; the subpath is runtime-import-free.
- Types may be imported from `@crm/shared` anywhere — `import type` is erased.
- **Verify after every extension build** that no content-script bundle contains
  zod:

  ```bash
  cd extension/build/chrome-mv3-prod && grep -c zod *.js ; true
  ```

  Every count must be `0`.

## UI

- Follow `docs/DESIGN.md`. Import from `sidepanel/components.tsx`; do not
  re-implement a Card, Button, Badge or Empty.
- **No screen may go silent.** Every state says what is happening and what
  happens next. An `Empty` must name the event that will fill it.
- **Use the user's words, not the enum's.** "Waiting", not "Pending".
- Every async action has idle / in-flight / resolved states. In-flight disables
  the control and uses a present-participle label.
- Errors render next to the thing that failed, never in `alert()` and never
  only in the console.
- Truncate every user-supplied single-line string; `flex-wrap` every button row.
- Design for a 360 px column.

## RAG and drafting

- **Never steer retrieval with the job description alone.** That is the defect
  the persona lenses exist to fix — a support lead and a CTO would get the same
  three bullets.
- **Always pass sparse keywords through `toOrQuery()`.**
  `websearch_to_tsquery` ANDs bare words, so a space-joined keyword list
  matches nothing and the search is silently dense-only.
- **Persona `terms` must be verbs a resume uses about work done**, never the
  nouns a skills list is made of. A noun list retrieves the skills block.
- **A rule the model must follow is enforced in `critique.ts`, not only in the
  prompt.** The prompt already banned "passionate about"; the model wrote it
  anyway.
- **Before adding a critique rule, ask "what is the cheapest edit that gets
  past it?" If the answer is a reword, the rule is wrong.** `repairDraft` ranks
  candidates by problem count and feeds the critique text back as the repair
  instruction, so a deny-list of phrasings is a training signal for evading
  itself: "What qualities are you prioritizing?" came back as "What **specific**
  skills…" after two repair passes, and the run recorded 0 problems. Check the
  *shape* of the thing — an abstract subject with no anchor to this recipient —
  not the words it is made of. ADR-050.
- **Anything the draft is required to say must be excluded from every
  similarity check — and from every check that counts it as *evidence of effort*
  too.** RULE 2 demands the role title, so `repeatsThread` and
  `echoesJobDescription` exclude the role and the company. The same words were
  also *anchoring* the survey-question check, which switched it off for every
  opening message there is: "What specific challenges do you see for this role
  at Vantage Staffing?" recorded 0 problems because "Vantage Staffing" was in it. A critique
  that cannot be satisfied burns both repair passes and discards every rewrite;
  a critique satisfied by compliance never fires at all. ADR-059.
- **Subtract the obliged words wherever they appear, not just where you pass
  them in.** Withholding the company from the anchor *list* changed nothing on
  the live row, because a LinkedIn headline usually leads with the employer and
  it came back as a headline word. Verify the fix on the row that motivated it.
- **A check that can only compare the draft to one chunk is not a grounding
  check.** `misattributedFigures` compares across chunks, so a sentence
  assembled from a single chunk is unfalsifiable by it — and the
  PROFESSIONAL SUMMARY, which ranks first in retrieval, is exactly the chunk
  where every figure sits beside every skill with the work that earned them
  stripped out. ADR-060.
- **Compare the draft against the job advert, not only against the resume.** The
  JD is in the prompt as material, and material in a prompt is what a model
  reaches for when it has nothing better to say. The recipient frequently posted
  that ad. ADR-058.
- **The repair loop and the reader get different findings.** Give the loop only
  what it has the evidence to fix. A figure that cannot be attributed from the
  retrieved chunks can only be *deleted* by a repair pass, and RULE 4 requires a
  concrete fact — handing both instructions to one loop is how a critique
  becomes unsatisfiable. ADR-060.
- **A reviewer must name the checks it ran, never deliver a verdict.** "Nothing
  left to fix" is a claim about the message that a figure-and-phrasing
  comparison cannot support. One draft passed every check while re-tagging five
  years of payroll work as five years of AI. A reviewer that overstates its
  remit is worse than none, because the user stops reading it. ADR-061.
- **Prefer an absolute count to a ratio when the repair pass shortens text.**
  The repeated-ask check measured overlap as a fraction of the new question, so
  padding passed and brevity failed — backwards, since repair makes the ask
  shorter. Three shared distinctive words is a shared subject at any length.
- **Never let a figure into a draft that is not in the retrieved evidence.**
  The recipient can hold the message next to the resume attached to the same
  application. Rounding is the realistic failure mode.
- **"The number is in the evidence" is not grounding.** Ask whether it belongs
  to the claim it is attached to. A real CSAT figure welded onto an unrelated
  rollout passed every check in the system and asserted a causal link the resume
  never made. ADR-053.
- **Fix a hallucination deterministically when the right answer is already in
  the evidence.** Rounding is the case: three instruction-shaped attempts (the
  prompt, a critique rule, two repair passes) failed against `gpt-4o-mini`, and
  arithmetic settled it. If a step can be computed, do not ask a model for it.
  ADR-055.
- **A chunk must hold one idea, and carry the section it came from.** Both the
  reranker and the attribution check grade per chunk, so a chunk that is half
  skills wall and half achievement has no score that is not wrong about part of
  it. ADR-052.
- **Zero retrieval hits is a loud instruction**, not a bare `hits: []`. The
  model fills silence with invented enthusiasm.
- **A check that cannot be satisfied belongs on the record, not in the
  critique.** "Nothing here is supported" is true and unfixable when retrieval
  returned nothing, so as a critique problem it would burn both repair passes
  and discard every rewrite. It is persisted on the message and shown to the
  user instead. ADR-053, ADR-054.
- **Never default a review column to "clean".** A pre-migration row has no
  review; saying it has an empty one is a lie told by a column definition. Say
  "nothing checked this" in the UI. ADR-054.
- Re-indexing a resume must delete the previous chunks.
- **Changing the chunker changes nothing already in the database.** Re-upload
  every resume, confirm one new row by reading it, and do not present a draft
  produced before re-indexing as evidence the change worked.

## Scraping LinkedIn

- **No private LinkedIn APIs.** `document.querySelector` against rendered DOM
  only. **[HARD]**
- **Match what a control *says*, not an `aria-label` LinkedIn may drop.** Three
  separate controls have already broken that way, each time silently.
- **A field the scraper can get wrong is validated on the server too, and the
  rule lives in `@crm/shared`.** The extension has no test runner, so a rule that
  lives only there cannot be tested; and `POST /jobs` is also called by the
  manual flow and the ATS scrapers. Three live rows were filed under "Share
  negative feedback" and "Remote" — a button and a filter pill — and a title
  steers `extractRoleKeywords`, the concern lens and the rerank rubric. Reject
  with a 400 naming the string; a field the server drops silently is how one of
  those rows was written. ADR-057.
- **Never open a contact's profile to check on them.** A profile view is
  reported to that person. Read the user's own Sent-invitations and Connections
  pages instead. **[HARD]**
- **Never dispatch a click on LinkedIn's Send button.** Inject text into the
  composer and outline the native button; the human clicks it. **[HARD]**
- Background sweeps stay jittered 30–90 minutes and paused 22:00–07:00.
  **[HARD]**
- Content-script matches should be **broad**, not a list of specific paths.
  Chrome only injects on a real navigation and LinkedIn is a SPA, so a narrow
  match list loses every route reached by client-side navigation — and it fails
  by doing nothing, which is indistinguishable from the extension being broken.

## Security

- **Never put a provider key in the extension.** The proxy holds
  `OPENAI_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY`; the extension holds only
  `CRM_AUTH_TOKEN`. **[HARD]**
- Never log a token, a key or a full resume body.
- Validate every request body with a zod schema at the route boundary.
- Keep RLS enabled with no policies. The proxy's service role bypasses it; a
  leaked anon key must grant nothing.
- Never put personal data in a URL or query string.
- See `docs/SECURITY.md` for the full list.

## Testing

- Anything worth testing must be **pure**: arguments in, value out, no
  database, no network, no `env`.
- Add a test for every new critique rule, persona rule, and parsing helper.
- A test must encode the **real failure**, not a synthetic one. The suite
  quotes actual bad drafts that shipped; keep doing that.
- Run the full suite after every change:

  ```bash
  pnpm verify   # = typecheck + server tests + extension build
  ```

- Fix failing tests before continuing. Never weaken an assertion to make one
  pass.
- **After touching retrieval, run the eval.** `rag/search.ts`, `rag/fuse.ts`,
  `rag/rerank.ts`, `rag/keywords.ts`, `rag/chunk.ts`, `PERSONA_CONCERNS` and
  anything under `rag/store/` are all covered by
  `pnpm --filter @crm/server eval:retrieval`. The unit suite cannot see a
  retrieval leg die; that is the whole reason the harness exists. Read
  `docs/EVALUATION.md` first.
- **Before a release, `pnpm verify:release`.** That adds both evals, which now
  set a non-zero exit code when a floor in `src/eval/gates.ts` is breached. They
  cost real OpenAI credit and touch the live project, so they are a release gate
  rather than a per-change one.
- Never tune a metric to make a number look better, and **never lower a floor in
  `gates.ts` to make a run pass**. If a case fails, either the retrieval is wrong
  or the label is wrong — decide which, and say so.

## Migrations

- Migrations are **append-only**. Never edit a migration that has been run.
  `schema_migrations` stores a SHA-256 of each applied file, so this is now
  enforced rather than merely written down: the next `migrate` run refuses
  outright. Restore the file and put the change in a new migration (ADR-063).
- **Nobody applies migrations by hand.** `pnpm --filter @crm/server migrate`
  reads the ledger and applies what is missing. Adding a file *is* the whole
  deployment step.
- `alter type … add value` needs **its own file** — it cannot run inside a
  transaction alongside other statements. That is why `0003` and `0004` each
  add exactly one persona. The runner detects this from the SQL
  (`requiresOwnTransaction`, comments stripped) and runs such files outside a
  transaction, recording them only on success — so a half-applied one stops the
  next run instead of being stepped over.
- `create or replace function` requires the whole body restated. When changing
  one line of a search function, copy the previous version verbatim and say in
  the header comment which line changed and why (see `0005`).
- Number files sequentially: `NNNN_snake_case_description.sql`.
- A migration that drops a function the running server calls is a breaking
  change. Say so in the README and in `docs/MEMORY.md` → Manual steps. `0006`
  drops `hybrid_search_resume_chunks`; skipping it breaks every draft.

## Git

- This directory is **not currently a git repository.** If one is initialised,
  the rules below apply.
- Small commits, one concern each.
- Messages describe *why*, not *what changed*.
- Never commit `server/.env`, a resume PDF, or anything under `build/`.
- Never `--no-verify`.

## Working with an AI agent on this codebase

- Give it the failing output, not a paraphrase.
- Require it to read the file before editing it.
- Require the three verification commands at the end of every change.
- Reject "improvements" that were not asked for — extra config options,
  defensive branches for impossible states, abstractions over one call site.
- If it claims a feature works, ask which file implements it. Reply drafting
  does not exist (`docs/PRD.md` → Known gaps) and has been claimed before.
