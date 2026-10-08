import { useState, type ReactNode } from "react";
import type {
  Contact,
  DraftReview,
  Job,
  Message,
  MessageType,
  PendingApplication,
  Resume,
} from "@crm/shared";
import { MAX_RESUME_BYTES } from "@crm/shared/constants";
import { api } from "../lib/api";
import { arrayBufferToBase64 } from "../lib/encoding";
import { type RunSweepResult, sendToBackground } from "../lib/messaging";
import { getSettings } from "../lib/settings";
import { Badge, Button, Card, Empty, Section, relativeTime } from "./components";
import { type CrmData, useFollowUpDays, usePendingApplications } from "./hooks";

/**
 * Case-insensitive substring match across whichever fields are passed.
 *
 * Deliberately not fuzzy. The user is looking for a company or a person whose
 * name they already know, and a matcher loose enough to return "Verdant" for
 * "next" is loose enough to return four other things at the same time — which
 * is worse than scrolling, because it looks like an answer.
 */
function matches(query: string, ...fields: Array<string | null | undefined>): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => field?.toLowerCase().includes(needle));
}

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <input
      type="search"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded border border-slate-300 bg-transparent px-2 py-1 text-xs placeholder:text-slate-400 dark:border-slate-600"
    />
  );
}

// --- Applications -----------------------------------------------------------

export function JobsTab({ data, refresh }: { data: CrmData; refresh: () => Promise<void> }) {
  const { pending, refresh: refreshPending } = usePendingApplications();
  const [query, setQuery] = useState("");

  const resumeByJob = new Map(data.resumes.map((r) => [r.job_id, r]));
  const contactsByJob = new Map<string, Contact[]>();
  for (const contact of data.contacts) {
    if (!contact.job_id) continue;
    contactsByJob.set(contact.job_id, [...(contactsByJob.get(contact.job_id) ?? []), contact]);
  }

  if (data.jobs.length === 0 && pending.length === 0) {
    return (
      <Empty>
        No applications tracked yet. Apply on LinkedIn or on any company's own
        careers site and they will appear here automatically.
      </Empty>
    );
  }

  const visibleJobs = data.jobs.filter((job) =>
    matches(query, job.title, job.company, job.location),
  );

  return (
    <div className="space-y-4">
      {pending.length > 0 && (
        <Section title="Awaiting confirmation">
          <div className="space-y-2">
            {pending.map((item) => (
              <PendingCard
                key={item.handshakeId}
                item={item}
                refresh={async () => {
                  await refreshPending();
                  await refresh();
                }}
              />
            ))}
          </div>
        </Section>
      )}

      {data.jobs.length > 0 && (
        <div className="space-y-2">
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder="Search by role, company or location"
          />

          {visibleJobs.length === 0 ? (
            <Empty>No application matches “{query.trim()}”.</Empty>
          ) : (
            visibleJobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                resume={resumeByJob.get(job.id)}
                contacts={contactsByJob.get(job.id) ?? []}
                refresh={refresh}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Handshakes expire in 2h, so day-granularity relative time says nothing. */
function minutesAgo(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/**
 * A handshake whose submission we never saw confirmed — the site gave no
 * success URL and no confirmation copy we recognised. The user is the signal
 * instead, and confirming here also releases any resume they attached.
 */
function PendingCard({
  item,
  refresh,
}: {
  item: PendingApplication;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = (kind: "CONFIRM_PENDING" | "DISCARD_PENDING") => {
    setBusy(true);
    setError(null);
    void (async () => {
      const res = await sendToBackground({ kind, payload: { handshakeId: item.handshakeId } });
      // Without this the card just sits there on failure, which reads as a dead
      // button rather than as the proxy being unreachable.
      if (!res.ok) setError(res.error);
      await refresh();
      setBusy(false);
    })();
  };

  return (
    <Card>
      <p className="truncate text-sm font-semibold">{item.title}</p>
      <p className="truncate text-xs text-slate-500">
        {item.company}
        {item.location ? ` · ${item.location}` : ""}
      </p>
      <p className="mt-1 text-[11px] text-slate-500">
        Started {minutesAgo(item.createdAt)}. Did you finish applying?
      </p>
      <div className="mt-2 flex gap-2">
        <Button onClick={() => act("CONFIRM_PENDING")} disabled={busy}>
          I applied
        </Button>
        <Button variant="ghost" onClick={() => act("DISCARD_PENDING")} disabled={busy}>
          Discard
        </Button>
      </div>
      {error && <p className="mt-2 text-[11px] text-rose-400">{error}</p>}
    </Card>
  );
}

function JobCard({
  job,
  resume,
  contacts,
  refresh,
}: {
  job: Job;
  resume?: Resume;
  contacts: Contact[];
  refresh: () => Promise<void>;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{job.title}</p>
          <p className="truncate text-xs text-slate-500">
            {job.company}
            {job.location ? ` · ${job.location}` : ""}
          </p>
        </div>
        <Badge status={job.status} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span>Applied {relativeTime(job.applied_at)}</span>
        <span>{resume ? "Resume saved" : "No resume captured"}</span>
        <span>
          {contacts.length} contact{contacts.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        <select
          value={job.status}
          onChange={(e) => {
            void api
              .updateJob(job.id, { status: e.target.value as Job["status"] })
              .then(refresh);
          }}
          className="rounded-full border border-slate-300 bg-transparent px-2 py-1 text-[11px] dark:border-slate-600"
        >
          {["Applied", "Interviewing", "Offer", "Rejected", "Ghosted"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        {resume && (
          <Button
            variant="ghost"
            onClick={() => {
              void api.resumeDownloadUrl(resume.id).then(({ url }) => {
                // Signed URL is short-lived, so open it immediately.
                window.open(url, "_blank");
              });
            }}
          >
            Resume PDF
          </Button>
        )}

        <ResumePicker job={job} resume={resume} refresh={refresh} />

        {job.url && (
          <Button variant="ghost" onClick={() => window.open(job.url!, "_blank")}>
            Posting
          </Button>
        )}
      </div>
    </Card>
  );
}

/**
 * File a resume against an application by hand.
 *
 * The capture path is automatic and that is the point, but it is also the only
 * path there was, so when it misrouted a document — which it did, filing three
 * consecutive CVs one application behind — the user had no way to put it right.
 * An application that holds the wrong CV is worse than one that holds none:
 * every draft written for a contact there cites a resume the user never sent.
 *
 * Replacing is destructive and the server refuses it unless asked explicitly,
 * so that intent is confirmed here rather than assumed.
 */
function ResumePicker({
  job,
  resume,
  refresh,
}: {
  job: Job;
  resume?: Resume;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPick = async (file: File) => {
    if (file.size > MAX_RESUME_BYTES) {
      setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)}MB; the limit is ${Math.round(MAX_RESUME_BYTES / 1024 / 1024)}MB.`);
      return;
    }
    if (resume && !confirm(`Replace ${resume.file_name}? The original cannot be recovered.`)) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { userName } = await getSettings();
      await api.uploadResume({
        jobId: job.id,
        fileName: file.name,
        fileBase64: arrayBufferToBase64(await file.arrayBuffer()),
        userName: userName || null,
        replace: Boolean(resume),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <label className="cursor-pointer rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700">
        {busy ? "Filing…" : resume ? "Replace" : "Attach resume"}
        <input
          type="file"
          accept="application/pdf"
          disabled={busy}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Cleared so picking the same file twice still fires a change.
            e.target.value = "";
            if (file) void onPick(file);
          }}
        />
      </label>
      {error && <p className="w-full text-[11px] text-red-600">{error}</p>}
    </>
  );
}

// --- Contacts ---------------------------------------------------------------

/**
 * The tabs of the Contacts list.
 *
 * "Waiting" and "Connected" rather than the database's `Pending` and
 * `Accepted`: the two words differ by one status badge in a mixed list, and the
 * question the user is actually asking is "who can I message yet?" — which is
 * the only thing that separates them.
 */
const CONTACT_FILTERS = [
  { key: "all", label: "All", statuses: null },
  { key: "waiting", label: "Waiting", statuses: ["Pending"] },
  { key: "connected", label: "Connected", statuses: ["Accepted", "Follow_Up_Required"] },
  { key: "replied", label: "Replied", statuses: ["Replied"] },
] as const satisfies ReadonlyArray<{
  key: string;
  label: string;
  statuses: readonly Contact["status"][] | null;
}>;

type ContactFilterKey = (typeof CONTACT_FILTERS)[number]["key"];

/**
 * One line of plain English per contact saying what state they are in and what
 * happens next.
 *
 * The badge alone says `Pending`, which the user read as "a draft is pending"
 * rather than "they have not accepted your invitation". Every one of these ends
 * in either a fact about the other person or the next thing the system will do.
 */
function contactStateLine(
  contact: Contact,
  hasDraft: boolean,
  followUpDays: number,
  lastSentAt: string | null,
): string {
  switch (contact.status) {
    case "Pending":
      return `Invitation sent ${relativeTime(contact.connected_at ?? contact.created_at)} — not accepted yet. You cannot message them until they accept.`;
    case "Accepted": {
      if (hasDraft) {
        return `Accepted ${relativeTime(contact.accepted_at)} — a draft is waiting for your approval.`;
      }
      // "You can message them now" is false once you have. A contact returns to
      // Accepted after a follow-up is sent, and telling the user to do the thing
      // they just did is the whole complaint behind this line existing.
      if (lastSentAt) {
        const remaining = followUpDays - daysSince(lastSentAt);
        return remaining > 0
          ? `You messaged them ${relativeTime(lastSentAt)} — waiting for a reply. If they stay quiet, a follow-up is drafted for you in ${remaining} day${remaining === 1 ? "" : "s"}.`
          : `You messaged them ${relativeTime(lastSentAt)} with no reply — a follow-up is due at the next check.`;
      }
      return `Accepted ${relativeTime(contact.accepted_at)} — you can message them now.`;
    }
    case "Follow_Up_Required":
      return `No reply for ${followUpDays}+ days — a follow-up is due.`;
    case "Replied":
      return "They replied. Nothing is owed here automatically.";
  }
}

export function ContactsTab({
  data,
  refresh,
  onShowDrafts,
}: {
  data: CrmData;
  refresh: () => Promise<void>;
  onShowDrafts: () => void;
}) {
  const [drafting, setDrafting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const followUpDays = useFollowUpDays();
  const [filter, setFilter] = useState<ContactFilterKey>("all");
  const [query, setQuery] = useState("");

  if (data.contacts.length === 0) {
    return <Empty>No contacts yet. Connect with someone on LinkedIn to start.</Empty>;
  }

  const jobById = new Map(data.jobs.map((j) => [j.id, j]));
  const hasPending = data.contacts.some((c) => c.status === "Pending");

  // A draft is written automatically the moment an acceptance is detected, so
  // for most contacts the answer to "draft outreach?" is "already done". A
  // button that drafts anyway is a second path to the same message and is how
  // one person ends up with two near-identical drafts.
  const hasUnsentDraft = new Set(
    data.messages.filter((m) => !m.sent_at).map((m) => m.contact_id),
  );

  // The most recent thing this person has actually been sent, so the card can
  // say "waiting for a reply" instead of "you can message them now".
  const lastSentAt = new Map<string, string>();
  for (const m of data.messages) {
    if (!m.sent_at) continue;
    const current = lastSentAt.get(m.contact_id);
    if (!current || Date.parse(m.sent_at) > Date.parse(current)) {
      lastSentAt.set(m.contact_id, m.sent_at);
    }
  }

  const draft = (contact: Contact, type: MessageType) => {
    setDrafting(contact.id);
    setError(null);
    api
      .draft({ contactId: contact.id, type })
      .then(() => refresh())
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setDrafting(null));
  };

  // Contacts needing action first; the panel is a worklist, not an archive.
  const order: Record<Contact["status"], number> = {
    Follow_Up_Required: 0,
    Accepted: 1,
    Replied: 2,
    Pending: 3,
  };
  const sorted = [...data.contacts].sort((a, b) => order[a.status] - order[b.status]);

  const active = CONTACT_FILTERS.find((f) => f.key === filter) ?? CONTACT_FILTERS[0];
  const byStatus = active.statuses
    ? sorted.filter((c) => (active.statuses as readonly string[]).includes(c.status))
    : sorted;

  // The linked application is searchable too: "who do I know at Verdant" is the
  // question being asked, and for a contact captured off the Sent invitations
  // page the company is often only known through the job it is linked to.
  const visible = byStatus.filter((contact) => {
    const job = contact.job_id ? jobById.get(contact.job_id) : undefined;
    return matches(
      query,
      contact.name,
      contact.headline,
      contact.company,
      job?.title,
      job?.company,
    );
  });

  return (
    <div className="space-y-2">
      {error && <p className="rounded bg-red-50 p-2 text-xs text-red-700">{error}</p>}

      <SearchBox
        value={query}
        onChange={setQuery}
        placeholder="Search by name, headline or company"
      />

      <div className="flex flex-wrap gap-1">
        {CONTACT_FILTERS.map((f) => {
          const count = f.statuses
            ? data.contacts.filter((c) => (f.statuses as readonly string[]).includes(c.status))
                .length
            : data.contacts.length;
          return (
            <Button
              key={f.key}
              variant={f.key === filter ? "primary" : "ghost"}
              onClick={() => setFilter(f.key)}
            >
              {f.label} {count}
            </Button>
          );
        })}
      </div>

      {hasPending && <CheckNow refresh={refresh} />}

      {visible.length === 0 && (
        <Empty>
          {query.trim()
            ? `No contact matches “${query.trim()}”.`
            : "No contacts in this group yet."}
        </Empty>
      )}

      {visible.map((contact) => {
        const job = contact.job_id ? jobById.get(contact.job_id) : undefined;
        const isDrafting = drafting === contact.id;

        return (
          <Card key={contact.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{contact.name}</p>
                <p className="truncate text-xs text-slate-500">
                  {contact.headline ?? contact.company ?? "—"}
                </p>
              </div>
              <Badge status={contact.status} />
            </div>

            <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-300">
              {contactStateLine(
                contact,
                hasUnsentDraft.has(contact.id),
                followUpDays,
                lastSentAt.get(contact.id) ?? null,
              )}
            </p>

            <p className="mt-1 text-[11px] text-slate-500">
              {job ? `Linked to ${job.title}` : "General networking"}
              {contact.persona ? ` · ${contact.persona.replace(/_/g, " ")}` : ""}
            </p>

            {/* The profile is read only from the page the user is standing on —
                a background sweep that opened everyone's profile is exactly the
                behaviour that gets accounts restricted. So when it is missing,
                say so and say what fixes it, because one click on Profile below
                is the whole remedy and there is no way to guess that. */}
            {!contact.profile_text && (
              <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-500">
                Drafts are working from their headline alone. Open Profile once
                to give them their full background.
              </p>
            )}

            {!contact.job_id && data.jobs.length > 0 && (
              <select
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) {
                    void api.updateContact(contact.id, { jobId: e.target.value }).then(refresh);
                  }
                }}
                className="mt-2 w-full rounded border border-slate-300 bg-transparent px-2 py-1 text-[11px] dark:border-slate-600"
              >
                <option value="">Link to an application…</option>
                {data.jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.title} — {j.company}
                  </option>
                ))}
              </select>
            )}

            <div className="mt-2 flex flex-wrap gap-1">
              <Button
                variant="ghost"
                onClick={() => window.open(contact.linkedin_url, "_blank")}
              >
                Profile
              </Button>

              {hasUnsentDraft.has(contact.id) ? (
                <Button onClick={onShowDrafts}>Draft ready →</Button>
              ) : contact.status === "Accepted" && !lastSentAt.has(contact.id) ? (
                // Only when nothing has been sent yet. A contact returns to
                // Accepted once their follow-up goes out, and "Draft outreach"
                // there offers to introduce the user to someone they are already
                // two messages into a conversation with. The follow-up after
                // this one is written automatically; the early-draft button
                // lives on the sent card in Drafts.
                <Button
                  onClick={() => draft(contact, "initial_outreach")}
                  disabled={isDrafting}
                >
                  {isDrafting ? "Drafting…" : "Draft outreach"}
                </Button>
              ) : contact.status === "Follow_Up_Required" ? (
                <Button onClick={() => draft(contact, "follow_up")} disabled={isDrafting}>
                  {isDrafting ? "Drafting…" : "Draft follow-up"}
                </Button>
              ) : null}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/**
 * Background sweeps are jittered across 30-90 minutes and pause overnight, so
 * an invitation accepted a minute ago is invisible until one runs. Refreshing
 * the panel cannot help — it reads the database, and nothing has looked at
 * LinkedIn yet. This is the button that actually goes and looks.
 *
 * Looking means reading the user's own "Sent invitations" and "Connections"
 * pages in a minimized window, never a contact's profile: a profile visit is
 * reported to that person, so checking on them would mean pestering them.
 */
function CheckNow({ refresh }: { refresh: () => Promise<void> }) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = () => {
    setBusy(true);
    setStatus("Checking LinkedIn…");
    void (async () => {
      const res = await sendToBackground<RunSweepResult>({ kind: "RUN_SWEEP" });
      if (!res.ok) {
        setStatus(res.error);
      } else if (res.data.problem) {
        // A sweep that could not look must not read as a sweep that looked and
        // found nothing.
        setStatus(res.data.problem);
      } else if (res.data.updated > 0) {
        setStatus(`${res.data.updated} updated. Drafts are ready.`);
      } else if (res.data.checked === 0) {
        setStatus("Nothing to check right now.");
      } else {
        setStatus(`Checked ${res.data.checked}; no change yet.`);
      }
      await refresh();
      setBusy(false);
    })();
  };

  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-slate-500">
          Invitations are checked automatically every 30-90 minutes.
        </p>
        <Button onClick={run} disabled={busy}>
          {busy ? "Checking…" : "Check now"}
        </Button>
      </div>
      {status && <p className="mt-2 text-[11px] text-brand-600">{status}</p>}
    </Card>
  );
}

// --- Drafts -----------------------------------------------------------------

/**
 * The tab used to render *only* unsent drafts, which meant "Mark as sent" made
 * the message disappear and left an empty page behind — no record that anything
 * had been sent, no sign that the promised follow-up was coming, and no way to
 * tell a working system from a dead one. A message the user sent is the start
 * of the thing this product does, not the end of it, so it stays on screen with
 * the clock visible until it is answered.
 */
export function DraftsTab({ data, refresh }: { data: CrmData; refresh: () => Promise<void> }) {
  const followUpDays = useFollowUpDays();
  const contactById = new Map(data.contacts.map((c) => [c.id, c]));

  const waitingApproval = data.messages.filter((m) => !m.sent_at);

  // Newest sent message per contact: the timeline is one row per conversation,
  // not one per message, and the follow-up clock runs from the last thing sent.
  const lastSentByContact = new Map<string, Message>();
  for (const message of data.messages) {
    if (!message.sent_at) continue;
    const current = lastSentByContact.get(message.contact_id);
    if (!current || message.sent_at > current.sent_at!) {
      lastSentByContact.set(message.contact_id, message);
    }
  }

  const sent = [...lastSentByContact.values()].sort((a, b) =>
    (b.sent_at ?? "").localeCompare(a.sent_at ?? ""),
  );
  const awaitingReply = sent.filter(
    (m) => contactById.get(m.contact_id)?.status !== "Replied",
  );
  const replied = sent.filter((m) => contactById.get(m.contact_id)?.status === "Replied");

  if (data.messages.length === 0) {
    return <Empty>No drafts waiting. Drafts appear here when a connection is accepted.</Empty>;
  }

  return (
    <div>
      <Section title={`Needs your approval (${waitingApproval.length})`}>
        {waitingApproval.length === 0 ? (
          <Empty>
            Nothing to approve. A draft is written for you the moment an
            invitation is accepted, and again once a message has gone
            unanswered for {followUpDays} days.
          </Empty>
        ) : (
          <div className="space-y-2">
            {waitingApproval.map((message) => (
              <DraftCard
                key={message.id}
                message={message}
                contact={contactById.get(message.contact_id)}
                refresh={refresh}
              />
            ))}
          </div>
        )}
      </Section>

      {awaitingReply.length > 0 && (
        <Section title={`Sent · waiting for a reply (${awaitingReply.length})`}>
          <div className="space-y-2">
            {awaitingReply.map((message) => (
              <SentCard
                key={message.id}
                message={message}
                contact={contactById.get(message.contact_id)}
                hasUnsentDraft={waitingApproval.some(
                  (d) => d.contact_id === message.contact_id,
                )}
                followUpDays={followUpDays}
                refresh={refresh}
              />
            ))}
          </div>
        </Section>
      )}

      {replied.length > 0 && (
        <Section title={`Replied (${replied.length})`}>
          <div className="space-y-2">
            {replied.map((message) => (
              <SentCard
                key={message.id}
                message={message}
                contact={contactById.get(message.contact_id)}
                hasUnsentDraft={false}
                followUpDays={followUpDays}
                refresh={refresh}
              />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

/** Whole days elapsed since an ISO timestamp. */
function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/**
 * A message that has already gone out.
 *
 * Its whole job is to say, without the user having to work anything out, what
 * the system is waiting for and when it will act. Silence here is what made the
 * tab feel dead.
 */
function SentCard({
  message,
  contact,
  hasUnsentDraft,
  followUpDays,
  refresh,
}: {
  message: Message;
  contact?: Contact;
  hasUnsentDraft: boolean;
  followUpDays: number;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sentAt = message.sent_at!;
  const elapsed = daysSince(sentAt);
  const remaining = followUpDays - elapsed;
  const hasReplied = contact?.status === "Replied";

  const status = hasReplied
    ? `${contact?.name ?? "They"} replied — the thread is yours now.`
    : hasUnsentDraft
      ? "A follow-up is drafted above, waiting for your approval."
      : remaining > 0
        ? `Sent ${relativeTime(sentAt)}. If there is no reply, a follow-up will be drafted for you in ${remaining} day${remaining === 1 ? "" : "s"}.`
        : `Sent ${relativeTime(sentAt)} with no reply. A follow-up is due.`;

  const draftFollowUp = () => {
    if (!contact) return;
    setBusy(true);
    setError(null);
    api
      .draft({ contactId: contact.id, type: "follow_up" })
      .then(() => refresh())
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-semibold">{contact?.name ?? "Unknown contact"}</p>
        <span className="text-[10px] uppercase tracking-wide text-slate-500">
          {message.type.replace(/_/g, " ")}
        </span>
      </div>

      <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-300">{status}</p>

      <p className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px] text-slate-600 dark:bg-slate-900 dark:text-slate-300">
        {message.sent_text ?? message.draft_text}
      </p>

      {!hasReplied && !hasUnsentDraft && contact && (
        <div className="mt-2">
          <Button variant="ghost" onClick={draftFollowUp} disabled={busy}>
            {busy ? "Drafting…" : remaining > 0 ? "Draft follow-up early" : "Draft follow-up now"}
          </Button>
        </div>
      )}

      {error && <p className="mt-2 text-[11px] text-red-600">{error}</p>}
    </Card>
  );
}

function DraftCard({
  message,
  contact,
  refresh,
}: {
  message: Message;
  contact?: Contact;
  refresh: () => Promise<void>;
}) {
  const [text, setText] = useState(message.draft_text);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Confirmed, because it is not recoverable: the draft is deleted outright and
  // regenerating costs a full agent run. Not confirmed anywhere else in this
  // card, because Insert and Copy change nothing.
  const discard = () => {
    if (!confirm(`Discard this ${message.type.replace(/_/g, " ")} draft for ${contact?.name ?? "this contact"}?`)) {
      return;
    }
    setBusy(true);
    setStatus(null);
    api
      .discardDraft(message.id)
      .then(refresh)
      .catch((err: unknown) => setStatus(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const insert = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.includes("linkedin.com")) {
      setStatus("Open the LinkedIn conversation first.");
      return;
    }
    // The content script fills the composer and highlights Send. It never
    // clicks Send; the user does that themselves.
    await chrome.tabs.sendMessage(tab.id, { kind: "INJECT_DRAFT", text });
    setStatus("Inserted. Review it, then click Send in LinkedIn.");
  };

  return (
    <Card>
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">{contact?.name ?? "Unknown contact"}</p>
        <span className="text-[10px] uppercase tracking-wide text-slate-500">
          {message.type.replace(/_/g, " ")}
        </span>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        className="mt-2 w-full resize-y rounded border border-slate-300 bg-transparent p-2 text-xs dark:border-slate-600"
      />
      <p className="mt-1 text-right text-[10px] text-slate-500">{text.length} chars</p>

      <DraftReviewNotice review={message.review} />
      {!message.review && (
        <p className="mt-1 text-[10px] text-slate-500">
          Written before drafts were checked, so nothing has reviewed this one.
          Read it yourself before sending.
        </p>
      )}

      <div className="mt-1 flex flex-wrap gap-1">
        <Button onClick={() => void insert()}>Insert into LinkedIn</Button>
        <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(text)}>
          Copy
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            void api.markSent(message.id, text).then(refresh);
          }}
        >
          Mark as sent
        </Button>
        <Button variant="ghost" onClick={discard} disabled={busy}>
          {busy ? "Discarding…" : "Discard"}
        </Button>
      </div>

      {status && <p className="mt-2 text-[11px] text-brand-600">{status}</p>}
    </Card>
  );
}

/**
 * What the critique still said about this draft when it was saved.
 *
 * The agent already ran every check and already knew the answer; it just had
 * nowhere to put it. A draft that came out of two repair passes still carrying
 * a problem rendered identically to a clean one, so the only signal the user
 * had was the text itself — and two messages recorded a surviving problem and
 * were approved and sent on exactly that basis.
 *
 * Silence here is therefore not neutral, it is a claim that the draft is fine.
 * So every draft says something, including the clean ones: a reviewer that only
 * speaks up on failure is indistinguishable from a reviewer that is broken.
 */
function DraftReviewNotice({ review }: { review?: DraftReview | null }) {
  if (!review) return null;

  const findings = [
    ...review.ungroundedFigures.map(
      (figure) =>
        `The number ${figure} is not in the resume passages this was written ` +
        "from. Check it against your CV or take it out.",
    ),
    // Written before `problems`, because it is the one finding the repair loop
    // was never given — nothing upstream has tried to fix it and nobody but the
    // reader can. See `summaryOnlyFigures`.
    ...(review.summaryOnlyFigures ?? []).map(
      (figure) =>
        `The number ${figure} was found only in your resume's summary, which ` +
        "does not say which work produced it. Check that the sentence here " +
        "describes the same work your CV credits it to.",
    ),
    ...review.problems,
  ];

  if (review.evidenceCount === 0) {
    return (
      <Notice>
        <p className="font-semibold">Nothing in this message came from your resume.</p>
        <p className="mt-0.5">
          No resume passages were found for this contact, so every claim in it was
          written without evidence. Read it line by line before you send it.
        </p>
        {findings.length > 0 && <Findings items={findings} />}
      </Notice>
    );
  }

  // Name the checks, never the verdict. This line used to read "nothing left to
  // fix", which is a claim about the message that these checks cannot support:
  // they compare figures and phrasing against the retrieved text, and they have
  // no opinion on whether the message is true, well aimed or worth sending. One
  // draft passed every one of them while re-tagging five years of payroll work
  // as five years of AI — grounded, because the only thing compared was "5".
  // A reviewer that overstates its own remit is worse than no reviewer, because
  // the user stops reading.
  if (findings.length === 0) {
    return (
      <p className="mt-2 text-[10px] text-slate-500">
        No invented figures, reused phrasing or job-ad wording found against the{" "}
        {review.evidenceCount} resume passage
        {review.evidenceCount === 1 ? "" : "s"} this came from. Read it before
        you send.
      </p>
    );
  }

  return (
    <Notice>
      <p className="font-semibold">
        {findings.length} thing{findings.length === 1 ? "" : "s"} the rewrite could not fix
        {review.repairPasses > 0 &&
          ` after ${review.repairPasses} attempt${review.repairPasses === 1 ? "" : "s"}`}
        .
      </p>
      <Findings items={findings} />
      <p className="mt-1">Edit the message above, or send it knowing this.</p>
    </Notice>
  );
}

function Findings({ items }: { items: string[] }) {
  return (
    <ul className="mt-1 list-disc space-y-0.5 pl-4">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-[10px] leading-snug text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
      {children}
    </div>
  );
}

// --- Vault ------------------------------------------------------------------

export function VaultTab({ data }: { data: CrmData }) {
  if (data.resumes.length === 0) {
    return (
      <Empty>
        No resumes captured. Attach a PDF to any application and it is filed here
        as Name_Company_Role.pdf once that application is tracked.
      </Empty>
    );
  }

  const jobById = new Map(data.jobs.map((j) => [j.id, j]));

  return (
    <Section title={`${data.resumes.length} tailored resumes`}>
      <div className="space-y-2">
        {data.resumes.map((resume) => {
          const job = jobById.get(resume.job_id);
          return (
            <Card key={resume.id}>
              <p className="truncate text-sm font-semibold">{resume.file_name}</p>
              <p className="truncate text-xs text-slate-500">
                {job ? `${job.title} — ${job.company}` : "Unlinked"}
              </p>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[11px] text-slate-500">
                  {relativeTime(resume.uploaded_at)}
                </span>
                <Button
                  variant="ghost"
                  onClick={() => {
                    void api.resumeDownloadUrl(resume.id).then(({ url }) =>
                      window.open(url, "_blank"),
                    );
                  }}
                >
                  Download
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    </Section>
  );
}
