import type { PlasmoCSConfig } from "plasmo";
import type { Contact, DraftResponse } from "@crm/shared";
import { findFirst, observeDom, setNativeValue } from "../lib/dom";
import { canonicalProfileUrl } from "../lib/scrapers/linkedin";
import { sendToBackground } from "../lib/messaging";
import { showToast } from "../lib/toast";

export const config: PlasmoCSConfig = {
  matches: ["https://www.linkedin.com/messaging/*", "https://www.linkedin.com/in/*"],
  all_frames: false,
};

/**
 * Feature 4 delivery and Feature 5 reply detection.
 *
 * CRITICAL (PRD section 6.3): this script never clicks Send. It fills the
 * composer and visually highlights LinkedIn's own Send button. The final action
 * is always the user's. `dispatchEvent` on the Send button is deliberately
 * absent and must stay that way.
 */

const COMPOSER_SELECTORS = [
  ".msg-form__contenteditable",
  "div[role='textbox'][contenteditable='true']",
  "textarea.msg-form__textarea",
];

const SEND_BUTTON_SELECTORS = [
  "button.msg-form__send-button",
  "button[type='submit'].msg-form__send-btn",
  "button[aria-label='Send'][type='submit']",
];

// --- Feature 4: inject an approved draft ------------------------------------

chrome.runtime.onMessage.addListener((message: { kind?: string; text?: string }) => {
  if (message?.kind === "INJECT_DRAFT" && typeof message.text === "string") {
    injectDraft(message.text);
  }
  return false;
});

export function injectDraft(text: string): boolean {
  const composer = findFirst(COMPOSER_SELECTORS);
  if (!composer) {
    showToast({
      title: "Open a conversation first",
      body: "Start a message thread with this contact, then insert the draft.",
    });
    return false;
  }

  if (composer instanceof HTMLTextAreaElement) {
    setNativeValue(composer, text);
  } else {
    // The composer is a contenteditable. Replace its contents and fire `input`
    // so LinkedIn's Quill-based editor updates its model and enables Send.
    composer.textContent = "";
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    composer.appendChild(paragraph);
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  }

  (composer as HTMLElement).focus();
  highlightSendButton();
  return true;
}

/**
 * Draw attention to LinkedIn's native Send button without touching it. The
 * handoff has to be obvious, or the user assumes the message already went out.
 */
function highlightSendButton(): void {
  const send = findFirst(SEND_BUTTON_SELECTORS);
  if (!(send instanceof HTMLElement)) return;

  const previous = send.style.cssText;
  send.style.cssText = `${previous};outline:3px solid #0a66c2;outline-offset:2px;border-radius:4px;`;
  send.scrollIntoView({ block: "nearest", behavior: "smooth" });

  const restore = () => {
    send.style.cssText = previous;
    send.removeEventListener("click", restore);
  };
  send.addEventListener("click", restore);
  setTimeout(restore, 15_000);

  showToast({
    title: "Draft inserted — review and send",
    body: "Edit it if you want, then click LinkedIn's Send button yourself.",
    timeoutMs: 7000,
  });
}

// --- Feature 5: passive reply detection -------------------------------------

/**
 * Watch the open conversation for an inbound message. This is passive: it only
 * reads what is already rendered while the user browses their own inbox, so it
 * adds no traffic and cannot look like scripted activity.
 */
const reportedReplies = new Set<string>();

function checkForReplies(): void {
  if (!location.pathname.startsWith("/messaging")) return;

  const profileLink = document.querySelector<HTMLAnchorElement>(
    ".msg-thread__link-to-profile, a.msg-entity-lockup__link[href*='/in/']",
  );
  if (!profileLink?.href) return;

  const linkedinUrl = canonicalProfileUrl(profileLink.href);
  if (reportedReplies.has(linkedinUrl)) return;

  if (!hasInboundMessage()) return;

  reportedReplies.add(linkedinUrl);
  void sendToBackground({ kind: "OBSERVE_REPLY", payload: { linkedinUrl } });
}

/**
 * True when the most recent message in the thread came from the other person.
 * LinkedIn does not mark authorship with a stable attribute, so we compare the
 * last message's sender name against the signed-in user's name.
 */
function hasInboundMessage(): boolean {
  const events = document.querySelectorAll(".msg-s-event-listitem");
  if (events.length === 0) return false;

  const selfName = currentUserName();
  if (!selfName) return false;

  // Walk backwards to the last message that declares a sender; LinkedIn omits
  // the name on consecutive messages from the same person.
  for (let i = events.length - 1; i >= 0; i--) {
    const name = events[i]
      ?.querySelector(".msg-s-message-group__name, .msg-s-event-listitem__name")
      ?.textContent?.trim();
    if (name) return name !== selfName;
  }
  return false;
}

function currentUserName(): string | null {
  const img = document.querySelector<HTMLImageElement>(
    "img.global-nav__me-photo, .global-nav__me img",
  );
  // The nav avatar's alt text is the signed-in user's display name.
  return img?.alt?.trim() || null;
}

// --- Contact-aware draft affordance on profiles -----------------------------

/**
 * On a tracked contact's profile, offer to draft directly rather than making
 * the user find them again in the side panel.
 */
async function offerDraftOnProfile(): Promise<void> {
  if (!location.pathname.startsWith("/in/")) return;

  const res = await sendToBackground<{ contact: Contact | null }>({
    kind: "LOOKUP_CONTACT_BY_URL",
    payload: { linkedinUrl: canonicalProfileUrl() },
  });

  if (!res.ok || !res.data.contact) return;
  const contact = res.data.contact;
  if (contact.status !== "Accepted" && contact.status !== "Follow_Up_Required") return;

  const type = contact.status === "Accepted" ? "initial_outreach" : "follow_up";

  showToast({
    title: contact.status === "Accepted" ? "They accepted your request" : "Time for a nudge",
    body: `Draft a ${type.replace("_", " ")} for ${contact.name}?`,
    actions: [
      {
        label: "Draft it",
        onClick: () => {
          void (async () => {
            showToast({ title: "Drafting…", timeoutMs: 3000 });
            const draft = await sendToBackground<DraftResponse>({
              kind: "REQUEST_DRAFT",
              payload: { contactId: contact.id, type },
            });
            if (draft.ok) {
              showToast({
                title: "Draft ready",
                body: draft.data.message.draft_text,
                actions: [
                  {
                    label: "Insert into message",
                    onClick: () => injectDraft(draft.data.message.draft_text),
                  },
                  { label: "Dismiss", variant: "ghost", onClick: () => {} },
                ],
              });
            } else {
              showToast({ title: "Drafting failed", body: draft.error });
            }
          })();
        },
      },
      { label: "Not now", variant: "ghost", onClick: () => {} },
    ],
  });
}

observeDom(checkForReplies, { debounceMs: 800 });
checkForReplies();
void offerDraftOnProfile();
