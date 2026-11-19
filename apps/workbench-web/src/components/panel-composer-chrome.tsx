import type { BrowserComposerTransition } from "./use-browser-composer-motion";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface ChromeSlot {
  scope: string;
  token: symbol;
  tabId: string;
  header: HTMLElement;
  switcher: HTMLElement;
  transition?: BrowserComposerTransition;
}
interface ChromeContext {
  slot: ChromeSlot | null;
  publish(
    token: symbol,
    tabId: string,
    header: HTMLElement | null,
    switcher?: HTMLElement | null,
    transition?: BrowserComposerTransition,
  ): void;
}
const Context = createContext<ChromeContext | null>(null);

/** A presentation slot only: the tool retains its controls and action state. */
export function PanelComposerChromeProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const [slot, setSlot] = useState<ChromeSlot | null>(null);
  const publish = useCallback(
    (
      token: symbol,
      tabId: string,
      header: HTMLElement | null,
      switcher?: HTMLElement | null,
      transition?: BrowserComposerTransition,
    ) => {
      setSlot((previous) =>
        header && switcher
          ? { scope, token, tabId, header, switcher, transition }
          : previous?.token === token
            ? null
            : previous,
      );
    },
    [scope],
  );
  const value = useMemo(() => ({ slot: slot?.scope === scope ? slot : null, publish }), [slot, scope, publish]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const usePanelComposerChrome = () => useContext(Context);
