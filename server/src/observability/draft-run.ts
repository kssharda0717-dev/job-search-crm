import type { MessageType, Persona } from "@crm/shared";
import { db } from "../db";

/**
 * Persist one row of `draft_runs` (migration 0008).
 *
 * Separated from `draft.ts` so the drafting path reads as drafting, and so this
 * file can hold the one rule that matters here: **recording a run must never
 * fail a run**. A draft that was written, critiqued and repaired successfully
 * is not made worse by the telemetry insert failing, and turning an
 * observability outage into a drafting outage is the classic way monitoring
 * takes down the thing it monitors. So this swallows its own errors and logs
 * them — the only place in the server that deliberately does.
 *
 * The inverse is also deliberate: failures are recorded too. A run that threw
 * is the one you most want to be able to query later, so `error` is a column
 * rather than a reason not to insert.
 */
export interface DraftRunRecord {
  messageId: string | null;
  contactId: string;
  jobId: string | null;
  type: MessageType;
  persona: Persona | null;
  evidenceChunkIds: string[];
  ungroundedFigures: number;
  critiqueProblems: number;
  repairPasses: number;
  /**
   * Rewrites that scored better and were kept, of the `repairPasses` attempted.
   * `repairPasses > 0 && repairAccepted === 0` is a loop that paid for two model
   * calls and shipped the first thing the model said — invisible while only the
   * attempt count was stored.
   */
  repairAccepted: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  modelCalls: number;
  latencyMs: number;
  error: string | null;
}

export async function recordDraftRun(run: DraftRunRecord): Promise<void> {
  const { error } = await db.from("draft_runs").insert({
    message_id: run.messageId,
    contact_id: run.contactId,
    job_id: run.jobId,
    type: run.type,
    persona: run.persona,
    evidence_chunk_ids: run.evidenceChunkIds,
    ungrounded_figures: run.ungroundedFigures,
    critique_problems: run.critiqueProblems,
    repair_passes: run.repairPasses,
    repair_accepted: run.repairAccepted,
    model: run.model,
    prompt_tokens: run.promptTokens,
    completion_tokens: run.completionTokens,
    model_calls: run.modelCalls,
    latency_ms: run.latencyMs,
    error: run.error,
  });

  if (error) {
    console.warn(`[draft_runs] insert failed, run not recorded: ${error.message}`);
  }
}
