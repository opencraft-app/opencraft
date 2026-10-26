import * as SecureStore from "expo-secure-store";
import { CONTENT_SOURCE_KEY } from "./content-source";
export const sourceStorage = {
  read: () => SecureStore.getItemAsync(CONTENT_SOURCE_KEY),
  write: (value: string) => SecureStore.setItemAsync(CONTENT_SOURCE_KEY, value),
};
