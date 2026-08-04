import * as SecureStore from "expo-secure-store";

import { SecureCredentialStore } from "./secure-credential-store";

export function createCredentialStore(): SecureCredentialStore {
  return new SecureCredentialStore(SecureStore);
}
