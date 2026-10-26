import { CONTENT_SOURCE_KEY } from "./content-source";
export const sourceStorage = {
  read: async () => localStorage.getItem(CONTENT_SOURCE_KEY),
  write: async (value: string) => { localStorage.setItem(CONTENT_SOURCE_KEY, value); },
};
