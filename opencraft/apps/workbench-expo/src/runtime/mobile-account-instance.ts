import { createMobileLightVelaAccount } from "./lightvela-account";

// The account outlives route changes, including the native login callback.
export const mobileAccount = createMobileLightVelaAccount();
