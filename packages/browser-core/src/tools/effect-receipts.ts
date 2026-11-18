/** Platform-supplied execution identity; never populated from tool arguments. */
export interface BrowserEffectRequest {
  readonly ownerId: string;
  readonly hostId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly resource?: { readonly tabId: string; readonly pageId: string };
  readonly action: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}
/** A logicalClose result means close, retirement and metadata deletion have
 * committed together. Native view destruction is cleanup, even after cancel.
 * Ports must recheck authorize after preparation and before submitting admission. */
export interface BrowserEffectReceipts {
  admit(request: BrowserEffectRequest, options?: { readonly authorize?: () => void }): Promise<{ admitted: true; logicalClose?: boolean } | { admitted: false; result: unknown; logicalClose?: boolean }>;
  settle(request: BrowserEffectRequest, status: 'completed' | 'failed' | 'unknown', result?: unknown): Promise<void>;
}
