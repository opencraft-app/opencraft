import { useEffect, useRef } from "react";
import { AppState } from "react-native";

export function useAppActive(onActive: () => void): void {
  const onActiveRef = useRef(onActive);

  useEffect(() => {
    onActiveRef.current = onActive;
  }, [onActive]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        onActiveRef.current();
      }
    });
    return () => subscription.remove();
  }, []);
}
