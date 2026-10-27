import { createContext } from "react";

/** Reading state belongs to one Conversation View, never to command execution. */
export interface CommandViewState {
  readonly open: boolean;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly followOutput: boolean;
}

export const CommandViewStateContext = createContext<Map<string, CommandViewState> | null>(null);
