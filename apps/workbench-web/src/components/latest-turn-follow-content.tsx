import { createContext, useContext } from "react";

/** The latest Turn provides this ref; historical Turns never register targets. */
export const LatestTurnFollowContentContext = createContext<
  ((element: HTMLDivElement | null) => (() => void) | undefined) | undefined
>(undefined);

export function useLatestTurnFollowContentRef() {
  return useContext(LatestTurnFollowContentContext);
}
