import { useFonts } from "expo-font";

export const raftFontAssets = {} as const;

export function useRaftFonts(): [boolean, Error | null] {
  return useFonts(raftFontAssets);
}
