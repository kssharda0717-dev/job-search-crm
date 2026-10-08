/** Shared DOM helpers for content scripts. */

/**
 * Try a list of selectors in priority order and return the first match's text.
 *
 * LinkedIn ships DOM changes constantly and their class names are hashed, so a
 * single selector is guaranteed to rot. Ordered fallbacks — stable attributes
 * first, then structural classes — degrade instead of breaking outright.
 */
export function textFrom(selectors: string[], root: ParentNode = document): string | null {
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    const text = el?.textContent?.trim();
    if (text) return normalizeWhitespace(text);
  }
  return null;
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** First element matching any selector in the list, in priority order. */
export function findFirst(
  selectors: string[],
  root: ParentNode = document,
): Element | null {
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    if (el) return el;
  }
  return null;
}

/**
 * Extract readable text while preserving line structure, which matters for
 * resumes and job descriptions where bullets carry meaning.
 */
export function blockText(el: Element | null): string | null {
  if (!el) return null;

  // Read the live element. This used to clone first, to strip script/style
  // tags, and that silently destroyed the only thing the function exists to
  // provide. `innerText` is defined in terms of layout: the spec says that when
  // an element "is not being rendered" the getter returns `textContent`
  // instead, and a clone is detached from the document, so it is never
  // rendered. Measured on a real LinkedIn profile, the Experience card returned
  // 61 lines live and 1 line cloned.
  //
  // Every positional read downstream splits on "\n" — the headline under the
  // name, a role under its employer, a person's name on a people card — so all
  // of them were reading index 0 of a single blob and finding nothing at index
  // 1. The clone was also unnecessary: script, style and noscript are not
  // rendered, so `innerText` already omits them.
  const text = (el as HTMLElement).innerText ?? el.textContent ?? "";
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n") || null
  );
}

/** Resolve when a matching element appears, or null on timeout. */
export function waitForElement(
  selector: string,
  timeoutMs = 10_000,
): Promise<Element | null> {
  const existing = document.querySelector(selector);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearTimeout(timer);
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/**
 * Watch for DOM changes with a trailing debounce. SPA route changes fire
 * hundreds of mutations; re-scraping on each one is wasteful and can trip
 * rate limits on downstream calls.
 */
export function observeDom(
  callback: () => void,
  { debounceMs = 400 }: { debounceMs?: number } = {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(callback, debounceMs);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  return () => {
    clearTimeout(timer);
    observer.disconnect();
  };
}

/**
 * Delegated click listener. Bound at the document so it survives LinkedIn
 * re-rendering the button, which a direct listener would not.
 */
export function onClickMatching(
  selectors: string[],
  handler: (el: Element, event: MouseEvent) => void,
): () => void {
  const listener = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    for (const selector of selectors) {
      const match = target.closest(selector);
      if (match) {
        handler(match, event);
        return;
      }
    }
  };

  // Capture phase: the app's own handler may tear the node out of the DOM
  // before a bubbling listener would ever see the event.
  document.addEventListener("click", listener, true);
  return () => document.removeEventListener("click", listener, true);
}

/** Controls a user can click. `menuitem` covers LinkedIn's overflow menus. */
const CLICKABLE = "button, a, [role='button'], [role='menuitem'], [role='menuitemradio']";

/**
 * The name a screen reader would announce for a control.
 *
 * `aria-label` is only half of it. LinkedIn sets one on people-card buttons but
 * not on its top-card buttons or its overflow-menu items, where the name comes
 * from the visible text — so a selector like `[aria-label*='connect']` misses
 * exactly the surfaces where the label is plainest. Both sources are checked
 * here, and the text is deduplicated because LinkedIn routinely renders the
 * word twice, once visibly and once in a visually-hidden span ("Connect
 * Connect").
 */
export function accessibleName(el: Element): string {
  const label = el.getAttribute("aria-label");
  const raw = label ?? (el as HTMLElement).innerText ?? el.textContent ?? "";

  const words: string[] = [];
  for (const word of normalizeWhitespace(raw).split(" ")) {
    if (word && word !== words[words.length - 1]) words.push(word);
  }
  return words.join(" ");
}

/**
 * Delegated click listener keyed on a control's accessible name rather than on
 * a CSS selector.
 *
 * Selectors are the wrong tool for LinkedIn: class names are build hashes, and
 * the same logical button is a `button` on one surface, a `div[role=button]` on
 * another and a menu item on a third. What does not change is what the button
 * says. Two rounds of selector guessing have already failed silently here, and
 * a capture that fails silently is indistinguishable from the extension being
 * broken.
 */
export function onClickNamed(
  matches: (name: string) => boolean,
  handler: (el: Element, event: MouseEvent) => void,
): () => void {
  const listener = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const control = target.closest(CLICKABLE);
    if (control && matches(accessibleName(control))) handler(control, event);
  };

  // Capture phase: the app's own handler may tear the node out of the DOM
  // before a bubbling listener would ever see the event.
  document.addEventListener("click", listener, true);
  return () => document.removeEventListener("click", listener, true);
}

/**
 * Set a value on a React-controlled input so the framework registers the change.
 * Assigning `.value` directly updates the DOM but React's synthetic event system
 * never sees it, and the app reverts the field on its next render.
 */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
