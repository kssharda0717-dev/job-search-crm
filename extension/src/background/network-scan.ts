/**
 * Feature 5, evidence gathering.
 *
 * Reads two pages that belong to the user themselves:
 *
 *   /mynetwork/invitation-manager/sent/   invitations still awaiting a reply
 *   /mynetwork/invite-connect/connections/ people who are now 1st-degree
 *
 * It deliberately never opens a contact's profile. A profile visit is recorded
 * by LinkedIn and shown to that person as "someone viewed your profile", so a
 * background check that worked that way would repeatedly poke the very people
 * the user is trying to build a relationship with — and its cost grew with the
 * number of pending invitations. These two pages answer the same question for
 * every contact at once, and reading your own network is invisible to everyone
 * else.
 */

/** One person read off a network list page. */
export interface SentInvitation {
  linkedinUrl: string;
  name: string;
  headline: string | null;
  /**
   * True when the row carries a "Withdraw" control, which is what distinguishes
   * an invitation the user actually sent from a suggestion rendered beside it.
   */
  invitation: boolean;
  /**
   * True when the row offers a "Connect" or "Follow" control, i.e. it is a
   * suggestion rail rather than a person the user has any relationship with.
   * Both network pages render these alongside the real list.
   */
  suggestion: boolean;
}

export interface NetworkSnapshot {
  /**
   * Every invitation the user has sent that is still awaiting a reply, with the
   * name and headline the page renders next to it.
   *
   * This is also the record of who the user *intended* to add, which makes it
   * the only reliable way to notice a contact the click listener missed.
   */
  sent: SentInvitation[];
  /** Profile URLs of invitations the user has sent that are still pending. */
  stillPending: Set<string>;
  /** Profile URLs of the user's 1st-degree connections, newest first. */
  connections: Set<string>;
  /** False when neither page could be read — nothing may be inferred. */
  readable: boolean;
}

const SENT_INVITES_URL = "https://www.linkedin.com/mynetwork/invitation-manager/sent/";
const CONNECTIONS_URL = "https://www.linkedin.com/mynetwork/invite-connect/connections/";

export async function scanNetwork(): Promise<NetworkSnapshot> {
  const empty: NetworkSnapshot = {
    sent: [],
    stillPending: new Set(),
    connections: new Set(),
    readable: false,
  };

  // A minimized window of its own, rather than a tab in the user's current
  // window: a background tab still appears in their tab strip and steals a
  // sliver of every page they are reading.
  const window = await chrome.windows.create({
    url: SENT_INVITES_URL,
    focused: false,
    state: "minimized",
  });

  try {
    // Inside the try, not before it: this used to return early, which left a
    // minimized LinkedIn window open for the life of the browser session, once
    // per sweep. Nothing in the UI shows it, so it accumulated invisibly.
    const tabId = window.tabs?.[0]?.id;
    if (tabId === undefined) return empty;

    const sentRows = await readPeople(tabId);

    await chrome.tabs.update(tabId, { url: CONNECTIONS_URL });
    const connectionRows = await readPeople(tabId);

    // The Connections page also renders "People you may know". Reading every
    // `/in/` link on it as a connection is what reported invitations the user
    // had merely *sent* as accepted — the panel said Accepted while LinkedIn
    // still said Pending, on every reload. A row offering Connect or Follow is
    // by definition someone the user is not connected to.
    const connections = new Set(
      connectionRows.filter((person) => !person.suggestion).map((p) => p.linkedinUrl),
    );

    return {
      // Only rows that carry a Withdraw control become contacts. Every `/in/`
      // link on the page is fine for answering "is this person still pending?",
      // but creating a contact from one would invent people out of the "People
      // you may know" rail, so that half demands proof the user actually
      // invited them.
      sent: sentRows.filter((person) => person.invitation),
      stillPending: new Set(sentRows.map((p) => p.linkedinUrl)),
      connections,
      // An empty connections list means the page never rendered — usually a
      // logged-out redirect. Treating that as "nobody is connected" would
      // silently stall every contact, so say so instead. Counted before the
      // suggestion filter: a page that rendered only suggestions was still read.
      readable: connectionRows.length > 0 || sentRows.length > 0,
    };
  } finally {
    await chrome.windows.remove(window.id!).catch(() => {});
  }
}

/**
 * Collect every person listed on the current page, after letting its list load.
 *
 * Both pages are virtualised, so the first screen holds only a dozen entries.
 * Scrolling is how a person reads them too; the delays keep the request pattern
 * in the same shape as human scrolling.
 *
 * The name and headline come from the row's own rendered text rather than from
 * a class name, because these lists carry nothing but build hashes.
 */
async function readPeople(tabId: number): Promise<SentInvitation[]> {
  await waitForTabLoad(tabId);

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    // Serialised and run in the page, so it cannot close over anything here.
    func: async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const found = new Map<
        string,
        {
          linkedinUrl: string;
          name: string;
          headline: string | null;
          invitation: boolean;
          suggestion: boolean;
        }
      >();

      const collect = () => {
        // Scoped to `main` so the nav's own "Me" avatar — which links to the
        // user's own profile — can never be read back as a contact.
        const root = document.querySelector("main") ?? document;

        for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href*='/in/']")) {
          const slug = anchor.href.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1];
          if (!slug || found.has(slug)) continue;

          const row = anchor.closest("li") ?? anchor.parentElement;
          const text = (row as HTMLElement | null)?.innerText ?? anchor.innerText ?? "";

          // The Withdraw control is sometimes icon-only, with its name in
          // `aria-label` and nothing in `innerText` — the same trap that made
          // the Connect listener miss profile pages. Read both.
          const labels = [...(row?.querySelectorAll("[aria-label],[title]") ?? [])]
            .map((el) => `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`)
            .join(" ");

          const lines = text
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);

          // "Ehsan Ranjbar · 3rd" — the degree badge is not part of the name.
          const name = (lines[0] ?? "").split("·")[0]?.trim() ?? "";
          if (!name) continue;

          // Row actions sit where a headline would be for someone who has not
          // written one.
          const second = lines[1] ?? "";
          const headline =
            second && !/^(withdraw|message|pending|connect|follow(ing)?)$/i.test(second)
              ? second
              : null;

          found.set(slug, {
            linkedinUrl: `https://www.linkedin.com/in/${slug}/`,
            name,
            headline,
            invitation: /\bwithdraw\b/i.test(`${text} ${labels}`),
            // `\b` matters on both words: it rejects "Connections" (the page
            // heading), "Remove connection" and "Connected 3 days ago", none of
            // which are an offer to connect.
            suggestion: /\b(connect|follow)\b/i.test(`${text} ${labels}`),
          });
        }
      };

      // LinkedIn hydrates well after `complete`.
      await sleep(3000);
      collect();

      for (let page = 0; page < 6; page++) {
        const before = found.size;
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(1500 + Math.random() * 1000);
        collect();
        if (found.size === before) break; // Reached the end of the list.
      }

      return [...found.values()];
    },
  });

  return (result?.result as SentInvitation[] | undefined) ?? [];
}

function waitForTabLoad(tabId: number, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, timeoutMs);

    function finish() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    function listener(id: number, info: chrome.tabs.TabChangeInfo) {
      if (id === tabId && info.status === "complete") finish();
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}
