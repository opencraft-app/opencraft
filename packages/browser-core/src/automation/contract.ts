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
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly disabled: boolean;
}

export interface BrowserAutomationInspection {
  readonly url: string;
  readonly title: string;
  readonly revision: number;
  readonly elements: readonly BrowserAutomationElement[];
}

/** Product-level browser semantics. Physical engines implement this port. */
export interface BrowserAutomation {
  readonly capabilities: BrowserAutomationCapabilities;
  readContext(options?: {
    readonly includeSelection?: boolean;
    readonly maxInlineChars?: number;
  }): Promise<BrowserAutomationPageContext>;
  inspect(): Promise<BrowserAutomationInspection>;
  click(input: { readonly ref: string; readonly expectedRevision: number }): Promise<void>;
  fill(input: {
    readonly ref: string;
    readonly expectedRevision: number;
    readonly value: string;
  }): Promise<void>;
  press(input: { readonly key: string }): Promise<void>;
  scroll(input: { readonly x: number; readonly y: number }): Promise<void>;
  wait(input: { readonly text: string; readonly timeoutMs: number }): Promise<void>;
  dispose(): void;
}
