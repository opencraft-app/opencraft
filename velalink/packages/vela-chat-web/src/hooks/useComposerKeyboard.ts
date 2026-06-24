"use client";

import type { KeyboardEvent } from "react";

export function useComposerKeyboard(onSubmit: () => void) {
  return (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    onSubmit();
  };
}
