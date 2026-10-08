import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { type HybridSearchHit, Persona, PERSONA_GUIDANCE } from "@crm/shared";
import { db } from "../db";
import type { UsageMeter } from "../observability/meter";
import { searchResumeForRecipient } from "../rag/search";
import { extractRoleKeywords } from "../rag/keywords";
import { env } from "../env";
import { escapeLikePattern } from "../services/company-match";
import { personaFromHeadline } from "./persona";

/** Tool schemas exposed to the drafting agent (PRD section 5). */
export const TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "classify_persona",
      description:
        "Classify the LinkedIn headline into a target persona. Call this FIRST, " +
        "before any other tool: it also steers which resume evidence is " +
        "retrieved. Founder_Executive = founder/CEO/CTO/VP who owns the " +
        "business. Engineering_Leader = runs an engineering team. " +
        "Technical_Recruiter = hires. Peer_Engineer = builds the product. " +
        "Adjacent_Employee = works there but not in engineering (support, " +
        "success, ops, sales, marketing).",
      parameters: {
        type: "object",
        properties: {
          headline: { type: "string", description: "The contact's LinkedIn headline." },
          persona: {
            type: "string",
            enum: Persona.options,
            description: "Your classification of the headline.",
          },
        },
        required: ["headline", "persona"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_hybrid_search",
      // The retrieval mechanism used to be named here as "BM25 + vector
      // search". It is `ts_rank_cd` + pgvector, which is not BM25, and a tool
      // description is read by the model as fact. Naming the mechanism at all
      // was the mistake: it tells the model nothing about *when* to call this,
      // which is the only thing a description is for.
      description:
        "Retrieve concrete facts about the candidate from their indexed " +
        "resumes. Use the returned bullets as the only source of claims about " +
        "the candidate.",
      parameters: {
        type: "object",
        properties: {
          job_id: { type: "string" },
          query: {
            type: "string",
            description:
              "Natural-language description of what the recipient would care about.",
          },
        },
        required: ["job_id", "query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_company_message_history",
      description:
        "Fetch messages already sent to people at this company so you do not " +
        "repeat an opening hook. Call this before writing the draft.",
      parameters: {
        type: "object",
        properties: {
          company_name: { type: "string" },
        },
        required: ["company_name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_recent_company_news",
      description:
        "Find a recent, specific news item about the company to use as a " +
        "follow-up icebreaker. Only useful for follow-up messages.",
      parameters: {
        type: "object",
        properties: {
          company_name: { type: "string" },
        },
        required: ["company_name"],
        additionalProperties: false,
      },
    },
  },
];

export interface ToolContext {
  jobId: string | null;
  company: string;
  jdText: string | null;
  /**
   * The title of the role applied to. It used to reach the task prompt and
   * nothing else, so every retrieval and ranking decision was made without
   * knowing what the message was about — see rag/rerank.ts.
   */
  roleTitle: string | null;
  recipientTitle: string;
  /**
   * The recipient's own About/Experience/Skills, when their profile has been
   * read. Steers retrieval and is quoted into the task prompt — it is the only
   * input that says what *they* work on, as opposed to what the job ad wants.
   */
  recipientProfile: string | null;
  /** Accumulates every hit surfaced to the model, for user-facing citations. */
  citations: HybridSearchHit[];
  persona: Persona | null;
  /** Run accounting. Lives here because the context is already the place where
   *  per-run state accumulates, and because the reranker is reached only from
   *  inside a tool call — there is no other way to bill it to the run. */
  meter: UsageMeter;
}

/** Dispatch a single tool call. Errors become tool output, not exceptions, so
 *  a failing tool degrades the draft instead of killing the request. */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  try {
    switch (name) {
      case "classify_persona": {
        const parsed = Persona.safeParse(args.persona);
        if (!parsed.success) {
          return JSON.stringify({ error: `persona must be one of ${Persona.options.join(", ")}` });
        }

        // The headline the model was given, not the one it echoed back: it has
        // been observed to paraphrase the argument it was asked to classify.
        const fromRules = personaFromHeadline(ctx.recipientTitle);
        const persona = fromRules ?? parsed.data;
        ctx.persona = persona;

        return JSON.stringify({
          persona,
          tone_guidance: PERSONA_GUIDANCE[persona],
          // Said out loud rather than silently swapped, because the model is
          // about to write a question aimed at whoever it believes it is
          // talking to. A silent override would leave the draft addressed to
          // the persona it guessed.
          ...(fromRules && fromRules !== parsed.data
            ? {
                correction:
                  `You answered ${parsed.data}, but the headline "${ctx.recipientTitle}" ` +
                  `says ${persona}. Use ${persona}. Ask only what someone with ` +
                  `that title could answer off the top of their head.`,
              }
            : {}),
        });
      }

      case "execute_hybrid_search": {
        // An unlinked contact used to short-circuit to `hits: []` here, and the
        // agent then wrote from nothing for 6 of the 31 people in this CRM. The
        // cause was never missing data — every resume was indexed — it was that
        // `captureMissedInvitations` reads the Sent-invitations page, which
        // gives a name and a headline and no employer, so there was no job to
        // scope the search to and PRD §6 forbids opening their profile to find
        // one. With no application there is also no application to cross, so the
        // search runs over the candidate's whole corpus instead. See migration
        // 0013 and the carve-out on `VectorStore`.
        const hits = await searchResumeForRecipient({
          jobId: ctx.jobId,
          recipientTitle: ctx.recipientTitle,
          company: ctx.company,
          jdText: ctx.jdText,
          roleTitle: ctx.roleTitle,
          persona: ctx.persona,
          recipientProfile: ctx.recipientProfile,
          limit: 3,
          meter: ctx.meter,
        });
        ctx.citations.push(...hits);

        // An empty result used to come back as a bare `hits: []`, which the
        // model read as "nothing to say about the candidate" and filled with
        // invented enthusiasm. Say out loud that there is no evidence and what
        // that forbids.
        if (hits.length === 0) {
          return JSON.stringify({
            hits: [],
            note:
              "No resume is indexed, so there is NO evidence about the " +
              "candidate. Do not state any achievement, metric, technology or " +
              "years of experience. Write a short message that names the role " +
              "applied to and asks one question — nothing else.",
          });
        }

        return JSON.stringify({
          hits: hits.map((h) => h.chunk_text),
          jd_keywords: extractRoleKeywords(ctx.jdText, ctx.roleTitle, 12),
          // Said out loud because the evidence is real but its provenance is
          // not what the model will assume. These passages come from resumes
          // written for other applications, so "the resume I sent you" is a
          // false sentence here — there is no application with this person's
          // employer behind it.
          ...(ctx.jobId
            ? {}
            : {
                provenance:
                  "This contact is not linked to any application. The passages " +
                  "above come from resumes tailored for OTHER roles. Do not " +
                  "mention applying, a role, a referral or an attached resume. " +
                  "Use one passage as something the candidate has actually " +
                  "done, and nothing more.",
              }),
          // These are ordered by how well each passage gives *this* recipient
          // something to reply to about *this* role — the reranker's judgement,
          // not the search engine's. Saying "best first" is therefore true, and
          // it is the only ordering claim that stays true if the lenses change
          // again.
          instruction:
            "These are ordered best-first: the ranking already accounts for " +
            "this recipient and for the role applied to. Use exactly one of " +
            "them, and prefer the first — reorder only to skip one that says " +
            "nothing about the role applied to. Do not pick a passage because " +
            "its number is larger; a metric from unrelated work reads as a " +
            "mass mailing. Reproduce any figure exactly, and claim nothing " +
            "that is not written in these texts.",
        });
      }

      case "check_company_message_history": {
        const company = String(args.company_name ?? ctx.company);
        // Join through jobs to scope history to this company, and include
        // drafts as well as sent messages so we don't repeat a pending hook.
        //
        // The pattern is escaped because this argument comes from the model,
        // which is free to echo back whatever it read on the job posting. An
        // unescaped `%` would widen the filter to every message the user has
        // ever written, and the model would then be told not to reuse hooks
        // from companies it has nothing to do with.
        const { data, error } = await db
          .from("messages")
          .select("draft_text, sent_text, type, created_at, jobs!inner(company)")
          .ilike("jobs.company", `%${escapeLikePattern(company)}%`)
          .order("created_at", { ascending: false })
          .limit(10);
        if (error) return JSON.stringify({ error: error.message });

        const history = (data ?? []).map((m) => ({
          type: m.type,
          text: m.sent_text ?? m.draft_text,
        }));
        return JSON.stringify({
          previous_messages: history,
          instruction:
            history.length > 0
              ? "Do not reuse the opening line or the same achievement as any message above."
              : "No prior contact at this company; any hook is fresh.",
        });
      }

      case "find_recent_company_news": {
        if (!env.TAVILY_API_KEY) {
          return JSON.stringify({
            news: null,
            note: "Web search is not configured. Do not invent news; skip the icebreaker.",
          });
        }
        return await searchNews(String(args.company_name ?? ctx.company));
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * An icebreaker is the most optional thing in the whole draft, so it gets the
 * least patience. Without this the ReAct loop simply waits on a third party for
 * as long as it takes, and a single hung socket stalls the drafting alarm — the
 * user sees no draft and no error. `runTool`'s catch turns the abort into tool
 * output, which is exactly the degradation this file already promises.
 */
const NEWS_TIMEOUT_MS = 6_000;

async function searchNews(company: string): Promise<string> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(NEWS_TIMEOUT_MS),
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query: `${company} company news announcement`,
      search_depth: "basic",
      max_results: 3,
      topic: "news",
      days: 60,
    }),
  });

  if (!res.ok) {
    return JSON.stringify({ news: null, note: "News lookup failed; skip the icebreaker." });
  }

  const body = (await res.json()) as {
    results?: Array<{ title: string; url: string; content: string }>;
  };
  const results = (body.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content.slice(0, 300),
  }));

  return JSON.stringify({
    news: results,
    instruction:
      results.length > 0
        ? "Reference at most one item, and only if it genuinely relates to the role."
        : "Nothing recent found; skip the icebreaker rather than inventing one.",
  });
}
