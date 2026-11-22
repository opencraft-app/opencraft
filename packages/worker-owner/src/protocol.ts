/** Messages between a WorkerOwner and the Worker that owns blocking IO. */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  /** Own enumerable fields such as `code`, `status` or `kind`, structured-cloned. */
  readonly fields: Record<string, unknown>;
}

export type OwnerRequest = { readonly id: number; readonly method: string; readonly args: readonly unknown[] };

export type OwnerReply =
  | { readonly ready: true; readonly value: unknown }
  | { readonly ready: false; readonly error: SerializedError }
  | { readonly id: number; readonly value: unknown }
  | { readonly id: number; readonly error: SerializedError; readonly fatal: boolean };

/** The close marker. It runs after every earlier request, then the Worker exits. */
export const CLOSE_METHOD = "__close__";

export function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) return { name: "Error", message: String(error), fields: {} };
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    try {
      fields[key] = structuredClone(value);
    } catch {
      // A field that cannot cross the boundary stays with the owner.
    }
  }
  return { name: error.name, message: error.message, fields };
}
