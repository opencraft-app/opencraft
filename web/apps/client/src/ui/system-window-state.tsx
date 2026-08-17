import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {AppState, Platform} from "react-native";

const SystemWindowActiveContext = createContext(true);

export interface SystemWindowStateProviderProps {
  children: ReactNode;
  /** Deterministic override for Style Lab and tests. */
  forcedActive?: boolean;
}

export function SystemWindowStateProvider({
  children,
  forcedActive,
}: SystemWindowStateProviderProps) {
  const [observedActive, setObservedActive] = useState(true);

  useEffect(() => {
    if (forcedActive !== undefined) return;
    const appState = AppState.addEventListener("change", (state) => {
      setObservedActive(state === "active");
    });
    if (Platform.OS !== "web" || typeof window === "undefined") {
      return () => appState.remove();
    }
    const activate = () => setObservedActive(true);
    const deactivate = () => setObservedActive(false);
    const visibility = () => setObservedActive(document.visibilityState === "visible");
    window.addEventListener("focus", activate);
    window.addEventListener("blur", deactivate);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      appState.remove();
      window.removeEventListener("focus", activate);
      window.removeEventListener("blur", deactivate);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [forcedActive]);

  return (
    <SystemWindowActiveContext.Provider
      value={forcedActive ?? observedActive}
    >
      {children}
    </SystemWindowActiveContext.Provider>
  );
}

export function useSystemWindowActive(): boolean {
  return useContext(SystemWindowActiveContext);
}
