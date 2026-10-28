import { defineDoc } from "@earendil-works/pi-durable";

/** Native custody survives transport failure and owner restart. No arguments,
 * credentials or response payload are copied into the handoff proof. */
export type PiPrivateCalls = { calls: Record<string, { state: "pending" | "unknown" }> };
export const PiPrivateCallsDoc = defineDoc<PiPrivateCalls>({
  kind: "opencraft.privateCalls", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ calls: {} }),
});
