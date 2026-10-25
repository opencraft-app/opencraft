/** Compatibility entry for the shared elapsed clock. Wall diagnostics stay separate. */
export { createElapsedNow as createRecoveryNow, elapsedNow as recoveryNow } from "@opencraft/appserver-client/clock";
