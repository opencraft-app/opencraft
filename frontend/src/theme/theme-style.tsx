import { useLayoutEffect } from "react";
import { activeThemePreset } from "@/theme/preset";

export const ThemeStyleInjector = () => {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previousTheme = root.dataset.theme;
    const previousValues = new Map<string, string>();

    for (const [key, value] of Object.entries(activeThemePreset.variables)) {
      previousValues.set(key, root.style.getPropertyValue(key));
      root.style.setProperty(key, value);
    }

    root.dataset.theme = activeThemePreset.id;

    return () => {
      for (const [key, value] of previousValues) {
        if (value) {
          root.style.setProperty(key, value);
        } else {
          root.style.removeProperty(key);
        }
      }

      if (previousTheme === undefined) {
        delete root.dataset.theme;
      } else {
        root.dataset.theme = previousTheme;
      }
    };
  }, []);

  return null;
};
