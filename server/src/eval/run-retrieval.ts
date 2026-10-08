import { PERSONA_CONCERNS, RRF_K } from "@crm/shared";
import { JOB_DESCRIPTION, JOB_TITLE, RETRIEVAL_CASES } from "../../eval/retrieval-cases";
import { fuseRrf, type RankedChunk } from "../rag/fuse";
import { extractRoleKeywords, toOrQuery } from "../rag/keywords";
import { concernLensQuery } from "../rag/lens-query";
import { retrieveLegs, searchResumeForRecipient } from "../rag/search";
import { vectorStore } from "../rag/store";
import { resolveCase, type ResolvedCase } from "./dataset";
import { enforce, RETRIEVAL_FLOORS } from "./gates";
import { aggregate, evaluateRanking, type RankingMetrics } from "./metrics";
import { EVAL_COMPANY, seedEvalCorpus, teardownEvalCorpus } from "./seed";

/**
 * How deep each leg is scored.
 *
 * The shipped pipeline asks for 3 chunks per lens, so K=3 is the number that
 * describes production. It is also the number that makes recall look worst,
 * which is the point: a K large enough to contain the whole fixture would score
 * 1.0 for a retriever that returns the corpus in arbitrary order.
 */
const K = 3;

interface LegScores {
  dense: RankingMetrics;
  sparse: RankingMetrics;
  fused: RankingMetrics;
}

async function main(): Promise<void> {
  console.log(`vector store: ${vectorStore.name}`);
  console.log(`k = ${K}, rrf_k = ${RRF_K}, cases = ${RETRIEVAL_CASES.length}\n`);

  // Inside the `try`: seeding inserts a job and a resume before it embeds, so a
  // failure at the embedding call — the step that depends on a third party —
  // left both rows behind untorn-down while this sat outside it.
  try {
    const corpus = await seedEvalCorpus();
    console.log(`indexed ${corpus.chunks.length} chunks from the fixture resume\n`);

    const cases = RETRIEVAL_CASES.map((c) => resolveCase(c, corpus.chunks));
    const legRows: LegScores[] = [];
    const pipelineRows: RankingMetrics[] = [];
    const violations: string[] = [];

    for (const testCase of cases) {
      const legs = await scoreLegs(corpus.jobId, testCase);
      legRows.push(legs);

      const pipeline = await searchResumeForRecipient({
        jobId: corpus.jobId,
        recipientTitle: testCase.recipientTitle,
        company: EVAL_COMPANY,
        jdText: JOB_DESCRIPTION,
        roleTitle: JOB_TITLE,
        persona: testCase.persona,
        limit: K,
      });
      const retrieved = pipeline.map((hit) => hit.chunk_index);
      const scored = evaluateRanking(retrieved, testCase.relevantChunks, K);
      pipelineRows.push(scored);

      const forbidden = retrieved.filter((index) =>
        testCase.forbiddenChunks.includes(index),
      );
      if (forbidden.length > 0) {
        violations.push(
          `${testCase.id}: returned forbidden chunk(s) ${forbidden.join(", ")} — ` +
            testCase.rationale,
        );
      }

      printCase(testCase, legs, scored, retrieved);
    }

    console.log("\n=== per-leg means ===");
    printAggregate("dense only", legRows.map((r) => r.dense));
    printAggregate("sparse only", legRows.map((r) => r.sparse));
    printAggregate("fused (RRF)", legRows.map((r) => r.fused));
    console.log("\n=== full pipeline (two lenses, RRF-fused) ===");
    printAggregate("pipeline", pipelineRows);

    if (violations.length > 0) {
      console.log("\n=== forbidden-chunk violations ===");
      for (const violation of violations) console.log(`  ${violation}`);
    }

    // A dead leg is the failure this harness exists to catch, and it does not
    // show up as a low score — it shows up as a leg that never fires at all
    // while fusion quietly returns the other leg's ranking.
    const sparseHits = legRows.filter((r) => r.sparse.hit).length;
    if (sparseHits === 0) {
      console.log(
        "\nWARNING: the sparse leg hit nothing in any case. Check `toOrQuery` — " +
          "`websearch_to_tsquery` ANDs bare words, so a space-joined keyword list " +
          "matches no chunk and hybrid search degrades silently to dense-only.",
      );
    }

    // Only the full pipeline is gated. The per-leg means are diagnostics: a
    // single leg is allowed to be weak, because fusion exists precisely so that
    // it can be. What must not regress is what the agent is handed.
    const pipeline = aggregate(pipelineRows);
    enforce("retrieval", [
      {
        name: `nDCG@${K}`,
        actual: pipeline.ndcgAtK,
        threshold: RETRIEVAL_FLOORS.ndcgAtK,
        direction: "min",
      },
      { name: "MRR", actual: pipeline.mrr, threshold: RETRIEVAL_FLOORS.mrr, direction: "min" },
      {
        name: "hit-rate",
        actual: pipeline.hitRate,
        threshold: RETRIEVAL_FLOORS.hitRate,
        direction: "min",
      },
      {
        name: "forbidden chunks",
        actual: violations.length,
        threshold: RETRIEVAL_FLOORS.maxViolations,
        direction: "max",
      },
    ]);
  } finally {
    await teardownEvalCorpus();
  }
}

/**
 * Score dense, sparse and their fusion on one case, from a single retrieval.
 *
 * Only the concern lens is measured here. It is the lens the persona work was
 * built for, so it is the one where a regression means the feature stopped
 * working; the other two are measured through the pipeline row below.
 */
async function scoreLegs(jobId: string, testCase: ResolvedCase): Promise<LegScores> {
  const concerns = PERSONA_CONCERNS[testCase.persona];
  const { dense, sparse } = await retrieveLegs({
    jobId,
    query: concernLensQuery({
      recipientTitle: testCase.recipientTitle,
      company: EVAL_COMPANY,
      persona: testCase.persona,
      roleTitle: JOB_TITLE,
    }),
    keywords: toOrQuery([...concerns.terms, extractRoleKeywords(JOB_DESCRIPTION, JOB_TITLE)]),
    limit: K,
  });

  const fused = fuseRrf([dense, sparse], { k: RRF_K, limit: K });

  return {
    dense: score(dense.slice(0, K), testCase),
    sparse: score(sparse.slice(0, K), testCase),
    fused: evaluateRanking(
      fused.map((hit) => hit.chunk_index),
      testCase.relevantChunks,
      K,
    ),
  };
}

function score(chunks: RankedChunk[], testCase: ResolvedCase): RankingMetrics {
  return evaluateRanking(
    chunks.map((chunk) => chunk.chunk_index),
    testCase.relevantChunks,
    K,
  );
}

/**
 * The pipeline's actual ranking is printed, not just its score. A row saying
 * `forbidden=1` without naming what came back tells you a rule was broken and
 * nothing about which chunk broke it, which means the first thing anyone does
 * with a red line is write a throwaway script to print exactly this.
 */
function printCase(
  testCase: ResolvedCase,
  legs: LegScores,
  pipeline: RankingMetrics,
  retrieved: number[],
): void {
  const forbidden = retrieved.filter((i) => testCase.forbiddenChunks.includes(i));
  console.log(`${testCase.id}  (${testCase.persona})`);
  console.log(
    `  gold: [${testCase.relevantChunks.join(", ")}]  ` +
      `forbidden: [${testCase.forbiddenChunks.join(", ")}]`,
  );
  console.log(
    `  dense  ${fmt(legs.dense)}\n` +
      `  sparse ${fmt(legs.sparse)}\n` +
      `  fused  ${fmt(legs.fused)}\n` +
      `  full   ${fmt(pipeline)}  returned=[${retrieved.join(", ")}]` +
      (forbidden.length > 0 ? `  VIOLATION` : ""),
  );
}

function fmt(m: RankingMetrics): string {
  return (
    `P@${K}=${m.precisionAtK.toFixed(2)} ` +
    `R@${K}=${m.recallAtK.toFixed(2)} ` +
    `RR=${m.reciprocalRank.toFixed(2)} ` +
    `nDCG@${K}=${m.ndcgAtK.toFixed(2)}`
  );
}

function printAggregate(label: string, rows: RankingMetrics[]): void {
  const a = aggregate(rows);
  console.log(
    `  ${label.padEnd(12)} ` +
      `P@${K}=${a.precisionAtK.toFixed(3)} ` +
      `R@${K}=${a.recallAtK.toFixed(3)} ` +
      `MRR=${a.mrr.toFixed(3)} ` +
      `nDCG@${K}=${a.ndcgAtK.toFixed(3)} ` +
      `hit-rate=${a.hitRate.toFixed(3)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
