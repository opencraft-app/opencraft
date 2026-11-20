import type { ComposerController } from "@opencraft/composer-core";
import { createContext, useContext, type ReactNode } from "react";

// Only the controller seam belongs to startup. Validation, serialization and
// draft subscription are loaded with the browser/HTML panel, not with App.
const Context = createContext<ComposerController | null>(null);
export function BrowserAnnotationSinkProvider({ controller, children }: { readonly controller: ComposerController; readonly children: ReactNode }) {
  return <Context.Provider value={controller}>{children}</Context.Provider>;
}
export function useAnnotationComposerController() { return useContext(Context); }
