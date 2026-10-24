import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

/** Keep native dialog auto-focus visually tied to the action that opened it. */
export function usePreviewFocusOrigin() {
  const [openedByPointer, setOpenedByPointer] = useState(false);
  const pointerActivation = useRef(false);

  return {
    openedByPointer,
    onTriggerPointerDown: () => { pointerActivation.current = true; },
    onTriggerPointerCancel: () => { pointerActivation.current = false; },
    onTriggerKeyDown: () => { pointerActivation.current = false; },
    recordOpen: (event: MouseEvent<HTMLButtonElement>) => {
      setOpenedByPointer(event.detail > 0 || pointerActivation.current);
      pointerActivation.current = false;
    },
    onPreviewKeyDown: (event: KeyboardEvent<HTMLDialogElement>) => {
      if (event.key === "Tab") setOpenedByPointer(false);
    },
  };
}
