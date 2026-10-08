/** Explicit mobile text transaction; not a clipboard reader or hidden global
 * key listener. A retired input DOM is never reused by a successor grant. */
export function createDesktopTextInput(element: HTMLElement, allowed: () => boolean,
  sendKey: (keysym: number) => void) {
  let session: { focus(): void; retire(): void } | null = null;
  const special: Readonly<Record<string, number>> = { Enter: 0xff0d, Backspace: 0xff08,
    Delete: 0xffff, Tab: 0xff09, Escape: 0xff1b, ArrowLeft: 0xff51,
    ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54 };
  return {
    focus(label: string) {
      if (!allowed()) return;
      if (session) { session.focus(); return; }
      const input = element.ownerDocument.createElement("textarea");
      input.className = "cloud-desktop-panel__text-input";
      input.setAttribute("aria-label", label); input.setAttribute("autocapitalize", "off");
      input.autocomplete = "off"; input.spellcheck = false; input.inputMode = "text"; input.tabIndex = -1;
      let alive = true, composing = false;
      const current = { focus: () => { if (valid()) input.focus({ preventScroll: true }); },
        retire: () => { alive = false; composing = false; input.value = ""; input.remove(); } };
      const valid = () => alive && session === current && allowed();
      const commit = (text: string) => {
        if (!valid() || text.length > 2048) return;
        for (const character of text) {
          if (!valid()) return;
          const code = character.codePointAt(0)!;
          if (code === 10) sendKey(0xff0d);
          else if (code === 9) sendKey(0xff09);
          else if (code >= 32 && !(code >= 0xd800 && code <= 0xdfff)) sendKey(code <= 255 ? code : 0x01000000 | code);
        }
      };
      const key = (event: KeyboardEvent) => {
        // Printable text/IME is committed through input, never also keydown.
        event.stopPropagation();
        if (composing || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
        const symbol = special[event.key];
        if (symbol !== undefined) { event.preventDefault(); if (valid()) sendKey(symbol); }
      };
      const start = () => { if (valid()) composing = true; };
      const end = (event: CompositionEvent) => {
        // Candidate changes stay local; only one compositionend commits.
        if (composing) { composing = false; commit(event.data); }
        input.value = "";
      };
      const before = (event: InputEvent) => {
        if (composing || event.isComposing) return;
        if (!valid() || event.inputType === "insertFromPaste" || event.inputType === "insertFromDrop") {
          event.preventDefault(); return;
        }
        const symbol = event.inputType === "deleteContentBackward" ? 0xff08
          : event.inputType === "deleteContentForward" ? 0xffff
            : event.inputType === "insertLineBreak" || event.inputType === "insertParagraph" ? 0xff0d : undefined;
        if (symbol !== undefined) { event.preventDefault(); sendKey(symbol); }
      };
      const changed = (nativeEvent: Event) => {
        if (!(nativeEvent instanceof element.ownerDocument.defaultView!.InputEvent)) return;
        const event = nativeEvent as InputEvent;
        if (composing || event.isComposing) return;
        // Composition input is covered by the composition transaction, even
        // when a browser's final input notification arrives after its end.
        if (event.inputType !== "insertCompositionText" && event.inputType !== "insertFromComposition"
          && event.inputType !== "insertFromPaste" && event.inputType !== "insertFromDrop") commit(input.value);
        input.value = "";
      };
      const paste = (event: ClipboardEvent) => { event.preventDefault(); };
      input.addEventListener("keydown", key); input.addEventListener("keyup", event => event.stopPropagation());
      input.addEventListener("compositionstart", start); input.addEventListener("compositionend", end);
      input.addEventListener("beforeinput", before); input.addEventListener("input", changed);
      input.addEventListener("paste", paste);
      element.appendChild(input);
      session = current;
      current.focus();
    },
    /** Transfer focus before changing the remote target. The platform's
     * synchronous compositionend can commit only to the old target; delayed
     * completion belongs to the retired transaction and is never replayed. */
    finish(transferFocus: () => void) {
      const previous = session;
      try { transferFocus(); }
      finally {
        if (session === previous) session = null;
        previous?.retire();
      }
    },
    reset() { const previous = session; session = null; previous?.retire(); },
  };
}
