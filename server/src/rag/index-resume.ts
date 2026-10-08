import { EMBEDDING_MODEL, type Resume, type UploadResumeResponse } from "@crm/shared";
import { RESUME_BUCKET, db, unwrap } from "../db";
import { chunkResumeText } from "./chunk";
import { embedTexts } from "./embeddings";
import { canonicalResumeName } from "./resume-name";
import { vectorStore } from "./store";

/**
 * Commit a tailored resume to the Document Vault: store the PDF bytes, record
 * the extracted text, then chunk + embed for later retrieval.
 *
 * Re-uploading for the same job replaces the previous resume. The schema
 * enforces 1:1 job:resume, and a stale vector index would let a draft cite a
 * bullet from a resume the user didn't actually send. The route refuses that
 * replacement unless the caller asked for it, because it cannot be undone.
 */
export async function indexResume(params: {
  jobId: string;
  fileName: string;
  fileBytes: Buffer;
  extractedText: string;
  userName?: string | null;
}): Promise<UploadResumeResponse> {
  const { jobId, fileBytes, extractedText } = params;

  const job = unwrap(
    await db.from("jobs").select("company, title").eq("id", jobId).single(),
    "Load job for resume",
  ) as { company: string; title: string };

  const fileName = canonicalResumeName({
    userName: params.userName,
    company: job.company,
    title: job.title,
    fallback: params.fileName,
  });

  const existing = await db
    .from("resumes")
    .select("id, storage_path")
    .eq("job_id", jobId)
    .maybeSingle();

  // Everything that can fail happens before anything is destroyed.
  //
  // The previous order tore down the old object, its vectors and its row first,
  // and only then attempted the upload and the embedding call. A failure at
  // either — an expired storage credential, an OpenAI outage — left the job
  // with no resume at all, or with a resume row and zero chunks, which reads to
  // every later draft as "this candidate has no evidence". The user cannot
  // recover from that: the bytes only ever existed in the request that failed.
  const chunks = chunkResumeText(extractedText);
  const embeddings = chunks.length > 0 ? await embedTexts(chunks) : [];

  // A fresh key every time, so the upload cannot overwrite the resume already
  // filed against this job. The deterministic key plus `upsert` destroyed the
  // previous bytes *here*, before the new row was written — the one step this
  // function claims never to take. The timestamp is invisible to the user: the
  // download route sets Content-Disposition from `file_name`, so the browser
  // saves the canonical name whatever the object is called.
  const storagePath = `${jobId}/${Date.now()}-${sanitizeFileName(fileName)}`;
  const upload = await db.storage
    .from(RESUME_BUCKET)
    .upload(storagePath, fileBytes, { contentType: "application/pdf" });
  if (upload.error) {
    throw new Error(`Resume upload failed: ${upload.error.message}`);
  }

  if (existing.data) {
    // Explicit rather than relying on the cascade: when vectors live outside
    // Postgres nothing cascades into them, and a stale vector is worse than a
    // stale row — it lets a draft cite a bullet from a resume the user replaced.
    await vectorStore.deleteResumeChunks({ resumeId: existing.data.id, jobId });
    // Deleted rather than updated because `resumes_job_id_uniq` is 1:1, so the
    // old row must be gone before the new one can be inserted.
    await db.from("resumes").delete().eq("id", existing.data.id);
  }

  const resume = unwrap(
    await db
      .from("resumes")
      .insert({
        job_id: jobId,
        file_name: fileName,
        storage_path: storagePath,
        extracted_text: extractedText,
      })
      .select()
      .single(),
    "Insert resume",
  ) as Resume;

  // Last, once the replacement is committed and nothing else can fail. Earlier
  // and a failure between the two leaves a job whose resume row points at an
  // object that no longer exists.
  if (existing.data) {
    await db.storage.from(RESUME_BUCKET).remove([existing.data.storage_path]);
  }

  if (chunks.length === 0) {
    return { resume, chunkCount: 0 };
  }

  await vectorStore.upsertChunks(
    chunks.map((chunkText, i) => ({
      resumeId: resume.id,
      jobId,
      chunkIndex: i,
      chunkText,
      embedding: embeddings[i]!,
      embeddingModel: EMBEDDING_MODEL,
    })),
  );

  return { resume, chunkCount: chunks.length };
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
