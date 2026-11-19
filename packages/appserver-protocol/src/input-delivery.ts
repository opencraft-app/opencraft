/** Host custody, engine admission, context evidence and execution are independent facts.
 * A terminal execution fences future use of that attempt; it does not prove that
 * the model used (or never used) its input. Retries are new, explicit attempts. */
export interface InputDeliveryReceipt {
  readonly version: 1;
  readonly custody: "accepted";
  readonly nativeAdmission: "pending" | "accepted" | "unknown" | "rejected";
  readonly context: "unobserved" | "recorded";
  readonly targetTurnId: string | null;
  readonly execution: "unbound" | "running" | "completed" | "interrupted" | "failed";
  readonly revision: number;
}

export function inputExecutionEnded(receipt: InputDeliveryReceipt | undefined): boolean {
  return receipt !== undefined && ["completed", "interrupted", "failed"].includes(receipt.execution);
}

export function parseInputDeliveryReceipt(value: unknown): InputDeliveryReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 ||
    v.custody !== "accepted" ||
    !Number.isSafeInteger(v.revision) ||
    Number(v.revision) < 1 ||
    !["pending", "accepted", "unknown", "rejected"].includes(String(v.nativeAdmission)) ||
    !["unobserved", "recorded"].includes(String(v.context)) ||
    !["unbound", "running", "completed", "interrupted", "failed"].includes(String(v.execution)) ||
    !(v.targetTurnId === null || (typeof v.targetTurnId === "string" && v.targetTurnId.length > 0))
  )
    return undefined;
  if (v.execution !== "unbound" && (!v.targetTurnId || v.targetTurnId === "unknown")) return undefined;
  return {
    version: 1,
    custody: "accepted",
    nativeAdmission: v.nativeAdmission as InputDeliveryReceipt["nativeAdmission"],
    context: v.context as InputDeliveryReceipt["context"],
    execution: v.execution as InputDeliveryReceipt["execution"],
    targetTurnId: v.targetTurnId as string | null,
    revision: Number(v.revision),
  };
}

export { parseInputCompletion } from "./input-completion.mjs";
export type { InputCompletion } from "./input-completion.mjs";
