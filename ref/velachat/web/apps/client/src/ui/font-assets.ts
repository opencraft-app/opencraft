import { useFonts } from "expo-font";

export const velaFontAssets = {} as const;

export function useVelaFonts(): [boolean, Error | null] {
  return useFonts(velaFontAssets);
}
