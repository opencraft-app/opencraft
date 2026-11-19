export interface BrowserAutomationCapabilities {
  readonly protocolVersion: 1;
  readonly backend: "preview-bridge" | "electron-cdp" | "playwright";
  readonly domInspection: boolean;
  readonly semanticInput: boolean;
  readonly trustedInput: boolean;
  readonly networkObservation: "none" | "fetch-xhr" | "full";
  readonly screenshot: boolean;
  readonly deviceEmulation: "none" | "viewport-only" | "full";
}

export interface BrowserAutomationPageContext {
  /** Native observation identity; absent on legacy preview backends. */
  readonly frameId?: string;
  readonly documentId?: string;
  readonly url: string;
  readonly title: string;
  readonly revision: number;
  readonly selection: string | null;
  readonly content: string;
}

export interface BrowserAutomationElement {
  readonly ref: string;
  /** Present for native engines; references are scoped to a frame and loaded page */
  readonly frameId?: string;
  readonly documentId?: string;
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly disabled: boolean;
}

export interface BrowserAutomationInspection {
  /** Native main-frame document; revision retains its existing snapshot meaning. */
  readonly frameId?: string;
  readonly documentId?: string;
  readonly url: string;
  readonly title: string;
  readonly revision: number;
  readonly elements: readonly BrowserAutomationElement[];
}

/** Product-level browser semantics. Physical engines implement this port. */
export interface BrowserAutomationCallOptions { readonly signal?: AbortSignal }
export interface BrowserAutomation {
  readonly capabilities: BrowserAutomationCapabilities;
  readContext(options?: {
    readonly includeSelection?: boolean;
    readonly maxInlineChars?: number;
  }, invocation?: BrowserAutomationCallOptions): Promise<BrowserAutomationPageContext>;
  inspect(invocation?: BrowserAutomationCallOptions): Promise<BrowserAutomationInspection>;
  click(input: { readonly ref: string; readonly expectedRevision: number }, invocation?: BrowserAutomationCallOptions): Promise<void>;
  fill(input: {
    readonly ref: string;
    readonly expectedRevision: number;
    readonly value: string;
  }, invocation?: BrowserAutomationCallOptions): Promise<void>;
  press(input: { readonly key: string }, invocation?: BrowserAutomationCallOptions): Promise<void>;
  scroll(input: { readonly x: number; readonly y: number }, invocation?: BrowserAutomationCallOptions): Promise<void>;
  wait(input: { readonly text: string; readonly timeoutMs: number }, invocation?: BrowserAutomationCallOptions): Promise<void>;
  dispose(): void;
}
