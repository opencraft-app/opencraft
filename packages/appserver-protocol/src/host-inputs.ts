/** Trusted Host admission, independent of a browser connection. No second queue:
 * waiting means no native input was attempted; unknown must never be replayed. */
export interface HostInputReceipt {
  state: "delivered" | "unknown" | "discarded";
  turnId: string | null;
}
export interface HostInputPort {
  receipt(threadId: string, inputId: string): Promise<HostInputReceipt | null>;
  submit(threadId: string, inputId: string, text: string, canAdmit: () => boolean | Promise<boolean>): Promise<HostInputReceipt | null>;
}
