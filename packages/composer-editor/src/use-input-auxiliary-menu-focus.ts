import { useEffect, useRef, type PointerEvent, type KeyboardEvent, type MouseEvent } from "react";

function editorHasFocus(editor: HTMLElement | null): boolean {
  if (!editor?.isConnected) return false;
  const root = editor.getRootNode() as Document | ShadowRoot;
  return editor.contains(root.activeElement);
}

/** Opt-in presentation adapter for non-modal Radix menus beside an editor.
 * Pointer editing keeps its existing focus lease; keyboard/AT retain Radix focus.
 * No keyboard API, timer, selection rewrite or blur/refocus loop is involved.
 */
export function useInputAuxiliaryMenuFocus(options: {
  open: boolean;
  onOpenChange(open: boolean): void;
  getEditor(): HTMLElement | null;
  /** Lets the containing presentation check focus after Radix close cleanup. */
  onCloseFocusSettling?(): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const preserve = useRef(false);
  const content = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!options.open || !preserve.current) return;
    const editor = options.getEditor();
    if (!editor) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!preserve.current || !editorHasFocus(editor) || event.isComposing || event.keyCode === 229) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const items = content.current?.querySelectorAll<HTMLElement>(':is([role^="menuitem"], [role="slider"]):not([aria-disabled="true"])');
        const target = event.key === "ArrowUp" ? items?.[items.length - 1] : items?.[0];
        if (target) {
          preserve.current = false;
          event.preventDefault();
          target.focus({ preventScroll: true });
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        latest.current.onOpenChange(false);
      } else if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        // Typing and Tab resume the editor's ordinary behavior, without stealing focus.
        latest.current.onOpenChange(false);
      }
    };
    editor.ownerDocument.addEventListener("keydown", onKeyDown, true);
    return () => editor.ownerDocument.removeEventListener("keydown", onKeyDown, true);
  }, [options.open]);

  return {
    preservesEditorFocus: () => preserve.current && editorHasFocus(latest.current.getEditor()),
    triggerProps: {
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        const editor = latest.current.getEditor();
        const editing = editorHasFocus(editor);
        if ((event.pointerType === "touch" || event.pointerType === "pen") && editing && event.isPrimary && event.button === 0) {
          preserve.current = true;
          // The shared trigger retains native scrolling and opens on a completed tap.
          // Record the focus lease now, without opening or taking focus.
        } else {
          preserve.current = false;
        }
      },
      onKeyDown(_event: KeyboardEvent<HTMLButtonElement>) { preserve.current = false; },
    },
    contentProps: {
      onEscapeKeyDown(event: globalThis.KeyboardEvent) {
        // An active input method owns Escape before Radix document dismissal.
        if (event.isComposing || event.keyCode === 229) event.preventDefault();
      },
      ref(node: HTMLDivElement | null) { content.current = node; },
      onOpenAutoFocus(event: Event) {
        const editor = latest.current.getEditor();
        if (preserve.current && editorHasFocus(editor)) event.preventDefault();
        else preserve.current = false;
      },
      onPointerDown(event: PointerEvent<HTMLDivElement>) {
        if (!preserve.current) return;
        const editor = latest.current.getEditor();
        if (!editorHasFocus(editor)) { preserve.current = false; return; }
        const target = event.target as Element;
        if (target.closest('input, textarea, [contenteditable="true"], a[href]')) {
          preserve.current = false;
          return;
        }
        // Bubble after Radix records the inside press; cancelling capture would
        // make its dismiss layer mistake a touch selection for an outside click.
        // Menu items remain clickable/scrollable while the editor retains selection.
        event.preventDefault();
      },
      onMouseDownCapture(event: MouseEvent<HTMLDivElement>) {
        if (preserve.current) event.preventDefault();
      },
      onCloseAutoFocus(event: Event) {
        latest.current.onCloseFocusSettling?.();
        if (preserve.current || !mounted.current) event.preventDefault();
        preserve.current = false;
      },
    },
  };
}
