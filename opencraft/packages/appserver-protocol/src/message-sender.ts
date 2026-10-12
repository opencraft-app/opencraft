/** OpenCraft-owned provenance, never native model input or an authorization grant. */
export interface MessageSender {
  readonly kind: "employee";
  readonly loginName: string;
}
