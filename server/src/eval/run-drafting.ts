import { randomUUID } from "node:crypto";
import { RETRIEVAL_CASES } from "../../eval/retrieval-cases";
import { critiqueDraft } from "../agent/critique";
import { generateDraft } from "../agent/draft";
import { db, unwrap } from "../db";
import { scoreFaithfulness, type FaithfulnessScore } from "./faithfulness";
import { DRAFTING_FLOORS, enforce } from "./gates";
import { EVAL_MARKER, EVAL_TITLE, seedEvalCorpus, teardownEvalCorpus } from "./seed";

/**
 * End-to-end drafting eval: one message per labelled recipient, against one
 * resume and one job.
 *
 * Three things are measured, and none of them is an LLM judge. A judge from the
 * same model family grades its own hallucinations as fine, costs a call per
 * case, and gives a different answer on every run — so a regression and noise
 * look identical. What is measured instead is what can be checked exactly:
 *
 * 1. Faithfulness — every figure in the draft must appear in the evidence the
 *    draft was built from. This is the only failure the user cannot recover
 *    from, because the recipient can hold the message next to the resume
 *    attached to the same application.
 * 2. Critique pass rate — `critiqueDraft` run on the *final* draft. The agent
 *    already repairs once, so a problem surviving here is a problem the repair
 *    turn could not fix.
 * 3. Evidence overlap — how much two recipients' drafts were built from the
 *    same chunks. This is the anti-criterion from the PRD stated as a number:
 *    if a support lead and a founder get the same bullets, personalisation is
 *    decoration.
 */

/** One draft per case, so a run is 6 agent loops. Kept explicit: this costs money. */
const TYPE = "connection_note" as const;

interface CaseResult {
  id: string;
  persona: string;
  draft: string;
  faithfulness: FaithfulnessScore;
  problems: string[];
  evidence: number[];
}

async function main(): Promise<void> {
  const results: CaseResult[] = [];

  // Seeding is inside the `try` because it is not atomic: it inserts the job,
  // then the resume, then embeds. A failure at the embedding step — the one
  // step that depends on a third party — used to leave both rows behind with
  // no teardown, because the call sat outside it.
  try {
    const corpus = await seedEvalCorpus();

    for (const testCase of RETRIEVAL_CASES) {
      const contact = unwrap(
        await db
          .from("contacts")
          .insert({
            job_id: corpus.jobId,
            name: `Eval ${titleCase(testCase.id)}`,
            // Unique per run so a crashed previous run cannot collide with the
            // unique index on this column, and marked so that `teardown` can
            // find the survivors of one — there is no marker column on
            // `contacts`, and this is the only field that is ours to shape.
            linkedin_url: `https://www.linkedin.com/in/${EVAL_MARKER}-${testCase.id}-${randomUUID()}/`,
            headline: testCase.recipientTitle,
            company: corpus.company,
            status: "Accepted",
          })
          .select("id, name")
          .single(),
        "Insert eval contact",
      ) as { id: string; name: string };

      const result = await generateDraft({ contactId: contact.id, type: TYPE });
      const draft = result.message.draft_text;
      const evidence = result.citations.map((hit) => hit.chunk_text);

      results.push({
        id: testCase.id,
        persona: result.persona,
        draft,
        faithfulness: scoreFaithfulness(draft, evidence),
        problems: critiqueDraft(draft, {
          recipientFirstName: contact.name.split(/\s+/)[0]!,
          roleTitle: EVAL_TITLE,
          persona: result.persona,
          evidence,
        }).problems,
        evidence: result.citations.map((hit) => hit.chunk_index),
      });
    }

    report(results);
  } finally {
    // Removes the contacts too — they are `on delete set null` against jobs,
    // not cascade, so dropping the job would leave them behind as
    // real-looking CRM rows.
    await teardownEvalCorpus();
  }
}

function report(results: CaseResult[]): void {
  for (const result of results) {
    console.log(`\n=== ${result.id} (${result.persona}) ===`);
    console.log(result.draft);
    console.log(
      `  chunks=[${result.evidence.join(", ")}] ` +
        `figures=${result.faithfulness.figures} ` +
        `numeric=${result.faithfulness.numeric.toFixed(2)} ` +
        `lexical=${result.faithfulness.lexical.toFixed(2)}`,
    );
    if (result.faithfulness.ungrounded.length > 0) {
      console.log(`  UNGROUNDED FIGURES: ${result.faithfulness.ungrounded.join(", ")}`);
    }
    for (const problem of result.problems) console.log(`  PROBLEM: ${problem}`);
  }

  const n = results.length;
  const mean = (pick: (r: CaseResult) => number) =>
    results.reduce((sum, r) => sum + pick(r), 0) / n;

  console.log("\n=== drafting summary ===");
  console.log(`  cases                 ${n}`);
  console.log(`  faithfulness numeric  ${mean((r) => r.faithfulness.numeric).toFixed(3)}`);
  console.log(`  faithfulness lexical  ${mean((r) => r.faithfulness.lexical).toFixed(3)}`);
  console.log(
    `  clean drafts          ${results.filter((r) => r.problems.length === 0).length}/${n}`,
  );
  console.log(
    `  drafts with a figure  ${results.filter((r) => r.faithfulness.figures > 0).length}/${n}`,
  );
  const overlap = meanOverlap(results);
  console.log(`  mean evidence overlap ${overlap.toFixed(3)}`);

  // Not a threshold. Two recipients receiving the same bytes is the single
  // defect this product cannot ship, so it is expressed as a 1/0 gate with the
  // floor at 1 rather than as a rate somebody could argue about.
  const distinct = new Set(results.map((r) => r.draft)).size;
  if (distinct !== n) {
    console.log("\nFAIL: two recipients received a byte-identical draft.");
  }

  enforce("drafting", [
    {
      name: "distinct drafts",
      actual: distinct / n,
      threshold: 1,
      direction: "min",
    },
    {
      name: "numeric faithfulness",
      actual: mean((r) => r.faithfulness.numeric),
      threshold: DRAFTING_FLOORS.numericFaithfulness,
      direction: "min",
    },
    {
      name: "clean draft rate",
      actual: results.filter((r) => r.problems.length === 0).length / n,
      threshold: DRAFTING_FLOORS.cleanDraftRate,
      direction: "min",
    },
    {
      name: "evidence overlap",
      actual: overlap,
      threshold: DRAFTING_FLOORS.maxEvidenceOverlap,
      direction: "max",
    },
  ]);
}

/**
 * Mean Jaccard overlap of the retrieved chunk sets across every pair of cases.
 *
 * 1.0 means every recipient was pitched from the same evidence — the failure
 * the three-lens retrieval was built to fix. 0.0 is not the target either: the
 * two engineering cases *should* share the Kafka work. What this catches is the
 * number drifting back up towards 1 after a change to fusion or the lenses.
 */
function meanOverlap(results: CaseResult[]): number {
  const pairs: number[] = [];
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      pairs.push(jaccard(results[i]!.evidence, results[j]!.evidence));
    }
  }
  return pairs.length === 0 ? 0 : pairs.reduce((a, b) => a + b, 0) / pairs.length;
}

function jaccard(a: number[], b: number[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 0;
  const shared = [...left].filter((value) => right.has(value)).length;
  return shared / (left.size + right.size - shared);
}

function titleCase(id: string): string {
  return id
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
