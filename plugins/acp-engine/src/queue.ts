import { createHash } from "node:crypto";

type Value = Record<string, any>;
export interface AcpQueuedInput {
  id: string;
  clientUserMessageId: string;
  input: Value[];
  additionalContext: Value | null;
  createdAt: number;
  state: "queued" | "dispatching";
}
export interface AcpQueue {
  items: AcpQueuedInput[];
  pausedReason: "user-stopped" | "delivery-failed" | null;
  /** Small admission tombstones prevent lost ACKs and deleted inputs from replaying. */
  admissions: Record<string, { fingerprint: string; id: string; createdAt: number }>;
}
export const emptyAcpQueue = (): AcpQueue => ({ items: [], pausedReason: null, admissions: {} });
export const acpQueueFingerprint = (input: Value[], additionalContext: Value | null): string =>
  createHash("sha256").update(JSON.stringify([input, additionalContext])).digest("hex");
export const acpQueueProjection = (item: AcpQueuedInput, queue: AcpQueue) => ({
  id: item.id, input: item.input, clientUserMessageId: item.clientUserMessageId,
  createdAt: item.createdAt, pausedReason: queue.pausedReason,
});
export function validateAcpQueue(queue: AcpQueue): void {
  if (!queue || !Array.isArray(queue.items) || ![null, "user-stopped", "delivery-failed"].includes(queue.pausedReason)
    || !queue.admissions || typeof queue.admissions !== "object" || Array.isArray(queue.admissions)) throw new Error("Invalid ACP queue metadata");
  const ids = new Set<string>();
  for (const entry of Object.values(queue.admissions)) {
    if (!entry || typeof entry.id !== "string" || !/^[a-f0-9]{64}$/u.test(entry.fingerprint) || !Number.isFinite(entry.createdAt)) throw new Error("Invalid ACP queue admission");
  }
  for (const item of queue.items) {
    if (!item || typeof item.id !== "string" || ids.has(item.id) || typeof item.clientUserMessageId !== "string"
      || !Array.isArray(item.input) || !item.input.length || !["queued", "dispatching"].includes(item.state)
      || !Number.isFinite(item.createdAt) || queue.admissions[item.clientUserMessageId]?.id !== item.id) throw new Error("Invalid ACP queued input");
    ids.add(item.id);
  }
}
