import { createContext } from "react";

/** Shared open state for native menu activation and its opening contact. */
export const MenuInteraction = createContext<{ open: boolean; change(open: boolean): void } | null>(null);
