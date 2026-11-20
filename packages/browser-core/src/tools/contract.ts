export interface BrowserToolContext {
  /** Trusted platform binding supplies identity; model arguments cannot select it. */
  readonly hostId: string;
  readonly threadId: string;
  /** Platform execution identity, mapped by the harness adapter. */
  readonly turnId: string;
  readonly callId: string;
  readonly signal?: AbortSignal;
}

export interface BrowserToolHost {
  open(
    context: BrowserToolContext,
    argumentsValue: Readonly<Record<string, unknown>>,
  ): unknown | Promise<unknown>;
  getTabContext(
    context: BrowserToolContext,
    argumentsValue: Readonly<Record<string, unknown>>,
  ): unknown | Promise<unknown>;
  browserUse(
    context: BrowserToolContext,
    argumentsValue: Readonly<Record<string, unknown>>,
  ): unknown | Promise<unknown>;
}

export type BrowserToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly imageUrl: string };

export interface BrowserToolResult {
  readonly success: boolean;
  readonly content: readonly BrowserToolContent[];
}
