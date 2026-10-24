import { createContext } from "react";

export interface NativeTurnTargetLayout {
  readonly topPx: number;
  readonly heightPx: number;
}

export type NativeTurnTargetReporter = (
  targetKey: string,
  layout: NativeTurnTargetLayout | null,
) => void;

export const NativeTurnTargetContext = createContext<NativeTurnTargetReporter | null>(null);
