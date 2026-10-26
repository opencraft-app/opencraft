import { defineDoc } from "@earendil-works/pi-durable";

type Value = Record<string, any>;
/** Pending message custody, in the native conversation DB; submissions own execution receipts. */
export type PiQueuedInput = {
  id: string;
  clientId: string;
  input: Value[];
  content: Value[];
  additionalContext: Value | null;
  createdAtMs: number;
  state: "queued" | "dispatching";
}
export type PiQueueState = { items: PiQueuedInput[]; paused: boolean; pauseReason?: "user-stopped" | "delivery-failed" };
export const PiQueueDoc = defineDoc<PiQueueState>({
  kind: "opencraft.queue", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ items: [], paused: false }),
});
export const queueProjection = (item: PiQueuedInput, paused = false, reason = "user-stopped") => ({
  id: item.id, input: item.input, clientUserMessageId: item.clientId, createdAt: item.createdAtMs,
  pausedReason: paused ? reason : null,
});
