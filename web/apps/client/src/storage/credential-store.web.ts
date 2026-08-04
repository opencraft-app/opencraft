import { BrowserCredentialStore } from "./browser-credential-store";

export function createCredentialStore(): BrowserCredentialStore {
  return new BrowserCredentialStore(globalThis.localStorage);
}
