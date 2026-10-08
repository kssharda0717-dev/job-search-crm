/**
 * Token and call accounting for one drafting run.
 *
 * A run is not one model call. It is up to six ReAct turns, a reranking call,
 * up to two repair passes and possibly a shorten pass — so reporting the cost
 * of the drafting completion alone undercounts a run by more than half, and the
 * undercount grows exactly when the run went badly. Anything that makes an
 * expensive run look cheap is worse than no number.
 *
 * Deliberately a mutable object threaded through `ToolContext` rather than an
 * `AsyncLocalStorage` ambient. The context object already exists and already
 * accumulates run state (`citations`), so this costs three signature changes
 * and no magic; an async-context read that silently returns nothing when the
 * store is unset is a metric that quietly reports zero, which is the failure
 * this module exists to prevent.
 *
 * Pure and dependency-free so it can be unit tested; nothing here may import
 * `db` or `env`, both of which reach `env`, which throws at import time.
 */

export interface UsageMeter {
  promptTokens: number;
  completionTokens: number;
  /** Model calls made, including any that reported no usage. */
  calls: number;
}

export function createMeter(): UsageMeter {
  return { promptTokens: 0, completionTokens: 0, calls: 0 };
}

/**
 * Record one model call.
 *
 * `calls` increments even when `usage` is missing, and that is the point: the
 * OpenAI API omits `usage` on some responses and a caller that skipped counting
 * those would report a run as cheaper than it was. A call with unknown token
 * cost is still a call that was billed. Counting it keeps the two numbers
 * honest about each other — `calls` high with tokens low means usage is going
 * unreported, which is a visible discrepancy rather than a silent shortfall.
 */
export function recordUsage(
  meter: UsageMeter,
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null,
): void {
  meter.calls += 1;
  meter.promptTokens += usage?.prompt_tokens ?? 0;
  meter.completionTokens += usage?.completion_tokens ?? 0;
}
