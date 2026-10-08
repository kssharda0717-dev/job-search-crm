# Evaluation

How this system is measured, why each metric exists, and what a bad number
means. Read this before changing anything under `server/src/rag/` or
`server/src/agent/`.

---

## 1. Why there is an eval at all

Retrieval fails silently. That is the whole argument.

Two failures shipped in this codebase and neither was visible from the output:

1. **The sparse leg was dead.** `websearch_to_tsquery` ANDs bare words, so a
   space-joined keyword list matched no chunk. Hybrid search ran as dense-only
   on every draft ever generated. The drafts still read fine.
2. **The skills wall outranked every achievement bullet.** `ts_rank_cd` without
   the length-normalisation flag rewarded the longest chunk, and the longest
   chunk was a 600-character comma-separated technology list containing no
   system, no number and no decision. The drafts said "I have experience with".

In both cases the fused output looked reasonable, a human skim said "yes, that's
resume text", and the actual defect was invisible for weeks. A number that goes
down when the leg dies is the only thing that catches this.

## 2. What is measured

| Runner | Command | Cost | Deterministic |
|---|---|---|---|
| Retrieval | `pnpm --filter @crm/server eval:retrieval` | ~20 embedding calls | Yes, modulo the embedding API |
| Drafting | `pnpm --filter @crm/server eval:drafting` | 6 agent loops (~30 model calls) | No — the model is at temp 0.7 |

Both seed a throwaway job + resume from `server/eval/fixtures/resume.txt`, run,
and tear it down in a `finally`. They write to the real Supabase project, so do
not run them against a database you care about.

### Retrieval metrics (`src/eval/metrics.ts`, pure, unit-tested)

| Metric | What it answers | Why it is here |
|---|---|---|
| precision@k | Of the k chunks returned, how many were right | An irrelevant chunk in the context window is a chunk the draft can be *built* from. This matters more here than in a search product, where the user just scrolls past a bad result. |
| recall@k | Of everything right, how much made the top k | Catches evidence that exists in the resume and is unreachable — the HCM payroll case. |
| MRR | 1/rank of the first correct hit, averaged | Only three chunks reach the model, and the reranker keeps fused order within a grade, so a right answer at rank 5 is a right answer nobody reads. |
| nDCG@k | Rank-discounted, normalised against the best possible ordering | The only metric that can see "right answer, wrong order". Precision cannot. |
| hit rate | Fraction of cases that found anything at all | A zero here is a different diagnosis from a low score: it is usually a dead leg, not a bad ranking. |

`k = 3`, because that is what the shipped pipeline asks for per lens. A larger k
would flatter the retriever by containing the whole fixture.

Aggregation is a **mean of per-query scores**, never a pool of all hits. A case
with six relevant chunks would otherwise drown out a case with two, and the case
with two is the one the persona lenses exist to serve.

### Per-leg scoring

`eval:retrieval` scores **dense alone, sparse alone, and their fusion**, on the
same query, before scoring the full pipeline (two lenses, cross-lens RRF, then
the reranker). This is the reason `VectorStore` exposes `denseSearch` and
`sparseSearch` separately instead of one `search`, and the reason RRF moved out
of SQL into `src/rag/fuse.ts`.

A single fused score cannot distinguish:

- fusion is weighted wrongly, from
- one leg returned nothing.

Those have opposite fixes. The runner also prints an explicit warning when the
sparse leg hit nothing across every case, because that is failure (1) above
reappearing.

The `full` row also prints `returned=[...]`, the chunk indices the pipeline
actually handed the agent. A row saying `forbidden=1` without naming the chunk
tells you a rule was broken and nothing about which one, so anyone reading a red
line has to write a throwaway diagnostic script — which is how the reranker came
to exist. With the indices printed it took one run to see that chunk 5
(education) appeared in 6/6 results and chunk 0 (the skills wall) in 5/6 — 11 of
18 evidence slots — while chunk 1 (Kafka/idempotency), gold for two cases, was
retrieved zero times.

### Drafting metrics (`src/eval/faithfulness.ts`, pure, unit-tested)

| Metric | What it answers |
|---|---|
| faithfulness (numeric) | 1 − (figures in the draft that appear in no retrieved chunk ÷ figures in the draft) |
| faithfulness (lexical) | Fraction of the draft's distinctive claim vocabulary present in the evidence |
| critique pass rate | How many final drafts leave `critiqueDraft` with zero problems |
| evidence overlap | Mean Jaccard overlap of the retrieved chunk sets across every pair of recipients |

**Numeric faithfulness is the one that matters.** The recipient can hold the
message next to the resume attached to the same application. The realistic
failure is not invention, it is rounding: a model asked for a short message
turns `32,330` into "over 30,000". A draft with no figures scores 1, not 0 —
scoring an empty numerator as 0 would push the model towards inventing numbers
to raise its score.

Lexical support is a weak proxy (paraphrase scores badly, a generic sentence
scores well) and is reported *beside* numeric rather than averaged into it, so
it is always visible which of the two moved. Only the sender's own claim
sentences are scored; a question about the recipient's work is not supposed to
be supported by the sender's resume.

**Evidence overlap is the PRD anti-criterion as a number.** 1.0 means every
recipient was pitched from the same chunks, and personalisation is decoration.
0.0 is not the target either — the two engineering cases *should* share the
Kafka work. What this catches is the number drifting back towards 1 after a
change to fusion or to the lenses.

## 3. Why there is no LLM judge

Ragas, DeepEval and LangSmith-style judges were considered and rejected here.

- A judge graded by the same model family that wrote the draft agrees with its
  own hallucinations. The failure mode it is least able to see is the one it
  produces.
- It costs a model call per case, so nobody runs it on every change, so it stops
  being a regression test.
- It is non-reproducible. A regression and run-to-run noise look identical,
  which makes the number unusable for exactly the decision it was built for.

The two things measured instead are the two that can be checked **exactly**, and
one of them is a failure that actually shipped. A deterministic grader that
catches one real bug beats a probabilistic one that produces a number.

### This is not contradicted by the LLM reranker

`rag/rerank.ts` calls `gpt-4o-mini` to grade candidate chunks, which looks like
the thing this section rejects. It is the opposite thing.

**A model inside the system under test is fine. A model in the ruler is not.**
The reranker is a retrieval stage; the eval measures its output against
hand-written labels and will report a fall in nDCG if it makes retrieval worse.
An LLM judge *is* the measurement, so when it drifts nothing reports it. Every
objection in the list above applies to the judge and none applies to the
reranker: the reranker is paid for once per draft in a flow that already makes
several model calls, and its mistakes are caught by a deterministic number
rather than hidden behind one.

The one real cost is honest and recorded below: **`eval:retrieval` is no longer
fully deterministic.** `gpt-4o-mini` at temperature 0 is not a guarantee, and
successive runs return slightly different grades. A ±1 rank wobble in the `full`
row is noise, not a regression. This is a genuine regression in the eval's
value, and the reason TASK-1005 (a local cross-encoder, which would be
deterministic and remove the API call) stays open rather than being closed as
"solved by the LLM reranker".

## 4. The labelled set

`server/eval/retrieval-cases.ts` — six cases, one per recipient shape. Every one
is a failure this codebase actually shipped, not a synthetic one. Each carries a
`rationale` that is printed on failure, so a red line explains itself.

The job description is **held constant across all cases on purpose**. If the JD
varied, a rise in score could be explained by the job description alone — and
"the JD is doing all the work" is precisely the defect the persona lenses were
introduced to fix.

**This constant has a cost, and it hid a bug for a while.** Because every case
shares one JD, a retrieval stage keyed on the JD alone returns a byte-identical
ranking for all six cases — which `eval:retrieval` cannot penalise, since it
scores each case independently and never compares two cases to each other. The
deleted third lens was exactly that, and it survived several eval runs looking
harmless. The metric that sees this failure is `eval:drafting`'s **evidence
overlap**, which is the only number here computed *across* cases. Read the two
runners together or a cross-recipient sameness bug is invisible.

### Labels are marker phrases, not chunk indices

`relevantMarkers` are distinctive strings resolved to chunk indices at run time
by `resolveCase()`. Indices are a function of `CHUNK_TARGET_CHARS`, so
hardcoding them would silently invalidate the whole set the first time anyone
tuned the chunker — which is exactly the change the set exists to measure. Chunk
ids are worse: they are generated per insert and a committed fixture cannot name
them.

A marker matching nothing **throws** rather than being skipped. A zero that
means "the label is stale" is indistinguishable from a zero that means "the
search is broken".

### `forbiddenMarkers`

Recorded separately from "not relevant", because these are the known
*attractors*. Five of the six cases forbid the skills wall. A metric that only
counted hits would not have caught the migration-0005 failure at all.

### The fixture is built to contain the trap

`server/eval/fixtures/resume.txt` has a ~600-character SKILLS wall that matches
almost any keyword query and says nothing. It is not padding; a fixture without
it cannot reproduce the bug the eval set exists for.

`test/dataset.test.ts` runs with no database and asserts the fixture still
chunks the way the labels assume — including that no chunk is labelled both
relevant and forbidden. That test already caught one bad label: a chunk boundary
put "Kafka consumer group" in the same chunk as the skills wall, which made the
`peer-engineer` case unpassable by construction.

## 5. Reading a report

```
vector store: pgvector
k = 3, rrf_k = 60, cases = 6

=== per-leg means ===
  dense only   P@3=... R@3=... MRR=... nDCG@3=... hit-rate=...
  sparse only  ...
  fused (RRF)  ...

=== full pipeline (two lenses, RRF-fused) ===
  peer-engineer  (Peer_Engineer)
    gold: [1, 3]  forbidden: [0]
    dense  ...
    sparse ...
    fused  ...
    full   ...  returned=[1, 3, 2]
```

- **Store name first.** Switching `VECTOR_STORE` moves where vectors live but
  does not migrate the corpus; a store nobody re-indexed into answers every
  query with nothing, silently.
- **`fused` below both legs** means fusion is broken, not retrieval.
- **`sparse` at zero hit-rate** means the sparse leg is dead. Check `toOrQuery`.
- **`full` below `fused`** means the reranker is hurting. Check first whether it
  fell back — `rerank.ts` logs `[rerank] falling back to fused order` and then
  returns the fused ranking untouched, so a fallback should show `full` equal to
  `fused`, not below it.
- **The same chunk index in `returned=` for every case** is the cross-recipient
  sameness failure. Confirm it against `eval:drafting`'s evidence overlap before
  acting; `eval:retrieval` alone cannot see it (§4).
- **`peer-engineer` passing while the others fall** is expected when the sparse
  leg dies — "Kafka" and "idempotency" are lexical matches dense retrieval also
  finds. Never read that case alone.
- **`engineering-leader` no better than the rest** means the persona lens is
  contributing nothing; it is the one case where the job description and the
  persona concerns should broadly agree.
- **`founder` failing** means the job-description keywords are dominating
  fusion. The seed-stage evidence is the part of the resume furthest from the
  JD.

## 6. Recorded results

Run against the live Supabase project on 2026-09-28. "Before" is the three-lens
`interleave` pipeline with no reranker; "after" is two lenses, cross-lens RRF at
k = 1, and the LLM reranker.

| | before | after | 2026-10-08 |
|---|---|---|---|
| `eval:retrieval` pipeline nDCG@3 | 0.544 | 0.710 | **0.732** |
| `eval:retrieval` pipeline MRR | 0.500 | 0.667 | **0.639** |
| `eval:retrieval` pipeline hit-rate | 0.667 | 0.833 | **1.000** |
| forbidden-chunk violations | 5 / 6 | 1 / 6 | **1 / 6** |
| `eval:drafting` numeric faithfulness | 1.000 | 0.833 | **1.000** |
| `eval:drafting` clean drafts | 6 / 6 | 5 / 6 | **6 / 6** |
| `eval:drafting` evidence overlap | 0.527 | 0.507 | **0.480** |

The 2026-10-08 column closes the staleness noted below: the retrieval half had
not been re-run since TASK-910 changed the pipeline under it.

Three of these need reading carefully rather than quoting.

**Numeric faithfulness fell, and the reranker did not cause it.** The model
renders the fixture's `32,330` as "over 32,000". That figure is now *reachable*
— before the reranker the chunk containing it was largely crowded out by the
skills wall, and a draft with no figures scores 1.0 by construction (§2). The
old 1.000 was partly the score of having nothing to be unfaithful about. The
rounding is a real defect and is TASK-1006; it is not a regression introduced
here.

**Evidence overlap barely moved, and the number is near its floor.** Three
slots drawn from roughly four usable chunks in a six-chunk fixture forces a mean
pairwise Jaccard around 0.5 arithmetically. This metric will not say anything
useful until the fixture grows; do not tune against it at this size.

**The retrieval gains are real but now carry noise.** See §3 — a ±1 rank
difference between runs is the reranker, not a change.

### Re-run 2026-10-08 — the TASK-910 staleness is closed

The `after` column was recorded **before** the role the user applied to reached
retrieval. `extractTechKeywords` became `extractRoleKeywords`, Lens B's dense
query now names the role (`rag/lens-query.ts`), and the rerank rubric grades on
domain-of-the-role first. That pipeline has now been measured.

**Hit-rate is the headline: 0.833 → 1.000.** Every one of the six recipients now
gets its gold chunk inside the top 3. `peer-engineer` was the case that missed,
and it no longer does.

**MRR fell, 0.667 → 0.639, and that is not being written up as a win.** The two
metrics disagree because they ask different questions: hit-rate asks *is the
right chunk in the top 3*, MRR asks *how near the top*. Per-case reciprocal
ranks this run were 1.00, 1.00, 0.50, 0.50, 0.50, 0.33 — two firsts where the
earlier run had three. So the pipeline now finds the gold chunk for every
recipient, and ranks it slightly lower on average while doing so.

Whether that is a real trade or noise, **this run cannot say**. §3 puts the
reranker's run-to-run wobble at ±1 rank, and MRR is the metric most sensitive to
exactly that: one case slipping rank 1 → 2 moves MRR by 0.083, which is three
times the drop observed. One run is not a trend. Do not tune against it, and do
not quote 0.639 as evidence of a regression — or 0.732 as evidence of a gain —
until a second run agrees.

The gate floor for MRR is 0.55; this clears it with room, which is the question
the gate exists to answer.

**Two caveats on reading any of these numbers:**

- The fixture is a **backend** resume against a backend JD, which is exactly the
  case the old closed `TECH_VOCAB` allow-list already served well. The measured
  `""`-keywords failure was on a real Oracle Fusion HCM posting, and the eval set
  cannot see it. A flat result here means the fixture is blind to the change, not
  that the change did nothing.
- `TECH_VOCAB` survives as a ×3 boost (ADR-045), which is a thumb on the scale
  this fixture benefits from and a non-software posting does not. Deleting it is
  the open question, and this eval is the wrong instrument to answer it with
  until the fixture includes a posting from outside software.

### Per-leg means, 2026-10-08

The runner prints these and nothing recorded them before, so the sparse leg
being alive has until now been an architectural claim rather than a measured
one. It is measured here.

| leg | P@3 | R@3 | MRR | nDCG@3 | hit-rate |
|---|---|---|---|---|---|
| dense only | 0.222 | 0.667 | 0.556 | 0.583 | 0.667 |
| sparse only | 0.222 | 0.667 | 0.472 | 0.522 | 0.667 |
| fused (RRF) | 0.278 | 0.833 | 0.472 | 0.565 | 0.833 |
| **full pipeline** | **0.333** | **1.000** | **0.639** | **0.732** | **1.000** |

Three things this table settles:

- **The sparse leg is not dead.** Hit-rate 0.667, not 0 — the failure mode §5
  tells you to look for in `toOrQuery` is not present.
- **Fusion beats either leg alone** on hit-rate (0.833 vs 0.667 for both), which
  is the claim RRF exists to make. It does *not* beat dense on MRR, so fusion is
  buying coverage, not precision.
- **The reranker earns its call.** `full` is above `fused` on every column, so
  it is not silently falling back — §5 says a fallback shows `full` equal to
  `fused`.

`engineering-leader` is the clearest single case for the two-leg design: dense
scores 0.00 and sparse 1.00. A dense-only pipeline misses that recipient
entirely.

## 7. The gate

Until now both runners computed everything needed to fail a release and then
exited 0. `eval:drafting` printed the literal words *"FAIL: two recipients
received a byte-identical draft"* on stdout and returned success. A check that
requires a human to read the scrollback is not a check.

`src/eval/gates.ts` holds committed floors; both runners call `enforce()`, which
prints a pass/fail table and sets `process.exitCode = 1`.

| Gate | Floor | Baseline (§6) | Latest measured |
|---|---|---|---|
| retrieval nDCG@3 | ≥ 0.60 | 0.710 | **0.732** (2026-10-08) |
| retrieval MRR | ≥ 0.55 | 0.667 | **0.639** (2026-10-08) |
| retrieval hit-rate | ≥ 0.75 | 0.833 | **1.000** (2026-10-08) |
| forbidden chunks | ≤ 1 case | 1 / 6 | **1 / 6** (2026-10-08) |
| distinct drafts | = 100% | 6 / 6 | **6 / 6** (2026-10-03) |
| numeric faithfulness | ≥ 0.80 | 0.833 | **1.000** (2026-10-03) |
| clean draft rate | ≥ 0.66 | 5 / 6 | **6 / 6** (2026-10-03) |
| evidence overlap | ≤ 0.80 | 0.507 | **0.480** (2026-10-03) |

**All eight gates pass.** Both halves have now been measured against the current
pipeline; no row in this table is older than the last change to the code it
grades.

**Why the floors sit under the baseline rather than at it.** §3 — the pipeline
ends in a `gpt-4o-mini` call, so a chunk can move ±1 rank between identical
runs. A threshold pinned to the baseline fails on noise, and a gate that cries
wolf is bypassed within a week, which is worse than no gate because people
believe it is running. With six cases one flipping is 0.167 of a rate; the
floors are chosen so that **one case regressing trips the gate and wobble does
not**. There is no threshold between those two that this dataset size supports.

Raise a floor when the baseline moves up and holds across two runs. Never lower
one to make a run pass.

**Both halves have now been measured.** `eval:drafting` was re-run on
2026-10-03 and passes all four of its gates: **numeric faithfulness moved
0.833 → 1.000** (6/6) with the clean-draft rate at 6/6, across two consecutive
runs holding 1.000 / 6-6 / 0.480 — the second after the `execute_hybrid_search`
description was rewritten (ADR-007), a prompt change the first run did not
cover. ADR-052 through ADR-062 were all live. `eval:retrieval` was re-run on
2026-10-08 and passes its four; see §6 for why the MRR movement there is not
yet readable as a trend.

**Do not raise the drafting floors on the strength of this.** The rule above —
raise when the baseline moves up and holds across two runs — is outranked here
by the reason the floors sit under the baseline in the first place. With six
cases one flip is 0.167, so a floor at 1.000 fails on exactly the wobble the
±1-rank `gpt-4o-mini` reranker is known to produce, and a gate that cries wolf
gets bypassed. 1.000 on six cases is a cleared gate, not a property. The floor
moves when the dataset grows, not when the score does.

`eval:retrieval` has still **not** been re-run, so nDCG, MRR, hit-rate and the
forbidden-chunk count are all measuring the pre-ADR-052 index. Chunking changes
the *corpus*, so those three numbers describe a different index than the one the
pipeline queries today. The gold markers were re-verified against the new
chunker; the numbers were not.

Two limits on what the 1.000 means. It is **six cases**, so one case flipping is
0.167 — a perfect score on this dataset is a floor-clearing result, not a solved
problem. And the runner seeds its own job, so **every case runs with a non-null
`job_id`**: the corpus-wide path that ADR-056 and migration 0013 added is not
exercised by this eval at all, and must be verified by calling the RPC with
`p_job_id: null` directly.

**Only the full pipeline is gated.** The per-leg means stay diagnostics: a
single leg is allowed to be weak, because fusion exists so that it can be. What
must not regress is what the agent is handed.

**The embedding guard sits on this path deliberately.** `retrieveLegs()` throws
when the corpus was embedded by a model other than `EMBEDDING_MODEL`, and the
eval goes through it. An eval that scores a cross-model corpus reports a number
that means nothing, and the low score would be misread as a ranking regression
(ADR-040).

`pnpm verify:release` runs typecheck, tests, the extension build and both evals
in that order.

## 8. Adding a case

Add to `RETRIEVAL_CASES`. Requirements, in order of how often they are got
wrong:

1. The `rationale` must name a real failure. A case that exists to raise the
   average is worse than no case.
2. Markers must be phrases the fixture actually contains — `pnpm --filter
   @crm/server test` fails loudly if not.
3. Add `forbiddenMarkers` if the case has a known attractor. Most do.
4. Do not vary the job description.
