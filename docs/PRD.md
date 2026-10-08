# Product Requirements Document

## Product

**AI-Native Job Search CRM & Networking Copilot**

A Chrome extension (Manifest V3) plus a local proxy backend that watches you
apply for jobs, files the exact resume you sent, maps the LinkedIn people you
connect with onto those applications, and drafts outreach grounded in your own
resume text.

## Problem

Job hunting fails at the seams between four different jobs, none of which is
the actual job of being good at the work:

1. **Bookkeeping.** You apply on LinkedIn, on Greenhouse, on Workday, on a
   careers page nobody has heard of. Two weeks later you cannot remember which
   companies you applied to, when, or with which CV. The spreadsheet is always
   out of date because updating it is a separate act from applying.
2. **Version control for your own resume.** Everyone tailors their CV per role
   and ends up with `resume(3).pdf`, `resume_final.pdf`, `resume_final_v2.pdf`.
   When a recruiter calls, you cannot tell which version they are holding.
3. **Networking that goes nowhere.** Connecting with people at a company is the
   single highest-leverage thing a candidate can do, and the message that
   follows is almost always a template. "I'm passionate about what you're
   building" is instantly recognisable as mass-produced, and it is ignored.
4. **Follow-up discipline.** The reply rate on a first message is low. The
   reply rate on a well-timed second message is materially higher. Almost
   nobody sends the second message, because doing so requires remembering, on
   the right day, for each of forty people.

The common cause is that every one of these is *manual bookkeeping performed
at the worst possible moment* — while you are in the middle of doing something
else.

## Target users

Individual software engineers running an active job search, who:

- apply across LinkedIn **and** external ATS platforms,
- tailor their resume per application,
- use LinkedIn networking as part of the search,
- are technical enough to run a local Node process and load an unpacked
  extension.

This is explicitly a **single-user, local-first tool**. It is not multi-tenant
and has no account system. One person, one proxy, one database.

## Goal

Make the CRM a **byproduct of applying**, not a second task.

Every record in the system should be created by an action the user was going to
take anyway — clicking Submit, clicking Connect, opening a profile. The user's
only deliberate act should be the one thing that genuinely requires judgement:
approving a message before it is sent.

## Core features

The five features are numbered throughout the codebase; comments say
"Feature 3" and mean this list.

### Feature 1 — Autonomous application tracking

Detect a job application at the moment it is submitted and record company,
title, location, URL, and the full job description text.

Two paths:

- **LinkedIn Easy Apply.** The submission completes on the page, so it is
  tracked directly from the DOM.
- **External ATS.** The user leaves LinkedIn for a company's own careers site.
  The job description exists only in the LinkedIn tab's DOM, so it is captured
  *before* navigation and parked as a "pending handshake", then committed when
  the ATS page shows a genuine success signal.

Sites where a submit cannot be detected fall back to an explicit **"I applied"**
confirmation in the side panel rather than silently losing the application.

### Feature 2 — Document Vault

Capture the exact PDF attached to each application, store it, and rename it to
a canonical `<Name>_<Company>_<Role>.pdf` so the vault is legible without
opening anything. Extract its text, chunk it, and embed it so drafting can
quote it later.

One resume per application, enforced in the schema. Re-uploading replaces the
previous file **and** its vectors, so a draft can never cite a resume that was
not actually sent.

### Feature 3 — Asynchronous entity mapping

When the user connects with someone on LinkedIn, resolve their employer and
fuzzy-match it against tracked applications.

The match must be **order-independent**: connecting three days before you apply
must resolve identically to connecting three days after. This is why the match
runs on *both* events — contact capture and job creation — and again if a later
profile visit reveals an employer that was unknown at capture time.

Exactly one matching application auto-links. Two or more raise a
disambiguation prompt. Zero means "general networking". The system never
guesses between two applications at the same company.

### Feature 4 — Persona-aware outreach drafting (RAG + agent)

Generate a message that *this specific recipient* would plausibly reply to.

- Classify the recipient into one of five personas from their headline.
- Retrieve evidence from the resume submitted **for that application**, using
  hybrid search (dense vector + sparse full-text, fused).
- Write one message: names the role applied to, contains exactly one concrete
  fact from the resume, asks exactly one question the recipient could actually
  answer given their job.
- Machine-check the result and repair it once.

The same candidate, applying to the same job, must not produce the same message
for a CTO, a recruiter and a support coordinator. If it does, the feature has
failed even if every sentence is true.

### Feature 5 — Connection polling and the follow-up engine

Detect when an invitation is accepted and when a contact replies, then drive a
state machine:

```
Pending ──accepted──> Accepted ──replied──> Replied   (terminal)
                         │
                  no reply for N days
                         ▼
               Follow_Up_Required ──replied──> Replied
```

Entering `Accepted` writes an outreach draft automatically. Entering
`Follow_Up_Required` writes a follow-up draft automatically. The user finds a
message waiting, rather than having to notice the acceptance first — which is
the exact thing they cannot reliably do.

Detection must never visit a contact's profile: LinkedIn reports profile views
to the person viewed, so polling that way would mean pestering the exact people
the user is trying to impress.

## MVP

All five features, end to end:

- Track a LinkedIn Easy Apply submission
- Track an external ATS submission via the handshake
- Manually confirm an application the extension could not detect
- Capture and rename the submitted resume; download it back
- Chunk + embed resume text
- Capture a contact on Connect, auto-link on a single company match
- Disambiguate when several applications match
- Classify persona from headline
- Hybrid search over that application's resume
- Draft a message through the agent loop and machine-critique it
- Insert the draft into LinkedIn's composer (never send it)
- Mark a message as sent
- Detect acceptance and auto-draft outreach
- Detect N days of silence and auto-draft a follow-up
- Side panel with Jobs / Contacts / Drafts / Vault / Settings

## Out of scope

| Not building | Why |
| --- | --- |
| Clicking LinkedIn's Send button | Hard constraint. The human approves every outbound message. |
| Multi-user accounts, auth, billing | Single-user local tool by design. |
| A hosted/public deployment | The proxy holds a service-role key and an OpenAI key. It is meant to run on the user's own machine. |
| Private LinkedIn API use | Ban risk and a licence violation. DOM reads only. |
| Reply *content* drafting | Not built. See "Known gaps" below. |
| Mobile app | Chrome extension only. |
| Interview scheduling, offer comparison, salary data | Different product. |
| Generic mass outreach / sequences | Directly opposed to the point of the product. |

## Success criteria

A user should be able to:

1. Apply to a job on LinkedIn Easy Apply and find it in the Jobs tab without
   typing anything.
2. Apply on an external ATS and find it tracked, with the job description, from
   the LinkedIn posting they came from.
3. Confirm an application manually when the ATS could not be detected.
4. Open the Vault and see the attached CV renamed to
   `Arjun_Nair_Stripe_Backend_Engineer.pdf`, and download it back under that
   name.
5. Connect with someone at a company they applied to, and see that contact
   automatically linked to that application.
6. Be told, not asked, when two applications at one company make the link
   ambiguous.
7. See a contact move from **Waiting** to **Connected** without doing anything.
8. Find a drafted message already waiting when that happens.
9. Read a draft that names the role, contains a number that is actually in
   their resume, and asks a question the recipient's job makes answerable.
10. Insert that draft into LinkedIn and click Send themselves.
11. Mark it as sent and still see it — with a countdown to the follow-up.
12. Find a follow-up drafted automatically after N days of silence.

### Anti-criteria (a pass here is a failure of the product)

- A draft that would read identically if sent to anyone else at the company.
- A number in a draft that does not appear in the retrieved resume text.
- A question a recruiter or an HR coordinator could not possibly answer.
- The extension sending anything on the user's behalf.
- A screen that goes blank and says nothing about what happens next.

The first three are **measured**, not asserted. `eval:drafting` reports
cross-recipient evidence overlap (anti-criterion 1) and deterministic numeric
faithfulness (anti-criterion 2); `critiqueDraft`'s out-of-remit check plus the
`support-lead` and `hr-coordinator` retrieval cases cover anti-criterion 3. An
anti-criterion without a number attached to it is a wish.
See [EVALUATION.md](EVALUATION.md).

## Known gaps

These are **not implemented**, and the docs should not imply otherwise:

1. **Reply drafting.** `checkForReplies()` detects *that* a reply arrived and
   reports `{ linkedinUrl, replied: true }`. The reply **text is never
   captured**, and `message_type` has no reply value. Building this needs a
   Postgres enum migration, thread scraping, and agent work.
2. **Numeric faithfulness reached 1.000 on 2026-10-03, on six cases.** It sat at
   0.833 for three batches: asked for a short message, the model rendered the
   resume's `32,330` as "over 32,000", and neither the prompt rule, nor
   `critiqueDraft`, nor two repair passes asking for the exact figure moved it.
   Deterministic repair (ADR-055) plus the ADR-058…062 grounding checks did.
   Treat this as a gate cleared, **not** as a property proven: the dataset is six
   cases, so one regression is 0.167, and nothing here shows the rounding
   behaviour cannot return on a seventh. → TASK-1006.
3. **The reranker is an LLM call, not a cross-encoder.** `rag/rerank.ts` grades
   candidates with `gpt-4o-mini`. It works, and the numbers below say by how
   much, but it costs a round trip per draft and makes retrieval
   non-deterministic: the same query can return a ±1 rank wobble between runs.
   → TASK-1005.
