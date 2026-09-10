import {
  BrowserAutomationError,
  type BrowserAutomation,
  type BrowserAutomationInspection,
  type BrowserAutomationPageContext,
} from "@opencraft/browser-core";

import {
  PREVIEW_BRIDGE_PROTOCOL_VERSION,
  PREVIEW_BRIDGE_SOURCE,
  isPreviewBridgeChildMessage,
  type PreviewBridgeCallMap,
  type PreviewBridgeChildMessage,
  type PreviewBridgeMethod,
  type PreviewBridgeParentMessage,
} from "./protocol";

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof globalThis.setTimeout>;
}

type ParentMessageBody =
  | { readonly type: "platform:connect" }
  | {
      readonly type: "platform:call";
      readonly callId: string;
      readonly method: PreviewBridgeMethod;
      readonly params: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "platform:cancel"; readonly callId: string };

export interface PreviewBridgeAdapterOptions {
  readonly hostWindow: Window;
  readonly frameWindow: Window;
  readonly targetOrigin: string;
  readonly previewId: string;
  readonly generation: number;
  readonly nonce?: string;
  readonly handshakeTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  readonly onEvent?: (event: PreviewBridgeChildMessage) => void;
}

function randomId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

/** Parent-side OpenVibe-shaped RPC adapter for a cooperating preview page. */
export class PreviewBridgeAdapter implements BrowserAutomation {
  readonly capabilities = Object.freeze({
    protocolVersion: 1 as const,
    backend: "preview-bridge" as const,
    domInspection: true,
    semanticInput: true,
    trustedInput: false,
    networkObservation: "fetch-xhr" as const,
    screenshot: false,
    deviceEmulation: "viewport-only" as const,
  });

  private readonly nonce: string;
  private readonly pending = new Map<string, PendingCall>();
  private readyState: "connecting" | "ready" | "disposed" = "connecting";
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly readyPromise: Promise<void>;
  private readonly handshakeTimeout: ReturnType<typeof globalThis.setTimeout>;
  private readonly onMessageBound = (event: MessageEvent) => this.onMessage(event);

  constructor(private readonly options: PreviewBridgeAdapterOptions) {
    this.nonce = options.nonce ?? randomId("nonce");
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // A bridge can remain presentation-only without a tool call ever awaiting it.
    this.readyPromise.catch(() => undefined);
    options.hostWindow.addEventListener("message", this.onMessageBound);
    this.handshakeTimeout = globalThis.setTimeout(() => {
      this.failHandshake(new BrowserAutomationError(
        "PREVIEW_BRIDGE_UNAVAILABLE",
        "The preview did not install or acknowledge the OpenCraft Preview Bridge",
        true,
      ));
    }, options.handshakeTimeoutMs ?? 1_500);
    this.post({ type: "platform:connect" });
  }

  readContext(options: {
    readonly includeSelection?: boolean;
    readonly maxInlineChars?: number;
  } = {}): Promise<BrowserAutomationPageContext> {
    return this.call("read-context", options);
  }

  inspect(): Promise<BrowserAutomationInspection> {
    return this.call("inspect", {});
  }

  async click(input: { readonly ref: string; readonly expectedRevision: number }): Promise<void> {
    await this.call("click", input);
  }

  async fill(input: {
    readonly ref: string;
    readonly expectedRevision: number;
    readonly value: string;
  }): Promise<void> {
    await this.call("fill", input);
  }

  async press(input: { readonly key: string }): Promise<void> {
    await this.call("press", input);
  }

  async scroll(input: { readonly x: number; readonly y: number }): Promise<void> {
    await this.call("scroll", input);
  }

  async wait(input: { readonly text: string; readonly timeoutMs: number }): Promise<void> {
    await this.call(
      "wait",
      input,
      Math.max(input.timeoutMs + 500, this.options.callTimeoutMs ?? 5_000),
    );
  }

  dispose(): void {
    if (this.readyState === "disposed") return;
    const wasConnecting = this.readyState === "connecting";
    this.readyState = "disposed";
    globalThis.clearTimeout(this.handshakeTimeout);
    this.options.hostWindow.removeEventListener("message", this.onMessageBound);
    const error = new BrowserAutomationError("PREVIEW_BRIDGE_DISPOSED", "Preview Bridge was disposed", true);
    if (wasConnecting) this.readyReject(error);
    for (const pending of this.pending.values()) {
      globalThis.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async call<M extends PreviewBridgeMethod>(
    method: M,
    params: PreviewBridgeCallMap[M]["params"],
    timeoutMs = this.options.callTimeoutMs ?? 5_000,
  ): Promise<PreviewBridgeCallMap[M]["result"]> {
    await this.readyPromise;
    if (this.readyState !== "ready") {
      throw new BrowserAutomationError("PREVIEW_BRIDGE_DISPOSED", "Preview Bridge is unavailable", true);
    }
    const callId = randomId("call");
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        this.pending.delete(callId);
        this.post({ type: "platform:cancel", callId });
        reject(new BrowserAutomationError(
          "PREVIEW_BRIDGE_TIMEOUT",
          `Preview Bridge call ${method} timed out`,
          true,
        ));
      }, timeoutMs);
      this.pending.set(callId, { resolve, reject, timeout });
    });
    this.post({ type: "platform:call", callId, method, params });
    return result as Promise<PreviewBridgeCallMap[M]["result"]>;
  }

  private onMessage(event: MessageEvent): void {
    if (event.source !== this.options.frameWindow
      || (this.options.targetOrigin !== "*" && event.origin !== this.options.targetOrigin)) return;
    if (!isPreviewBridgeChildMessage(event.data)) return;
    const message = event.data;
    if (message.previewId !== this.options.previewId ||
      message.generation !== this.options.generation ||
      message.nonce !== this.nonce) return;
    if (message.type === "preview:ready") {
      if (this.readyState !== "connecting") return;
      this.readyState = "ready";
      globalThis.clearTimeout(this.handshakeTimeout);
      this.readyResolve();
      this.options.onEvent?.(message);
      return;
    }
    if (message.type !== "preview:call-result") {
      this.options.onEvent?.(message);
      return;
    }
    const pending = this.pending.get(message.callId);
    if (pending === undefined) return;
    this.pending.delete(message.callId);
    globalThis.clearTimeout(pending.timeout);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new BrowserAutomationError(
      message.error.code,
      message.error.message,
      message.error.retryable,
    ));
  }

  private failHandshake(error: Error): void {
    if (this.readyState !== "connecting") return;
    this.readyState = "disposed";
    this.options.hostWindow.removeEventListener("message", this.onMessageBound);
    this.readyReject(error);
  }

  private post(body: ParentMessageBody): void {
    this.options.frameWindow.postMessage({
      source: PREVIEW_BRIDGE_SOURCE,
      protocolVersion: PREVIEW_BRIDGE_PROTOCOL_VERSION,
      previewId: this.options.previewId,
      generation: this.options.generation,
      nonce: this.nonce,
      ...body,
    } satisfies PreviewBridgeParentMessage, this.options.targetOrigin);
  }
}
