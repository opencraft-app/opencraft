// TypeScript fallback. Metro resolves credential-store.web.ts or
// credential-store.native.ts before this file for the target platform.
export { createCredentialStore } from "./credential-store.native";
