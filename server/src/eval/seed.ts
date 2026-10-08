import { readFile } from "node:fs/promises";
import { EMBEDDING_MODEL } from "@crm/shared";
import { JOB_DESCRIPTION } from "../../eval/retrieval-cases";
import { db, unwrap } from "../db";
import { escapeLikePattern } from "../services/company-match";
import { chunkResumeText } from "../rag/chunk";
import { embedTexts } from "../rag/embeddings";
import { vectorStore } from "../rag/store";
import { FIXTURE_PATH } from "./dataset";

/**
 * The eval corpus is indexed under a real job row, because retrieval filters by
 * `job_id` and a fake id would return nothing while looking like a retrieval
 * failure.
 *
 * `external_job_id` is the marker rather than the company name, so the job can
 * carry a plausible company, title and JD — the drafting eval needs all three,
 * and a job called `__eval__` would make every draft say `__eval__`. Teardown
 * finds the row by this string instead of a hardcoded uuid, so a run that dies
 * halfway still leaves something the next run can clean up. The partial unique
 * index on the column means there can only ever be one.
 *
 * Exported because the drafting eval has to stamp it into the `linkedin_url` of
 * every contact it creates. See `teardownEvalCorpus` for why.
 */
export const EVAL_MARKER = "__crm_eval_fixture__";

/**
 * The employer applied to. Deliberately not Northwind Logistics — that is the
 * candidate's *own* employer in the fixture, and reusing it would make "at
 * <company>" in the concern query match the resume's role headers.
 */
export const EVAL_COMPANY = "Meridian Pay";
export const EVAL_TITLE = "Senior Backend Engineer, Payments Platform";

export interface EvalCorpus {
  jobId: string;
  resumeId: string;
  company: string;
  title: string;
  /** The fixture's chunks in index order — what the gold labels resolve against. */
  chunks: string[];
}

/**
 * Index the fixture resume so the eval runners have something to retrieve from.
 *
 * This deliberately does not go through `indexResume()`. That function also
 * uploads PDF bytes to Storage and renames the file, neither of which retrieval
 * can observe; making the eval depend on them would mean a Storage outage
 * reported itself as a drop in recall. What it does share is the part retrieval
 * *can* observe — the same chunker, the same embedding model and the same
 * `vectorStore` — so a change to any of those shows up here.
 */
export async function seedEvalCorpus(): Promise<EvalCorpus> {
  await teardownEvalCorpus();

  const text = await readFile(FIXTURE_PATH, "utf8");
  const chunks = chunkResumeText(text);
  if (chunks.length === 0) {
    throw new Error(`Fixture ${FIXTURE_PATH} produced no chunks.`);
  }

  const job = unwrap(
    await db
      .from("jobs")
      .insert({
        company: EVAL_COMPANY,
        title: EVAL_TITLE,
        jd_text: JOB_DESCRIPTION,
        external_job_id: EVAL_MARKER,
        source: "external_ats",
        status: "Applied",
        applied_at: new Date().toISOString(),
      })
      .select("id")
      .single(),
    "Insert eval job",
  ) as { id: string };

  const resume = unwrap(
    await db
      .from("resumes")
      .insert({
        job_id: job.id,
        file_name: "eval-fixture.pdf",
        // No object is uploaded under this path. Nothing in the eval reads it,
        // and the column is NOT NULL.
        storage_path: `${job.id}/eval-fixture.pdf`,
        extracted_text: text,
      })
      .select("id")
      .single(),
    "Insert eval resume",
  ) as { id: string };

  const embeddings = await embedTexts(chunks);
  await vectorStore.upsertChunks(
    chunks.map((chunkText, i) => ({
      resumeId: resume.id,
      jobId: job.id,
      chunkIndex: i,
      chunkText,
      embedding: embeddings[i]!,
      embeddingModel: EMBEDDING_MODEL,
    })),
  );

  return {
    jobId: job.id,
    resumeId: resume.id,
    company: EVAL_COMPANY,
    title: EVAL_TITLE,
    chunks,
  };
}

/**
 * Remove every eval job, its vectors, and every contact the drafting eval made.
 *
 * Deleting the job cascades to `resumes` and `resume_chunks` in Postgres, but
 * an external store has no foreign keys, so its points are deleted explicitly
 * first. Leaving them behind would not just waste space: the next run indexes
 * the same text again, and a stale copy under a *different* job_id is invisible
 * to the filter right up until someone changes the filter.
 *
 * Contacts are deleted here rather than only in the runner's `finally`, because
 * a `finally` does not run when the process is killed — and they are
 * `on delete set null` against jobs, not cascade, so dropping the job does not
 * take them with it. A crashed run therefore left behind rows that were
 * indistinguishable from real contacts, with `status = 'Accepted'`, which is
 * precisely the state the follow-up sweep looks for: the next sweep would pick
 * them up and spend real tokens drafting messages to people who do not exist.
 *
 * Matched on the marker in `linkedin_url`, because there is no column on
 * `contacts` to put it in and the url already has to be unique per run.
 */
export async function teardownEvalCorpus(): Promise<void> {
  const contacts = await db
    .from("contacts")
    .delete()
    .like("linkedin_url", `%${escapeLikePattern(EVAL_MARKER)}%`);
  if (contacts.error) throw new Error(`Delete eval contacts: ${contacts.error.message}`);

  const { data, error } = await db
    .from("jobs")
    .select("id, resumes(id)")
    .eq("external_job_id", EVAL_MARKER);
  if (error) throw new Error(`Find eval jobs: ${error.message}`);

  for (const job of (data ?? []) as Array<{ id: string; resumes: Array<{ id: string }> }>) {
    for (const resume of job.resumes ?? []) {
      await vectorStore.deleteResumeChunks({ resumeId: resume.id, jobId: job.id });
    }
    const deleted = await db.from("jobs").delete().eq("id", job.id);
    if (deleted.error) throw new Error(`Delete eval job: ${deleted.error.message}`);
  }
}
