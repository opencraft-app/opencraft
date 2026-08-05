import { useEffect, useRef, type RefObject } from "react";
import { AppState } from "react-native";

export function useAppActive(onActive: () => void): RefObject<boolean> {
  const onActiveRef = useRef(onActive);
  const activeRef = useRef(
    AppState.currentState !== "background" &&
      AppState.currentState !== "inactive",
  );

  useEffect(() => {
    onActiveRef.current = onActive;
  }, [onActive]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      activeRef.current = state === "active";
      if (state === "active") {
        onActiveRef.current();
      }
    });
    return () => subscription?.remove();
  }, []);

  return activeRef;
}
