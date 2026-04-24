import { useLayoutEffect } from "react";
import { activeThemePreset } from "@/theme/preset";

export const ThemeStyleInjector = () => {
  useLayoutEffect(() => {
    const root = document.documentElement;

    for (const [key, value] of Object.entries(activeThemePreset.variables)) {
      root.style.setProperty(key, value);
    }

    root.dataset.theme = activeThemePreset.id;
  }, []);

  return null;
};
