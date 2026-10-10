import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { AppStoreState } from "../application/app-store";

export interface AppRuntime {
  store: StoreApi<AppStoreState>;
}

const AppRuntimeContext = createContext<AppRuntime | null>(null);

export function AppRuntimeProvider({
  children,
  store,
}: {
  children: ReactNode;
  store: StoreApi<AppStoreState>;
}) {
  const runtime = useMemo<AppRuntime>(() => ({store}), [store]);
  return (
    <AppRuntimeContext.Provider value={runtime}>
      {children}
    </AppRuntimeContext.Provider>
  );
}

export function useAppRuntime(): AppRuntime {
  const runtime = useContext(AppRuntimeContext);
  if (!runtime) {
    throw new Error("AppRuntimeProvider 尚未挂载");
  }
  return runtime;
}

export function useAppState<T>(
  selector: (state: AppStoreState) => T,
): T {
  const { store } = useAppRuntime();
  return useStore(store, selector);
}
