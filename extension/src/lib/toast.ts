/**
 * Lightweight in-page toast.
 *
 * Rendered into a shadow root rather than the page DOM: LinkedIn's stylesheet
 * is aggressive and would otherwise restyle our buttons, and our styles could
 * leak back into theirs. Plain DOM rather than React keeps the content script
 * bundle small, since this is the only UI it renders.
 */

const HOST_ID = "crm-toast-host";

export interface ToastAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "ghost";
}

export interface ToastOptions {
  title: string;
  body?: string;
  actions?: ToastAction[];
  /** Milliseconds before auto-dismiss. Toasts with actions never auto-dismiss. */
  timeoutMs?: number;
}

function ensureHost(): ShadowRoot {
  let host = document.getElementById(HOST_ID);
  if (host?.shadowRoot) return host.shadowRoot;

  host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "position:fixed;z-index:2147483647;top:16px;right:16px;";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .stack {
      display: flex; flex-direction: column; gap: 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .toast {
      width: 320px; background: #fff; color: #1d2226;
      border: 1px solid #e0e0e0; border-radius: 10px; padding: 12px 14px;
      box-shadow: 0 6px 20px rgba(0,0,0,.14);
      animation: slide .18s ease-out;
    }
    @keyframes slide { from { opacity: 0; transform: translateY(-6px) } to { opacity: 1 } }
    .title { font-size: 13px; font-weight: 600; margin: 0 0 2px; }
    .body { font-size: 12px; line-height: 1.45; color: #56687a; margin: 0; white-space: pre-wrap; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    button {
      font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
      border-radius: 16px; padding: 5px 12px; border: 1px solid transparent;
    }
    .primary { background: #0a66c2; color: #fff; }
    .primary:hover { background: #084e94; }
    .ghost { background: transparent; color: #0a66c2; border-color: #0a66c2; }
    .ghost:hover { background: #eef6ff; }
    @media (prefers-color-scheme: dark) {
      .toast { background: #1b1f23; color: #e8e6e3; border-color: #38434f; }
      .body { color: #9aa8b5; }
    }
  `;
  shadow.appendChild(style);

  const stack = document.createElement("div");
  stack.className = "stack";
  shadow.appendChild(stack);

  return shadow;
}

export function showToast(options: ToastOptions): () => void {
  const shadow = ensureHost();
  const stack = shadow.querySelector(".stack");
  if (!stack) return () => {};

  const toast = document.createElement("div");
  toast.className = "toast";

  const title = document.createElement("p");
  title.className = "title";
  title.textContent = options.title;
  toast.appendChild(title);

  if (options.body) {
    const body = document.createElement("p");
    body.className = "body";
    body.textContent = options.body;
    toast.appendChild(body);
  }

  const dismiss = () => {
    clearTimeout(timer);
    toast.remove();
  };

  if (options.actions?.length) {
    const actions = document.createElement("div");
    actions.className = "actions";
    for (const action of options.actions) {
      const button = document.createElement("button");
      button.className = action.variant === "ghost" ? "ghost" : "primary";
      button.textContent = action.label;
      button.addEventListener("click", () => {
        action.onClick();
        dismiss();
      });
      actions.appendChild(button);
    }
    toast.appendChild(actions);
  }

  stack.appendChild(toast);

  // Actionable toasts must persist: auto-dismissing one silently discards the
  // user's only chance to disambiguate a contact.
  const timeout = options.actions?.length ? 0 : (options.timeoutMs ?? 5000);
  const timer = timeout > 0 ? setTimeout(dismiss, timeout) : undefined;

  return dismiss;
}
