/**
 * Post-generation check on a draft.
 *
 * The system prompt already forbids all of this, and the model breaks it
 * anyway — an observed draft opened "As someone who's passionate about AI
 * systems" and closed "Looking forward to hearing your insights!", both
 * explicitly banned. Prompt rules are a preference; this is the enforcement.
 * Anything it returns is fed back for one repair turn.
 *
 * Pure and dependency-free so it can be unit tested; nothing here may import
 * `env`, which throws at import time.
 */

import type { Persona } from "@crm/shared";

/**
 * Phrases that carry no information about the sender. Every one of these is a
 * slot that a specific fact should have occupied.
 */
const BANNED: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /\b(passionate|excited|enthusiastic)\s+about\b/i,
    why: "declares an emotion instead of stating a fact; replace it with something you have actually built",
  },
  {
    pattern: /\bas someone who\b/i,
    why: "self-characterisation with no evidence behind it",
  },
  {
    pattern: /\b(deeply|really|genuinely)\s+interested\b/i,
    why: "an adjective standing in for a reason",
  },
  {
    pattern: /\bhope (this|you)('s| is| are)? ?(finds you )?(well|doing well)\b/i,
    why: "filler opener",
  },
  {
    pattern: /\bpick your brain\b/i,
    why: "asks for unpaid time without offering anything",
  },
  {
    pattern: /\bcame across your profile\b/i,
    why: "says nothing; everyone came across the profile",
  },
  {
    pattern: /\b(reaching out|wanted to reach out)\b/i,
    why: "narrates the act of messaging instead of the reason for it",
  },
  {
    pattern: /\blooking forward to (hearing|your)\b/i,
    why: "closing filler",
  },
  {
    pattern: /\b(making strides|at the forefront|doing (great|amazing|exciting) (work|things)|leading the way)\b/i,
    why: "flattery about the company, and usually inferred from the job title rather than known",
  },
  {
    pattern: /\bI'd love to\b/i,
    why: "softener that delays the actual ask",
  },
  {
    pattern: /\b(which )?I (believe|think|feel)\b/i,
    why: "hedges the one concrete claim in the message; state it or cut it",
  },
  {
    pattern: /\baligns?\s+(well\s+)?with\b/i,
    why: "cover-letter filler that asserts a fit instead of showing one",
  },
  {
    pattern: /\bin my (previous|prior|past) (experience|role|position)\b/i,
    why: "resume narration; name the thing you built instead",
  },
  {
    pattern: /\b(mission|vision|commitment|dedication)\s+to\b/i,
    why:
      "a claim about the company's purpose that you only know from its job ad, " +
      "and it spends the reader's attention on them instead of on your reason for writing",
  },
];

/**
 * Nouns that name a category instead of a thing.
 *
 * A question whose subject is one of these is a survey: the answer is either
 * already in the job ad or identical from every recipient alive. "What
 * qualities are you prioritizing in candidates?", "What tools or processes do
 * you find most effective?", "Do you have any insights on that?" — all real
 * closing lines, all unanswerable in a way that is specific to the sender.
 *
 * This replaced a list of banned phrasings, which did not survive contact with
 * the repair pass. `repairDraft` minimises the number of problems the critique
 * reports, so the model's cheapest move is the smallest edit that stops a
 * regex matching rather than the edit that fixes the message. On 2026-10-01 a
 * draft flagged for "What qualities or experiences are you prioritizing in
 * candidates for this position?" came back from two repair passes as "What
 * **specific** skills or experiences are you prioritizing in candidates for
 * this position?" — one adjective inserted between "what" and the noun, the
 * pattern defeated, the question unchanged, and `critique_problems` recorded as
 * 0. A deny-list of surface forms fed back to its own generator is an evasion
 * trainer; the space of paraphrases is infinite and the list is not.
 *
 * So the check is structural. The question is only a problem when its subject
 * is abstract AND nothing in the question anchors it to this recipient — see
 * `askAnchors`. Adding an anchor or deleting the question are the only two ways
 * out, and both of them are the actual fix.
 */
const ABSTRACT_SUBJECT =
  /\b(advice|approaches|attributes|challenges|characteristics|experiences|factors|insights|methods|metrics|practices|processes|qualities|skills|strategies|techniques|technologies|thoughts|tips|tools|traits|trends|steps)\b/i;

/**
 * The terms that would make a question specific to this recipient: what their
 * own headline says they do, minus anything the draft was going to contain
 * anyway. Generic title words are dropped too, so "engineer" cannot anchor
 * anything.
 *
 * The company and the role used to be anchors in their own right, and that
 * quietly disabled the check on every opening message there is. RULE 2
 * *requires* an initial outreach to name both, so both were in every draft by
 * construction — a free anchor the model never had to earn. Nadia Haddad was
 * sent "What specific challenges do you see for this role at Vantage Staffing?":
 * `ABSTRACT_SUBJECT` matched "challenges", the word "Vantage Staffing" anchored it,
 * and `critique_problems` was recorded as 0. Delete her name and her employer
 * and the question is askable of every recruiter alive — which is the test RULE
 * 6 states, and exactly what the anchor set was waving through.
 *
 * This is the lesson `repeatsThread` already learned and wrote down — what the
 * draft is obliged to say must be excluded from every check that measures what
 * the draft chose to say — applied in the one place it had been missed.
 *
 * `required` is subtracted from the headline, not merely withheld from the
 * anchor list, and that is the whole fix rather than a tidy-up. A LinkedIn
 * headline usually *leads* with the employer: hers is "Recruiter @ Vantage Staffing
 * UAE | IT Recruitment…", so dropping the company as a direct anchor changed
 * nothing at all — it came straight back through her own tagline and the check
 * stayed silent on the draft it was written for.
 *
 * The cost is real and accepted: a genuinely pointed question whose only
 * distinctive term is the employer ("…for Vector AI's public-sector rollout")
 * is now flagged if it also reaches for a category noun. Both ways out — name
 * something that is theirs, or drop the question and end on the fact — are
 * improvements, and `ABSTRACT_SUBJECT` is a 25-word list that a specific
 * question usually avoids without trying.
 */
export function askAnchors(
  headline: string | null,
  required: { roleTitle?: string | null; company?: string | null } = {},
): string[] {
  const obliged = requiredWords(required.roleTitle, required.company);
  return [
    ...new Set(
      distinctiveTitleWords(headline ?? "")
        .filter((word) => !obliged.has(word))
        // A category noun cannot anchor a question to a person, even when the
        // recipient put it in their own headline. Nikos Pallas's headline is
        // "Recruitment Manager | Matching Skills to Opportunities | FinTech", so
        // without this line her own tagline anchors "What specific skills are
        // you prioritizing in candidates?" and the check goes quiet on the exact
        // draft it exists to stop.
        .filter((word) => !ABSTRACT_SUBJECT.test(word)),
    ),
  ];
}

function anchored(ask: string, anchors: string[]): boolean {
  const words = new Set(ask.toLowerCase().split(/[^a-z0-9+#.]+/));
  return anchors.some((anchor) => words.has(anchor));
}

export interface DraftCritique {
  problems: string[];
}

/**
 * Vocabulary only someone who builds or runs the system can speak to.
 *
 * RULE 1 of the system prompt — stay inside the recipient's job — is the rule
 * the model breaks most often and the one that most obviously marks a message
 * as mass-produced, yet it was the only rule with no enforcement behind it. An
 * HR Coordinator was asked "how your team measures the success of AI
 * implementations"; there is no answer she could give.
 */
/*
 * Stems, not exact nouns. The noun forms alone let the exact failure this
 * constant exists to stop walk straight through: a recruiter who sources Oracle
 * consultants was asked "what is the biggest challenge your team faces when
 * implementing Oracle Fusion HCM solutions". `implementations?` does not match
 * "implementing", so nothing fired — and a recruiter was asked a delivery
 * question she has no way to answer, which is the single clearest tell that a
 * message was mass-produced.
 *
 * The configure/integrate/migrate/roll-out family is here for the same reason:
 * on a functional-consultant job search those are the words a delivery question
 * actually gets phrased in, and every one of them is outside a recruiter's job.
 */
const OUT_OF_REMIT =
  /\b(latency|throughput|inference|model(s|ling|ing)?|architect\w*|pipelines?|infrastructure|scalab\w+|deploy\w*|tech(nical)?\s+stack|codebase|embeddings?|retrieval|fine[\s-]?tun\w*|benchmark\w*|tokens?|gpus?|kubernetes|schemas?|algorithms?|optimi[sz]\w*|technical\s+debt|system\s+design|implement\w*|integrat\w*|migrat\w*|configur\w*|customi[sz]\w*|roll[\s-]?out|trade[\s-]?offs?)\b/i;

/** What each of these recipients *can* answer, used to make the fix actionable. */
const REMIT: Partial<Record<Persona, string>> = {
  Technical_Recruiter:
    "what they can answer is the hiring bar, the process, the timeline and what " +
    "the team says it is looking for",
  Adjacent_Employee:
    "what they can answer is what they see from their own side of the company — " +
    "what users or colleagues bring them, and what keeps coming back",
};

/**
 * @param recipientFirstName Used to check the message is addressed to someone.
 * @param roleTitle          The role the user applied to, when one is linked.
 *   A first message that never names it gives the recipient no way to place
 *   the sender.
 * @param persona            Who the recipient is. Supplied, the question is
 *   checked against what that person could actually answer.
 * @param evidence           The retrieved resume chunks the draft was built
 *   from. Supplied, every figure in the draft is checked against them.
 * @param priorMessages      What this recipient has already been sent, oldest
 *   first. Supplied, the draft is checked for reusing their question, their
 *   figures or their claims — the failure that made a follow-up read as a
 *   second opener.
 * @param company            The recipient's employer. Excluded from the
 *   repetition check, which the draft is required to name, and used to explain
 *   an unanchored question.
 * @param anchors            Terms that would make a question specific to this
 *   recipient, from `askAnchors`. Without them an abstract question cannot be
 *   distinguished from a pointed one, so the check stays silent.
 * @param jdText             The job description, as much of it as the model was
 *   shown. Supplied, the draft's claims are checked for being the advert read
 *   back to the person who wrote it.
 */
export function critiqueDraft(
  draft: string,
  context: {
    recipientFirstName: string;
    roleTitle?: string | null;
    persona?: Persona | null;
    evidence?: string[];
    priorMessages?: string[];
    company?: string | null;
    anchors?: string[];
    jdText?: string | null;
  },
): DraftCritique {
  const problems: string[] = [];

  for (const { pattern, why } of BANNED) {
    const hit = draft.match(pattern);
    if (hit) problems.push(`Remove "${hit[0]}" — ${why}.`);
  }

  if (draft.includes("!")) {
    problems.push("Remove the exclamation mark; it reads as sales copy.");
  }

  const questions = (draft.match(/\?/g) ?? []).length;
  if (questions > 1) {
    problems.push(
      `There are ${questions} questions. Keep the single best one and cut the rest — ` +
        "a stranger answers one question or none.",
    );
  }

  const first = context.recipientFirstName.trim();
  if (first && !new RegExp(`\\b${escapeRegExp(first)}\\b`, "i").test(draft)) {
    problems.push(`Open with their first name, ${first}.`);
  }

  if (context.roleTitle && !mentionsRole(draft, context.roleTitle)) {
    problems.push(
      `Name the role you applied to (${context.roleTitle}). Without it the ` +
        "recipient has no idea why you are in their inbox.",
    );
  }

  for (const value of ungroundedNumbers(draft, context.evidence ?? [])) {
    problems.push(
      `The figure ${value} appears nowhere in the retrieved resume text. Use the ` +
        "exact number the resume gives, or drop the claim — do not round it and " +
        "do not estimate one.",
    );
  }

  problems.push(...misattributedFigures(draft, context.evidence ?? []));

  const remit = context.persona ? REMIT[context.persona] : undefined;
  const jargon = remit ? askText(draft).match(OUT_OF_REMIT) : null;
  if (remit && jargon) {
    problems.push(
      `Your question asks about "${jargon[0]}", which is outside a ` +
        `${context.persona?.replace(/_/g, " ")}'s job — ${remit}. Ask that instead.`,
    );
  }

  const ask = askText(draft);
  const abstract = ask.match(ABSTRACT_SUBJECT);
  if (abstract && !anchored(ask, context.anchors ?? [])) {
    problems.push(
      `Your question is about "${abstract[0]}", which is a category rather than a ` +
        "thing, and nothing in the question ties it to this recipient — it would " +
        "read identically to anyone at any company, so the answer tells you " +
        "nothing and writing it earns them nothing. Naming the company or the " +
        "role does not fix it — you were required to name those anyway, so they " +
        "are in every message you send. Either ask about something specific this " +
        "person said or did, or delete the question entirely and end on your " +
        "fact. Deleting it is better than rewording it.",
    );
  }

  problems.push(
    ...repeatsThread(draft, context.priorMessages ?? [], context.roleTitle, context.company),
  );

  problems.push(
    ...echoesJobDescription(draft, context.jdText, {
      evidence: context.evidence ?? [],
      roleTitle: context.roleTitle,
      company: context.company,
    }),
  );

  return { problems };
}

/** Words that carry no identity, so sharing them is not evidence of repetition. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with",
  "about", "how", "what", "that", "this", "these", "those", "your", "you", "my", "i",
  "is", "are", "was", "were", "be", "been", "am", "do", "does", "did", "have", "has",
  "had", "it", "its", "their", "they", "them", "we", "our", "us", "me", "as", "by",
  "from", "into", "than", "then", "so", "if", "not", "no", "any", "all", "can", "could",
  "would", "will", "team", "teams", "role", "work", "working", "curious", "wanted",
  "recently", "applied", "application", "follow", "up", "regarding", "share", "like",
]);

function contentWords(text: string, exclude: ReadonlySet<string>): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    // A dot is kept inside a token so "node.js" survives, which also means a
    // sentence-final "team." arrives with the dot attached and misses the
    // stopword set. Trim the edges before comparing.
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !exclude.has(w));
}

/** Overlapping runs of three content words, which is where a reused phrase shows. */
function trigrams(words: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(words.slice(i, i + 3).join(" "));
  return out;
}

/** The sentences that are not the ask — i.e. the claims made about the sender. */
function claimText(draft: string): string {
  return draft
    .split(/(?<=[.?!])\s+/)
    .filter((s) => !s.includes("?") && !/\byour?\b/i.test(s))
    .join(" ");
}

/**
 * Ways the draft repeats something the recipient has already read from you.
 *
 * ADR-048 put the thread in the prompt and told the model not to reuse the
 * opening, the evidence or the question. It did all three anyway, six days
 * apart and visible in one scroll:
 *
 *   opener    "…how does your team ensure that the AI solutions you build are
 *              aligned with the specific needs of government clients?"
 *   follow-up "…how does your team ensure the solutions you create are
 *              effectively tailored to meet the unique needs of government
 *              clients?"
 *
 * That is the lesson the rest of this file already learned: a rule stated in
 * the system prompt is a preference, and only a check with a repair pass behind
 * it is a rule. Repetition was the one quality rule with no check.
 *
 * The role title is excluded from every comparison. RULE 2 *requires* the
 * follow-up to name the role the opener named, so counting that as repetition
 * would make the critique unsatisfiable — the failure mode that already cost
 * this codebase a looping repair pass once.
 */
export function repeatsThread(
  draft: string,
  priorMessages: string[],
  roleTitle?: string | null,
  company?: string | null,
): string[] {
  if (priorMessages.length === 0) return [];

  const problems: string[] = [];
  // The role and the employer are both things the draft is expected to name, so
  // sharing them with the opener is compliance, not repetition.
  const exclude = requiredWords(roleTitle, company);
  const prior = priorMessages.join("\n");

  // A figure you have already sent them is not new evidence by definition.
  const repeated = numbersIn(draft).filter((n) => numbersIn(prior).includes(n));
  if (repeated.length > 0) {
    problems.push(
      `You already told them ${repeated.join(" and ")} in an earlier message. ` +
        "Use a different fact from the resume, or make the message carry no figure at all.",
    );
  }

  // The same question in new words. Compared against the ask alone, because the
  // ask is the part the recipient is being asked to act on twice.
  const newAsk = contentWords(askText(draft), exclude);
  if (newAsk.length >= 4) {
    for (const message of priorMessages) {
      const oldAsk = new Set(contentWords(askText(message), exclude));
      if (oldAsk.size === 0) continue;
      const shared = newAsk.filter((w) => oldAsk.has(w));
      // Absolute count first, ratio second. A ratio alone rewards padding and
      // punishes brevity, which is backwards here because the repair pass makes
      // the ask *shorter*: "how does your team ensure that the AI solutions you
      // build are aligned with the specific needs of government clients" came
      // back as "how does your team approach gathering feedback during the
      // development of AI solutions for government clients" — the same question
      // about the same object, but only 3 of 8 words shared, so a 50% threshold
      // waved it through. Three distinctive words in common is a shared subject.
      if (shared.length >= 3 || shared.length / newAsk.length >= 0.5) {
        problems.push(
          "This is the question you already asked, reworded " +
            `(both turn on "${[...new Set(shared)].slice(0, 5).join('", "')}"). ` +
            "They did not answer it, so asking it again gives them nothing new to " +
            "reply to. Acknowledge that you asked, then ask something narrower — or " +
            "send no question and make the message one piece of new information.",
        );
        break;
      }
    }
  }

  // The same evidence in new words. A shared three-content-word run is a phrase
  // being reused, not two sentences happening to share vocabulary: "LLM
  // applications that are actively used by non-technical operators" came back
  // as "LLM applications that non-technical operators use monthly".
  const newClaim = trigrams(contentWords(claimText(draft), exclude));
  if (newClaim.size > 0) {
    for (const message of priorMessages) {
      const oldClaim = trigrams(contentWords(claimText(message), exclude));
      const shared = [...newClaim].filter((g) => oldClaim.has(g));
      if (shared.length > 0) {
        problems.push(
          `"${shared[0]}" is the same claim you made in an earlier message. The ` +
            "strongest evidence has been spent; use the next piece of retrieved " +
            "evidence they have not seen.",
        );
        break;
      }
    }
  }

  return problems;
}

/**
 * Figures in the draft that appear in none of the retrieved chunks.
 *
 * Everything else here is a matter of taste; this one is a matter of truth. The
 * recipient can hold the message next to the resume attached to the same
 * application, so a rounded or invented metric is the one failure the user
 * cannot recover from — and rounding is the likely form of it, because a model
 * asked for a short message will turn "32,330 lines" into "over 30,000".
 *
 * An empty corpus is the STRICTEST case, not an exemption. This used to return
 * `[]` when no evidence was retrieved, on the reasoning that an unverifiable
 * claim is not the same as a false one. That reasoning is backwards, and it
 * shipped the worst draft this system has produced: with no resume indexed for
 * the job, a message to a technical recruiter claimed the sender had "improved
 * time-to-fill by 30% through targeted outreach" — a recruiter's job
 * description, invented wholesale and sent under the user's name.
 *
 * With zero retrieved chunks the model has no source for any figure, so every
 * figure in the draft is necessarily invented. That is precisely when the check
 * is most needed, and precisely when it was switched off.
 */
export function ungroundedNumbers(draft: string, evidence: string[]): string[] {
  const known = new Set(numbersIn(evidence.join(" ")));
  return numbersIn(draft).filter((value) => !known.has(value));
}

/** Thousands separators dropped, so "32,330" and "32330" are the same number. */
export function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.?!])\s+/).filter((s) => s.trim().length > 0);
}

const NO_WORDS: ReadonlySet<string> = new Set<string>();

/**
 * Content words with the digits thrown away.
 *
 * `contentWords` splits on punctuation, so "840,000" arrives as the two tokens
 * "840" and "000" and both survive the length filter. Left in, a stolen figure
 * votes for the passage it was stolen from — and votes harder the longer the
 * number is, so the clearest thefts were the ones that went unreported. What a
 * sentence is *about* is its prose, never its arithmetic.
 *
 * Numbers are also meaningless to the echo check below: a job ad and a resume
 * sharing "5" says nothing about where a phrase came from.
 */
function prose(text: string, exclude: ReadonlySet<string> = NO_WORDS): string[] {
  return contentWords(text, exclude).filter((w) => !/^[\d.]+$/.test(w));
}

/** The words a draft is *obliged* to contain, which therefore prove nothing. */
function requiredWords(roleTitle?: string | null, company?: string | null): Set<string> {
  return new Set(
    `${roleTitle ?? ""} ${company ?? ""}`
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter(Boolean),
  );
}

/**
 * Phrases the draft took from the job advert rather than from the resume.
 *
 * Every grounding check in this file asks whether a claim is *true*. None asked
 * where its words came from, and that is the gap a recruiter sees first. The
 * message to Nadia Haddad, an agency recruiter, said the candidate had "over 5
 * years of experience developing and deploying AI solutions in production
 * environments". Her own advert says "3–5 years of experience developing and
 * deploying AI or machine-learning solutions in production environments". She
 * posted that sentence; it came back to her with a number attached. Three of
 * the draft's four sentences were built that way, every figure in it was
 * grounded, and the review recorded no problems at all.
 *
 * It is also how a draft launders a claim past `ungroundedNumbers`. That check
 * sees only digits, so a resume's "5+ years running production *enterprise
 * systems*" can be re-tagged with the advert's "*AI solutions* in production
 * environments" and the "5" still matches. The number survives, the noun it
 * belonged to is swapped, and nothing fires.
 *
 * Structural, for the reason recorded on `ABSTRACT_SUBJECT`: a list of
 * forbidden advert phrasings fed back to its own generator is an evasion
 * trainer. A shared run of three content words is a phrase being carried over,
 * not two texts about the same job happening to share vocabulary.
 *
 * Three exclusions keep it satisfiable, and all three are load-bearing:
 *
 *  - The role title and the employer. RULE 2 requires the draft to name both,
 *    and the advert names both, so counting them would make the check
 *    impossible to pass. Same rule as `repeatsThread` and `askAnchors`.
 *  - Anything already in the retrieved resume text. A candidate for an AI role
 *    legitimately writes "retrieval-augmented generation", and so does the ad.
 *    Punishing a phrase the resume actually contains would push the model off
 *    its own evidence, which is the opposite of what the rest of this file is
 *    for.
 *  - The question. A closing line that quotes the advert — "you mentioned
 *    free-zone experience is preferred" — is the draft proving it read the
 *    thing, and RULE 6 asks for exactly that. The damage is done in the claims,
 *    where the advert's words get worn as the candidate's history.
 *
 * @param jdText As much of the advert as the model was actually shown. Checking
 *   against text that was never in the prompt would report coincidences.
 */
export function echoesJobDescription(
  draft: string,
  jdText: string | null | undefined,
  options: {
    evidence?: string[];
    roleTitle?: string | null;
    company?: string | null;
  } = {},
): string[] {
  if (!jdText?.trim()) return [];

  const exclude = requiredWords(options.roleTitle, options.company);
  const advert = trigrams(prose(jdText, exclude));
  if (advert.size === 0) return [];

  const owned = trigrams(prose((options.evidence ?? []).join("\n"), exclude));
  const carried = [...trigrams(prose(claimText(draft), exclude))].filter(
    (run) => advert.has(run) && !owned.has(run),
  );
  if (carried.length === 0) return [];

  // One problem, however many runs matched. `repairDraft` ranks rewrites by
  // problem count, so reporting five fragments of one sentence would let a
  // rewrite that deleted a single clause outscore one that actually rephrased
  // the claim.
  return [
    `"${carried.slice(0, 3).join('", "')}" ${carried.length === 1 ? "is a phrase" : "are phrases"} ` +
      "lifted from the job description, not from your resume. The recipient " +
      "wrote or posted that ad and will recognise their own words, which is the " +
      "clearest sign a message was generated. Say what you actually did, in the " +
      "resume's wording, or cut the sentence.",
  ];
}

/** How much better the claim must fit another passage before it counts as theft. */
const ATTRIBUTION_MARGIN = 2;

/**
 * Figures that are real but have been attached to the wrong piece of work.
 *
 * `ungroundedNumbers` asks only whether a figure appears *somewhere* in the
 * evidence, never whether it belongs to the claim being made around it. On a
 * resume whose chunks each held several unrelated bullets, the agent welded a
 * CSAT figure from a support project onto an Oracle Fusion rollout with the
 * word "along with", and every grounding check in the system passed it: the
 * number was in the evidence, so nothing fired. The recipient reads one
 * sentence asserting a causal link the resume never made.
 *
 * The test is which passage the sentence is *about*. If the sentence's
 * distinctive words match some chunk clearly better than they match any chunk
 * actually containing the figure, the figure has been moved. "Clearly better"
 * is an absolute margin rather than a ratio, for the reason recorded on
 * `repeatsThread`: the repair pass shortens text, so a ratio gets easier under
 * exactly the pressure meant to tighten it.
 *
 * Deliberately conservative. Both ways out — drop the figure, or rewrite the
 * claim to describe the work the figure came from — are genuine fixes, but a
 * check that fires on an honest draft burns both repair passes and the rewrite
 * is discarded for not reducing the problem count.
 */
export function misattributedFigures(draft: string, evidence: string[]): string[] {
  if (evidence.length < 2) return [];

  const chunkWords = evidence.map((chunk) => new Set(prose(chunk)));
  const problems: string[] = [];
  const reported = new Set<string>();

  for (const sentence of sentencesOf(draft)) {
    const figures = numbersIn(sentence).filter((f) => !reported.has(f));
    if (figures.length === 0) continue;

    const subject = [...new Set(prose(sentence))];
    if (subject.length < 3) continue;

    const overlap = chunkWords.map((words) => subject.filter((w) => words.has(w)).length);
    const best = overlap.indexOf(Math.max(...overlap));

    for (const figure of figures) {
      const owners = evidence.flatMap((chunk, i) =>
        numbersIn(chunk).includes(figure) ? [i] : [],
      );
      // Not in the evidence at all is a different, louder problem.
      if (owners.length === 0 || owners.includes(best)) continue;

      const ownerBest = Math.max(...owners.map((i) => overlap[i]!));
      if (overlap[best]! < ATTRIBUTION_MARGIN) continue;
      if (overlap[best]! - ownerBest < ATTRIBUTION_MARGIN) continue;

      reported.add(figure);
      problems.push(
        `The figure ${figure} is real, but it belongs to a different piece of ` +
          `work: the resume reports it under "${firstLine(evidence[owners[0]!]!)}", ` +
          `while this sentence is about "${firstLine(evidence[best]!)}". Either ` +
          "write the claim about the work the figure actually came from, or drop " +
          "the figure — do not join two unrelated results into one sentence.",
      );
    }
  }

  return problems;
}

/** The section header a chunk carries, which is what names the work it describes. */
function firstLine(chunk: string): string {
  return chunk.split("\n")[0]!.slice(0, 60).trim();
}

/**
 * Sections that restate results instead of recording them.
 *
 * Matched on the header `chunkResumeText` prefixes to every chunk (ADR-052). A
 * chunk with no header — every row indexed before that change — matches
 * nothing, so an un-reindexed resume simply gets no opinion rather than a wrong
 * one.
 */
const SUMMARY_SECTION =
  /^(professional\s+summary|executive\s+summary|career\s+summary|summary|profile|professional\s+profile|about(\s+me)?|objective|career\s+objective)\b/i;

export function isSummaryChunk(chunk: string): boolean {
  return SUMMARY_SECTION.test(firstLine(chunk));
}

/**
 * Figures the evidence can locate but cannot vouch for.
 *
 * `misattributedFigures` compares chunks against each other, so it is blind to
 * a figure whose only source is one chunk — and a summary paragraph is the
 * worst possible chunk for that, because it is where every headline number sits
 * next to every skill with the work that earned it stripped out. It is also,
 * being a dense restatement of the whole resume, the chunk retrieval ranks
 * first more often than any other.
 *
 * Nadia Haddad's draft is the live case. The resume earns its CSAT under "led
 * weekly stakeholder reviews through six weeks of go-live support, explaining
 * SQR / PeopleCode logic in plain language"; the draft wrote "I'm particularly
 * skilled in Python and SQL, and have built systems that maintain client
 * satisfaction above 9.5/10". Only the summary chunk was retrieved. Every check
 * passed, and each was right: the figure is in the evidence, and the one chunk
 * holding it is also the chunk the sentence most resembles.
 *
 * So this reports a state, not a fault, and it is deliberately NOT a critique
 * problem. The repair pass has the same evidence and therefore cannot verify
 * the attribution either; all it could do is delete the figure, and RULE 4
 * requires the message to carry exactly one concrete fact. Feeding both
 * instructions to one loop is how a critique becomes unsatisfiable — the
 * mistake this file has already made twice. It belongs on the record, in front
 * of the person who can open the resume and look.
 */
export function summaryOnlyFigures(draft: string, evidence: string[]): string[] {
  const summaries = evidence.filter(isSummaryChunk);
  if (summaries.length === 0) return [];

  const inSummary = new Set(numbersIn(summaries.join(" ")));
  const inBody = new Set(
    numbersIn(evidence.filter((chunk) => !isSummaryChunk(chunk)).join(" ")),
  );

  return [...new Set(numbersIn(draft))].filter(
    (figure) => inSummary.has(figure) && !inBody.has(figure),
  );
}

/**
 * Hedges a model reaches for when it rounds. Dropped along with the rounding,
 * because "over 32,330" turns a true approximation into a false exact claim.
 */
const HEDGED_FIGURE =
  /\b(?:(?:over|more than|around|about|approximately|nearly|roughly|almost|upwards of|north of)\s+)?(\d[\d,]*(?:\.\d+)?)/gi;

/** Rounding a year is not rounding a metric; "2021" must survive untouched. */
const YEAR = /^(19|20)\d\d$/;

/** How far a figure may sit from the resume's and still be a rounding of it. */
const ROUNDING_TOLERANCE = 0.1;

/** How many tokens after a figure are read as saying what it measures. */
const UNIT_WINDOW = 4;

/**
 * The tokens that follow each occurrence of `figure` in `text` — what the
 * figure is a count *of*.
 *
 * Numbers are kept here, unlike `prose`. A denominator is exactly the kind of
 * unit this has to compare — "9.5/10" against "9 out of 10" share only the
 * "10" — and throwing digits away would leave a ratio with no unit at all.
 */
function measuredIn(text: string, figure: string): Set<string> {
  const out = new Set<string>();
  const pattern = /\d[\d,]*(?:\.\d+)?/g;

  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    if (m[0].replace(/,/g, "") !== figure) continue;
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
    const tokens = after
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .map((t) => t.replace(/^\.+|\.+$/g, ""))
      .filter(Boolean)
      .slice(0, UNIT_WINDOW);
    for (const token of tokens) {
      if (!STOPWORDS.has(token)) out.add(token);
    }
  }

  return out;
}

/**
 * Whether the draft and the resume are counting the same kind of thing.
 *
 * `isRoundingOf` compares magnitudes, and magnitude alone cannot tell "about
 * 30 seconds" from a resume's "31 days": one candidate, 3% apart, same digit
 * count, same leading digit, rounder. Every numeric test passes and the
 * substitution writes a precise figure into a claim the resume never made —
 * the one way this function can manufacture a false statement rather than
 * merely fail to fix a true one.
 *
 * `misattributedFigures` already encodes the rule being broken: a figure means
 * nothing apart from the work it was earned on. That check compares whole
 * chunks against each other and so goes quiet on a single chunk, which is
 * precisely the case above. The unit is the part of that reasoning which
 * survives with one chunk and one sentence.
 *
 * Silence on either side means "cannot tell", and cannot-tell does not edit.
 */
function measuresTheSameThing(
  draft: string,
  drafted: string,
  evidence: string,
  source: string,
): boolean {
  const draftUnit = measuredIn(draft, drafted);
  const sourceUnit = measuredIn(evidence, source);
  if (draftUnit.size === 0 || sourceUnit.size === 0) return false;
  for (const token of draftUnit) {
    if (sourceUnit.has(token)) return true;
  }
  return false;
}

/**
 * Put the resume's exact figure back where the model rounded it.
 *
 * Three defences have already failed at this. The system prompt forbids
 * rounding and the model rounds anyway. `ungroundedNumbers` catches it but can
 * only report it. `repairDraft` feeds that report back and ranks the rewrites,
 * and the model's cheapest response is to delete the sentence carrying the
 * figure — which is why faithfulness sat at 0.833 while `critique_problems`
 * read 0: the draft got past the check by having nothing left to check.
 *
 * The edit is mechanical, so make it mechanically. A figure is treated as a
 * rounding of a resume figure when it is within ten percent of it, is *rounder*
 * — more trailing zeros, or fewer decimals — and is counting the same thing.
 * Two candidates means the substitution is a guess, so nothing is done and the
 * critique stays in charge.
 *
 * That last condition is not decoration. This is the only function in the file
 * that *edits* rather than reports, so it is the only one whose failure mode is
 * a false claim rather than a missed one, and the numeric tests alone cannot
 * see the difference between rounding "32,330 employees" and importing "31
 * days" into a sentence about seconds. See `measuresTheSameThing`.
 */
export function repairFigures(draft: string, evidence: string[]): string {
  const corpus = evidence.join(" ");
  const known = numbersIn(corpus);
  if (known.length === 0) return draft;

  const exact = new Set(known);
  const sources = [...new Set(known)].map(Number).filter((n) => Number.isFinite(n) && n > 0);

  return draft.replace(HEDGED_FIGURE, (match: string, literal: string) => {
    const normalized = literal.replace(/,/g, "");
    if (exact.has(normalized) || YEAR.test(normalized)) return match;

    const drafted = Number(normalized);
    if (!Number.isFinite(drafted) || drafted <= 0) return match;

    const candidates = sources.filter((source) => isRoundingOf(normalized, String(source)));
    if (candidates.length !== 1) return match;

    const exactValue = candidates[0]!;
    if (!measuresTheSameThing(draft, normalized, corpus, String(exactValue))) return match;

    return literal.includes(",") ? exactValue.toLocaleString("en-US") : String(exactValue);
  });
}

/**
 * Whether `drafted` is what you get by rounding `source`.
 *
 * The magnitude test is what keeps this from being a nearest-neighbour search
 * over every number on the resume: rounding never changes how many digits sit
 * before the decimal point, and never changes the leading one. Without it a
 * draft saying "100 hours" would be rewritten to "96 hours" because the resume
 * happened to mention 96 candidates somewhere.
 */
function isRoundingOf(drafted: string, source: string): boolean {
  const a = Number(drafted);
  const b = Number(source);
  if (a === b) return false;
  if (Math.abs(a - b) / b > ROUNDING_TOLERANCE) return false;

  const integerPart = (n: string) => n.split(".")[0]!;
  if (integerPart(drafted).length !== integerPart(source).length) return false;
  if (integerPart(drafted)[0] !== integerPart(source)[0]) return false;

  const zeros = (n: string) => integerPart(n).match(/0+$/)?.[0].length ?? 0;
  const decimals = (n: string) => n.split(".")[1]?.length ?? 0;
  return zeros(drafted) > zeros(source) || decimals(drafted) < decimals(source);
}

/**
 * The sentences that put something to the recipient — a question mark, or
 * anything said about "you" or "your team".
 *
 * Scoping to these keeps the check off the sender's own claims, which are
 * allowed to be as technical as the resume is: "I designed LLM-driven
 * solutions" is a fact about the candidate, while "how your team measures the
 * success of AI implementations" is a question only an engineer could field.
 * Note that the ask is frequently not punctuated as a question at all — the
 * observed draft phrased it as "I'm curious about how your team…".
 */
function askText(draft: string): string {
  return draft
    .split(/(?<=[.?!])\s+/)
    .filter((sentence) => sentence.includes("?") || /\byour?\b/i.test(sentence))
    .join(" ");
}

/**
 * Words that appear in every second job title. Matching on these would let
 * "engineer" alone count as having named the role.
 */
const GENERIC_TITLE_WORDS = new Set([
  "senior", "staff", "principal", "lead", "junior", "mid", "level",
  "engineer", "engineering", "developer", "software", "manager",
  "specialist", "analyst", "consultant", "the", "and", "for",
  "remote", "hybrid", "onsite", "contract", "i", "ii", "iii", "sr", "jr",
]);

/** How far apart the title's distinctive words may drift and still be a phrase. */
const TITLE_PHRASE_SLACK = 24;

/**
 * Titles get paraphrased legitimately — "Senior Engineer, Kafka Platform"
 * becomes "the Kafka platform role" — so match the title's distinctive words
 * rather than the literal string.
 *
 * They must appear *together and in order*, though, not merely be present
 * somewhere. Scoring individual words let a draft that said "AI-LLM
 * technologies" in one sentence and "passionate about AI systems" in another
 * pass a check for "AI/LLM Systems Engineer" — it had scattered the title
 * across two pieces of filler without ever telling the recipient which job the
 * sender applied to, which is the entire point of the check.
 */
function mentionsRole(draft: string, title: string): boolean {
  // Only the head of the title is required. Postings qualify a role with a team
  // or product after a comma or dash — "Senior Backend Engineer, Payments
  // Platform" — and nobody writes the full requisition title into a 300
  // character note. Demanding the qualifier made the check unsatisfiable:
  // drafts that said "the Senior Backend Engineer role at Meridian Pay" were
  // flagged, the repair pass rewrote them, the rule fired again, and the repair
  // was discarded for not reducing the problem count.
  // Split on a comma or a *spaced* dash only. A bare hyphen is part of the role
  // itself far more often than it is a separator ("Full-Stack Engineer").
  const distinctive = distinctiveTitleWords(
    title.split(/,|\s[-\u2013\u2014]\s/)[0] ?? "",
  );

  // A head made only of generic words ("Software Engineer, Payments Platform")
  // carries no signal on its own, so fall back to the whole title rather than
  // waving the draft through.
  const required = distinctive.length > 0 ? distinctive : distinctiveTitleWords(title);

  // A title that is generic end to end ("Senior Software Engineer") cannot be
  // checked this way; accept rather than demand an impossible edit.
  if (required.length === 0) return true;

  const phrase = required
    .map(escapeRegExp)
    .join(`[\\s\\S]{0,${TITLE_PHRASE_SLACK}}?`);

  return new RegExp(phrase, "i").test(draft);
}

function distinctiveTitleWords(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((word) => word.length > 2 && !GENERIC_TITLE_WORDS.has(word));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
