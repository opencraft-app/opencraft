/**
 * Send motion handoff. The Composer and the transcript are separate owners, so
 * the Composer's last visible text box is recorded at the moment of sending and
 * the next live user bubble that matches it animates from there (FLIP).
 */
interface SendOrigin {
  readonly rect: DOMRect;
  readonly text: string;
  readonly at: number;
}
let origin: SendOrigin | null = null;
let installed = false;
const FRESH_MS = 2_000;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

function capture(target: EventTarget | null) {
  const element = target instanceof Element ? target : null;
  const composer = element?.closest(".opencraft-composer");
  const editor = composer?.querySelector<HTMLElement>(
    ".opencraft-composer-editor-mount .ProseMirror, .opencraft-composer-editor-mount",
  );
  if (!editor) return;
  const text = normalize(editor.innerText ?? "");
  if (!text) return;
  // Record only. Nothing moves until a matching bubble is actually inserted,
  // so a consumed Enter (command menu, rejection) leaves the field untouched.
  origin = { rect: editor.getBoundingClientRect(), text, at: performance.now() };
}

export function installSendFlight() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      capture(event.target);
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      const button =
        event.target instanceof Element ? event.target.closest(".opencraft-composer-submit:not(.is-stop)") : null;
      if (button) capture(button);
    },
    true,
  );
}

export function reducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Consume the origin once if it belongs to this message. */
export function takeSendOrigin(message: string): DOMRect | null {
  const current = origin;
  if (!current || performance.now() - current.at > FRESH_MS) return null;
  const text = normalize(message);
  if (!text || !(text.startsWith(current.text.slice(0, 40)) || current.text.startsWith(text.slice(0, 40)))) return null;
  origin = null;
  return current.rect;
}

/** Fly a freshly inserted bubble from the Composer to its final place. */
export function playSendFlight(element: HTMLElement, from: DOMRect | null) {
  if (reducedMotion() || !element.animate) return;
  const to = element.getBoundingClientRect();
  if (!from || to.width === 0) {
    element.animate(
      [
        { opacity: 0, transform: "translateY(8px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
    return;
  }
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const sx = Math.min(1.15, Math.max(0.6, from.width / to.width));
  element.style.transformOrigin = "100% 50%";
  element.animate(
    [
      { opacity: 0.6, transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sx})`, offset: 0 },
      { opacity: 1, offset: 0.35 },
      { opacity: 1, transform: "none", offset: 1 },
    ],
    { duration: 320, easing: "cubic-bezier(.22,1.15,.36,1)" },
  );
}
