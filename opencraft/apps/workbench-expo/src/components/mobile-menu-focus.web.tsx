import type { ReactNode } from "react";
import { FocusScope } from "@radix-ui/react-focus-scope";
import { DismissableLayer } from "@radix-ui/react-dismissable-layer";
import * as RovingFocus from "@radix-ui/react-roving-focus";
import type { MobileMenuFocusProps } from "./mobile-menu-focus";

/** Browser keyboard policy for HeroUI Native Menu; geometry/state stay in Menu. */
export function MobileMenuFocus({ children, dismiss, allowReturnFocus }: MobileMenuFocusProps) {
  return <FocusScope asChild loop trapped onUnmountAutoFocus={event => {
    if (!allowReturnFocus()) event.preventDefault();
  }}>
    <DismissableLayer style={{ display: "contents" }} onDismiss={dismiss} onFocusOutside={event => event.preventDefault()}>
      <RovingFocus.Root asChild orientation="vertical" loop preventScrollOnEntryFocus>
        {children}
      </RovingFocus.Root>
    </DismissableLayer>
  </FocusScope>;
}

export function MobileMenuFocusItem({ children, disabled = false }: { children: ReactNode; disabled?: boolean }) {
  return <RovingFocus.Item asChild focusable={!disabled}>{children}</RovingFocus.Item>;
}
