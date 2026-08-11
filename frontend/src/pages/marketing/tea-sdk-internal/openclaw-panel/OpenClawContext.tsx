import { createContext, useContext } from 'react';
import type { IOpenClawContextValue } from './types';

const OpenClawContext = createContext<IOpenClawContextValue | null>(null);

export const OpenClawProvider = OpenClawContext.Provider;

export function useOpenClawContext(): IOpenClawContextValue {
  const ctx = useContext(OpenClawContext);
  if (!ctx) {
    throw new Error('useOpenClawContext must be used within OpenClawProvider');
  }
  return ctx;
}
