import { createContext, useContext } from "react";
import type { ComposerCatalogEntry, ComposerCatalogQuery } from "@opencraft/composer-core";
export interface ConversationReferencePort {
  search(query: ComposerCatalogQuery, signal?: AbortSignal): Promise<readonly ComposerCatalogEntry[]>;
  open(reference: string): void;
}
const Context = createContext<ConversationReferencePort | null>(null);
export const ConversationReferenceProvider = Context.Provider;
export const useConversationReferences = () => useContext(Context);
