# Design System

This documents the system as it is actually implemented in
`extension/src/sidepanel/components.tsx`, `extension/tailwind.config.js` and
`extension/src/lib/toast.ts`. Follow it; do not invent a parallel one.

## Style

**Quiet, dense, native.** The UI lives in a ~400 px Chrome side panel next to
LinkedIn, and in toasts injected on top of LinkedIn itself. It should read as
part of the browser, not as a product competing for attention.

Three consequences:

- **Density over whitespace.** A side panel column is narrow. Base body text is
  11–12 px, not 16 px.
- **LinkedIn blue as the brand colour**, on purpose, so an injected toast reads
  as native rather than as an ad.
- **No decoration.** No gradients, no shadows except on floating toasts, no
  icons-as-ornament, no emoji.

## Two surfaces

| Surface | Where | Styling |
| --- | --- | --- |
| **Side panel** | `chrome://` extension page | Tailwind classes |
| **In-page toast** | Injected into LinkedIn's DOM | Plain CSS inside a **shadow root** |

The toast must stay in a shadow root with `:host { all: initial }`. LinkedIn's
stylesheet is aggressive and would restyle our buttons; our styles would
otherwise leak into theirs. The toast is also plain DOM rather than React,
which keeps the content-script bundle small.

## Typography

System font stack — no web font is loaded. Tailwind's default sans in the
panel; in the toast, explicitly:

```
-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif
```

| Role | Size | Weight |
| --- | --- | --- |
| Panel title (`Job Search CRM`) | `text-sm` 14 px | `font-bold` |
| Card title (person / job) | `text-sm` 14 px | `font-semibold` |
| Section heading | `text-xs` 12 px | `font-semibold`, `uppercase`, `tracking-wide`, `text-slate-500` |
| Body / textarea | `text-xs` 12 px | normal |
| Metadata, state lines, counts | `text-[11px]` | normal |
| Badge, char count, tab label | `text-[10px]` | `font-semibold` |

Never go below 10 px. Never introduce a fourth heading level.

## Colour

Defined in `extension/tailwind.config.js`. `darkMode: "media"` — it follows the
OS, there is no theme toggle.

### Brand (LinkedIn blue)

| Token | Hex | Use |
| --- | --- | --- |
| `brand-50` | `#eef6ff` | Toast ghost-button hover |
| `brand-100` | `#d9ebff` | — |
| `brand-500` | `#0a66c2` | Primary buttons, active tab, status text |
| `brand-600` | `#084e94` | Primary hover |
| `brand-700` | `#063a6f` | — |

### Neutrals

Tailwind `slate`. Light: `bg-slate-50` app, `bg-white` cards,
`text-slate-900` body, `text-slate-500` muted, `border-slate-200/300`.
Dark: `bg-slate-900` app, `bg-slate-800` cards, `text-slate-100` body,
`border-slate-700`.

### Status colours

Every status colour appears **only** inside a `Badge`. Do not colour card
borders or backgrounds by status.

Contact status (`CONTACT_STATUS_STYLES`):

| Status | Classes | Reads as |
| --- | --- | --- |
| `Pending` | `bg-slate-100 text-slate-600` | inert, nothing to do |
| `Accepted` | `bg-blue-100 text-blue-700` | live |
| `Replied` | `bg-green-100 text-green-700` | success, terminal |
| `Follow_Up_Required` | `bg-amber-100 text-amber-700` | your move |

Job status (`JOB_STATUS_STYLES`): `Pending` slate, `Applied` blue,
`Interviewing` amber, `Offer` green, `Rejected` red, `Ghosted` slate-200.

Red is reserved for **errors and rejection**. Never use it for emphasis.

## Components

All of these live in `sidepanel/components.tsx`. Import them; do not re-implement.

### `Section({ title, action, children })`

An uppercase heading with an optional right-aligned action, `mb-5`. Use it to
split a tab into named groups. The Drafts tab is three Sections; that structure
is load-bearing (see below).

### `Card({ children, onClick })`

```
rounded-lg border border-slate-200 bg-white p-3
dark:border-slate-700 dark:bg-slate-800
```

`onClick` adds `cursor-pointer hover:border-brand-500`. **Border radius is
`rounded-lg` (8 px) for cards.** Do not mix radii.

### `Button({ children, onClick, variant, disabled })`

`rounded-full px-3 py-1 text-xs font-semibold`, and when disabled
`cursor-not-allowed opacity-50`.

| Variant | Use |
| --- | --- |
| `primary` | `bg-brand-500 text-white` — the one action the card is for |
| `ghost` | bordered, transparent — secondary actions (Profile, Copy, Mark as sent) |
| `danger` | red bordered — destructive only (Discard) |

**One `primary` per card, at most.** Filter pills are the deliberate exception:
the selected pill is `primary` and the rest are `ghost`, which is how selection
is expressed.

### `Badge({ status })`

`rounded-full px-2 py-0.5 text-[10px] font-semibold` with the status colours
above. Underscores are rendered as spaces.

### `Empty({ children })`

`rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs`.

An `Empty` must say **what will cause content to appear**, never just "nothing
here". Compare:

- Bad: *"No drafts."*
- Good: *"Nothing to approve. A draft is written for you the moment an
  invitation is accepted, and again once a message has gone unanswered for
  5 days."*

### `relativeTime(iso)`

`today` / `yesterday` / `Nd ago` / `Nmo ago`. Never render a raw ISO timestamp
in the UI.

## Layout

```
┌──────────────────────────────┐
│ header  title + one-line     │  border-b, px-3 py-2
│         counts               │
├──────────────────────────────┤
│ nav  pill tabs + badge count │  border-b, px-2 py-1.5
├──────────────────────────────┤
│                              │
│ main   flex-1 overflow-y-auto│  p-3
│        space-y-2 cards       │
│                              │
└──────────────────────────────┘
```

Five tabs: **Jobs · Contacts · Drafts · Vault · Settings**. The Drafts tab
carries an amber count badge when drafts await approval.

Standard spacing: `space-y-2` between cards, `space-y-4` between top-level
groups, `mb-5` under a `Section`.

## UX requirements

These are requirements, not suggestions. Two of them exist because the product
failed them in production.

### 1. No screen may go silent

Every tab, in every state, must say what the system is doing and what happens
next.

This is the rule the Drafts tab broke: it rendered only unsent drafts, so
"Mark as sent" emptied the page. The user's own words were *"the draft section
looks extremely blank and feels nothing is happening there."* A sent message is
the **start** of the product's job, not the end — it stays on screen with the
follow-up countdown visible until it is answered.

Drafts is therefore three Sections: **Needs your approval** → **Sent · waiting
for a reply** → **Replied**, each with a count in the heading.

### 2. Use the user's words, not the database's

The `contact_status` enum reads `Pending` / `Accepted` / `Replied` /
`Follow_Up_Required`. The filter pills read **All / Waiting / Connected /
Replied**, because "Pending" was read as *"a draft is pending"*.

`Accepted` and `Follow_Up_Required` are folded into one **Connected** pill:
they differ in the database but mean the same thing to the user — *you can
message this person*.

### 3. Every state gets a sentence, not just a badge

A colour and a word are not an explanation. `contactStateLine()` renders one
plain sentence per contact:

> *"Invitation sent 3d ago — not accepted yet. You cannot message them until
> they accept."*

> *"Accepted 2d ago — a draft is waiting for your approval."*

> *"Sent 2d ago. If there is no reply, a follow-up will be drafted for you in
> 3 days."*

Each one ends in either a fact about the other person or the next thing the
system will do.

**`Accepted` has three readings, not one**, and the difference is the most
recent *sent* message rather than the status column:

| condition | sentence |
| --- | --- |
| an unsent draft exists | "a draft is waiting for your approval" |
| something has been sent, inside the follow-up window | "you messaged them 2d ago — waiting for a reply. If they stay quiet, a follow-up is drafted for you in 3 days" |
| something has been sent, past the window | "you messaged them 8d ago with no reply — a follow-up is due at the next check" |
| nothing has ever been sent | "you can message them now" |

The fourth line used to be the only one, and it is false the moment the user has
messaged someone — which is the state every contact lands in after a follow-up
goes out. For the same reason the **Draft outreach** button only renders when
nothing has been sent: offering to introduce the user to a person they are two
messages into a conversation with is the panel contradicting its own sentence.

### 4. Filters always show counts, including zero

`Waiting 0` is information. Hiding an empty filter makes the set of filters
change shape underneath the user.

### 5. Every async action has three states

Idle → in-flight (`disabled` + a present-participle label: `Drafting…`,
`Checking…`) → resolved. Errors render as
`rounded bg-red-50 p-2 text-xs text-red-700` next to the thing that failed,
never as an `alert()` and never only in the console.

### 6. A failure to look is not a finding

`CheckNow` distinguishes *"Checked 4; no change yet"* from *"Could not read
LinkedIn. Make sure you are signed in."* Reporting a broken scrape as "nothing
found" is the worst failure mode in this codebase; it has happened three times.

### 7. Actionable prompts never auto-dismiss

A toast with buttons has `timeoutMs = 0`. Auto-dismissing a disambiguation
prompt silently discards the user's only chance to answer it.

### 8. Destructive and irreversible actions are user-initiated

The extension drafts; the user sends. "Insert into LinkedIn" fills the composer
and outlines LinkedIn's own Send button — it never clicks it.

### 9. Responsiveness

The side panel is resizable but effectively **320–500 px**. Design for 360 px.
Use `truncate` on any single-line user-supplied string (names, headlines, job
titles); use `flex-wrap` on every button row. There is no desktop breakpoint to
design for — this is not a web app.

### 10. Accessibility

- Every control is a real `<button>` or `<select>`; no clickable `<div>` except
  `Card`, which is decorative when not interactive.
- Never convey state by colour alone — the `Badge` always carries text, and the
  state line repeats it in prose.
- Form controls in Settings use real `<label>` elements.
- Dark mode is automatic (`prefers-color-scheme`) on both surfaces.
