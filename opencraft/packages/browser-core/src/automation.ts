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

const SENSITIVE_CONTROL_PATTERN = /(?:pass(?:word|code)?|secret|token|api[-_\s]?key|credential|authorization|cookie|one[-_\s]?time|otp|cc[-_\s]?(?:number|csc|cvv))/iu;

/** Shared policy used by every physical adapter before page data crosses the port. */
export function browserControlAttributesAreSensitive(
  attributes: Readonly<Record<string, string | null | undefined>>,
): boolean {
  const type = attributes["type"]?.trim().toLowerCase() ?? "";
  if (type === "password" || type === "hidden") return true;
  return Object.values(attributes).some((value) =>
    typeof value === "string" && SENSITIVE_CONTROL_PATTERN.test(value));
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

export class BrowserAutomationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "BrowserAutomationError";
  }
}
