import {
  BrowserAutomationError,
  browserControlAttributesAreSensitive,
  type BrowserAnnotationAnchor,
  type BrowserAnnotationDragRequest,
  type BrowserAnnotationPreviewRequest,
} from "@opencraft/browser-core";

import {
  PREVIEW_BRIDGE_PROTOCOL_VERSION,
  PREVIEW_BRIDGE_SOURCE,
  isPreviewBridgeParentMessage,
  type PreviewBridgeChildMessage,
  type PreviewBridgeParentMessage,
} from "./protocol";
import { ANNOTATION_OVERLAY_HOST_ID, createAnnotationPicker, annotationElementIsSensitive } from "./annotation-picker";
import { createAnnotationSelectionRuntime } from "./annotation-selection";

export { ANNOTATION_OVERLAY_HOST_ID };

export interface PreviewBridgeRuntimeOptions {
  readonly window: Window;
  /** Exact parent origin. Defaults to the embedding document's referrer origin. */
  readonly parentOrigin?: string;
  readonly authorizeAnnotationPreview?: () => boolean;
}

type BrowserWindow = Window & typeof globalThis;

type ChildMessageBody =
  | {
      readonly type: "preview:ready";
      readonly capabilities: {
        readonly domInspection: true;
        readonly semanticInput: true;
        readonly trustedInput: false;
        readonly networkObservation: "none";
      };
    }
  | { readonly type: "preview:call-result"; readonly callId: string; readonly ok: true; readonly result: unknown }
  | {
      readonly type: "preview:call-result";
      readonly callId: string;
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean };
    }
  | { readonly type: "preview:document-updated"; readonly revision: number }
  | { readonly type: "preview:url-changed"; readonly url: string; readonly title: string }
  | { readonly type: "preview:error"; readonly message: string };

function isSensitiveControl(element: Element): boolean {
  return browserControlAttributesAreSensitive({
    type: element.getAttribute("type"),
    name: element.getAttribute("name"),
    id: element.getAttribute("id"),
    placeholder: element.getAttribute("placeholder"),
    ariaLabel: element.getAttribute("aria-label"),
    autocomplete: element.getAttribute("autocomplete"),
  });
}

function errorShape(error: unknown): { code: string; message: string; retryable: boolean } {
  return error instanceof BrowserAutomationError
    ? { code: error.code, message: error.message, retryable: error.retryable }
    : {
        code: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "PREVIEW_OPERATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
}

/** The overlay host is ours: automation never reports it and mounting it keeps refs. */

function isAnnotationOverlay(node: Node | null): boolean {
  return node instanceof Element && node.id === ANNOTATION_OVERLAY_HOST_ID;
}

function parentOriginFrom(windowValue: Window): string | null {
  try {
    return windowValue.document.referrer ? new URL(windowValue.document.referrer).origin : null;
  } catch {
    return null;
  }
}

/** Child-side runtime. Controlled previews import this once at application bootstrap. */
export function installPreviewBridgeRuntime(options: PreviewBridgeRuntimeOptions): () => void {
  const windowValue = options.window as BrowserWindow;
  const documentValue = windowValue.document;
  const parentOrigin = options.parentOrigin ?? parentOriginFrom(windowValue);
  if (parentOrigin === null) throw new Error("Preview Bridge requires an exact parent origin");

  let identity: Pick<PreviewBridgeParentMessage, "previewId" | "generation" | "nonce"> | null = null;
  let revision = 0;
  let refSequence = 0;
  const refs = new Map<string, Element>();
  const cancelled = new Set<string>();
  const picker = createAnnotationPicker(windowValue, annotationElementIsSensitive);
  const annotationRef = (element: Element) => {
    for (const [ref, known] of refs) if (known === element) return ref;
    const ref = `e${++refSequence}`; refs.set(ref, element); return ref;
  };
  const selections = createAnnotationSelectionRuntime(documentValue, {
    picker, revision: () => revision, ref: annotationRef,
    authorizePreview: options.authorizeAnnotationPreview,
  });

  const post = (body: ChildMessageBody) => {
    if (identity === null) return;
    windowValue.parent.postMessage({
      source: PREVIEW_BRIDGE_SOURCE,
      protocolVersion: PREVIEW_BRIDGE_PROTOCOL_VERSION,
      ...identity,
      ...body,
    } satisfies PreviewBridgeChildMessage, parentOrigin);
  };

  const bumpRevision = () => {
    revision += 1;
    refs.clear();
    post({ type: "preview:document-updated", revision });
  };
  const observer = new windowValue.MutationObserver((records) => {
    const ours = records.every((record) => isAnnotationOverlay(record.target) ||
      (record.type === "childList" &&
        [...record.addedNodes, ...record.removedNodes].every((node) => isAnnotationOverlay(node))));
    if (!ours) bumpRevision();
  });
  observer.observe(documentValue, { subtree: true, childList: true, attributes: true, characterData: true });
  const flushMutations = () => {
    if (observer.takeRecords().length > 0) bumpRevision();
  };

  const visible = (element: HTMLElement) => {
    const style = windowValue.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" &&
      style.opacity !== "0" && element.getClientRects().length > 0;
  };

  const requireElement = (ref: unknown, expectedRevision: unknown) => {
    flushMutations();
    if (typeof ref !== "string" || typeof expectedRevision !== "number") {
      throw new BrowserAutomationError("INVALID_ARGUMENT", "ref and expectedRevision are required");
    }
    if (expectedRevision !== revision) {
      throw new BrowserAutomationError(
        "STALE_ELEMENT_REFERENCE",
        `Element ref ${ref} belongs to revision ${expectedRevision}; current revision is ${revision}`,
        true,
      );
    }
    const element = refs.get(ref);
    if (element === undefined || !element.isConnected || element.ownerDocument !== documentValue) {
      throw new BrowserAutomationError("STALE_ELEMENT_REFERENCE", `Element ref ${ref} is unavailable`, true);
    }
    return element;
  };

  const readContext = (params: Readonly<Record<string, unknown>>) => {
    const maxInlineChars = Math.max(1_000, Math.min(
      200_000,
      typeof params.maxInlineChars === "number" ? params.maxInlineChars : 50_000,
    ));
    const formValues = [...documentValue.querySelectorAll("input, textarea, select")].flatMap((element) => {
      if (!(element instanceof windowValue.HTMLElement) || !visible(element)) return [];
      const label = element.getAttribute("aria-label") ?? element.getAttribute("name") ??
        element.getAttribute("placeholder") ?? element.tagName.toLowerCase();
      if (isSensitiveControl(element)) return [`${label}: <browser__redacted_form_control />`];
      const value = "value" in element ? String(element.value ?? "") : "";
      return value ? [`${label}: ${value}`] : [];
    });
    return {
      url: windowValue.location.href,
      title: documentValue.title,
      revision,
      selection: params.includeSelection === false
        ? null
        : (windowValue.getSelection()?.toString().trim() || null),
      content: [documentValue.body?.innerText ?? "", ...formValues]
        .filter(Boolean).join("\n").slice(0, maxInlineChars),
    };
  };

  const inspect = () => {
    flushMutations();
    refs.clear();
    const selector = [
      "a[href]", "button", "input", "textarea", "select", "summary",
      "[role=button]", "[role=link]", "[role=checkbox]", "[role=menuitem]",
      "[contenteditable=true]", "[tabindex]",
    ].join(",");
    const elements = [...documentValue.querySelectorAll(selector)].flatMap((element) => {
      if (!(element instanceof windowValue.HTMLElement) || !visible(element)) return [];
      if (element.closest(`#${ANNOTATION_OVERLAY_HOST_ID}`) !== null) return [];
      const ref = `e${++refSequence}`;
      refs.set(ref, element);
      const value = isSensitiveControl(element)
        ? "<browser__redacted_form_control />"
        : ("value" in element ? String(element.value ?? "") : undefined);
      return [{
        ref,
        role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
        name: (element.getAttribute("aria-label") ?? element.getAttribute("title") ??
          element.innerText?.trim() ?? element.getAttribute("placeholder") ?? "").slice(0, 300),
        ...(value ? { value } : {}),
        disabled: "disabled" in element && Boolean(element.disabled),
      }];
    });
    return { url: windowValue.location.href, title: documentValue.title, revision, elements };
  };

  const setNativeValue = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const prototype = element instanceof windowValue.HTMLInputElement
      ? windowValue.HTMLInputElement.prototype
      : windowValue.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter === undefined) element.value = value;
    else setter.call(element, value);
  };

  const execute = async (message: Extract<PreviewBridgeParentMessage, { type: "platform:call" }>, connection: NonNullable<typeof identity>) => {
    const params = message.params;
    switch (message.method) {
      case "read-context": return readContext(params);
      case "inspect": return inspect();
      case "annotate-pick": return picker.pick(params, { revision, ref: annotationRef });
      case "annotate-region": return selections.pickRegion(params as unknown as BrowserAnnotationDragRequest);
      case "annotate-text": return selections.pickText(params as unknown as BrowserAnnotationDragRequest);
      case "annotate-styles": return selections.readStyles(params.anchor as BrowserAnnotationAnchor);
      case "annotate-preview": selections.preview(params as unknown as BrowserAnnotationPreviewRequest); return null;
      case "annotate-clear-preview": selections.clearPreview(); return null;
      case "click": {
        const element = requireElement(params.ref, params.expectedRevision);
        if (!(element instanceof windowValue.HTMLElement)) {
          throw new BrowserAutomationError("ELEMENT_NOT_ACTIONABLE", "Element cannot be clicked");
        }
        element.scrollIntoView({ block: "center", inline: "nearest" });
        requireElement(params.ref, params.expectedRevision);
        element.focus();
        requireElement(params.ref, params.expectedRevision);
        element.click();
        return null;
      }
      case "fill": {
        const element = requireElement(params.ref, params.expectedRevision);
        if (isSensitiveControl(element)) {
          throw new BrowserAutomationError("POLICY_BLOCKED", "Sensitive controls cannot be filled by Agent tools");
        }
        const value = typeof params.value === "string" ? params.value : "";
        if (element instanceof windowValue.HTMLInputElement || element instanceof windowValue.HTMLTextAreaElement) {
          setNativeValue(element, value);
        } else if (element instanceof windowValue.HTMLSelectElement) {
          element.value = value;
        } else if (element instanceof windowValue.HTMLElement && element.isContentEditable) {
          element.textContent = value;
        } else {
          throw new BrowserAutomationError("ELEMENT_NOT_ACTIONABLE", "Element cannot be filled");
        }
        element.dispatchEvent(new windowValue.Event("input", { bubbles: true, composed: true }));
        element.dispatchEvent(new windowValue.Event("change", { bubbles: true, composed: true }));
        return null;
      }
      case "press": {
        const key = typeof params.key === "string" ? params.key : "";
        const target = documentValue.activeElement ?? documentValue.body;
        target?.dispatchEvent(new windowValue.KeyboardEvent("keydown", { key, bubbles: true, composed: true }));
        target?.dispatchEvent(new windowValue.KeyboardEvent("keyup", { key, bubbles: true, composed: true }));
        return null;
      }
      case "scroll": {
        windowValue.scrollBy({
          left: typeof params.x === "number" ? params.x : 0,
          top: typeof params.y === "number" ? params.y : 0,
          behavior: "auto",
        });
        return null;
      }
      case "wait": {
        const text = typeof params.text === "string" ? params.text : "";
        const timeoutMs = Math.max(0, Math.min(
          30_000,
          typeof params.timeoutMs === "number" ? params.timeoutMs : 5_000,
        ));
        const deadline = Date.now() + timeoutMs;
        while (!(documentValue.body?.innerText ?? "").includes(text)) {
          if (identity !== connection || cancelled.has(message.callId)) {
            throw new BrowserAutomationError("CANCELLED", "Preview operation was cancelled", true);
          }
          if (Date.now() >= deadline) {
            throw new BrowserAutomationError(
              "TIMEOUT",
              `Timed out waiting for page text ${JSON.stringify(text)}`,
              true,
            );
          }
          await new Promise((resolve) => windowValue.setTimeout(resolve, 50));
        }
        return null;
      }
    }
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== windowValue.parent || event.origin !== parentOrigin) return;
    if (!isPreviewBridgeParentMessage(event.data)) return;
    const message = event.data;
    if (message.type === "platform:connect") {
      if (identity === null || identity.previewId !== message.previewId ||
        identity.generation !== message.generation || identity.nonce !== message.nonce) {
        selections.clearPreview();
        const replacing = identity !== null;
        identity = { previewId: message.previewId, generation: message.generation, nonce: message.nonce };
        refs.clear(); cancelled.clear();
        if (replacing) bumpRevision();
      }
      post({
        type: "preview:ready",
        capabilities: {
          domInspection: true,
          semanticInput: true,
          trustedInput: false,
          networkObservation: "none",
        },
      });
      post({ type: "preview:url-changed", url: windowValue.location.href, title: documentValue.title });
      return;
    }
    if (identity === null || message.previewId !== identity.previewId ||
      message.generation !== identity.generation || message.nonce !== identity.nonce) return;
    if (message.type === "platform:cancel") {
      cancelled.add(message.callId);
      return;
    }
    const connection = identity;
    void execute(message, connection).then(
      (result) => {
        if (identity !== connection) return;
        if (!cancelled.delete(message.callId)) {
          post({ type: "preview:call-result", callId: message.callId, ok: true, result });
        }
      },
      (error: unknown) => {
        if (identity !== connection) return;
        cancelled.delete(message.callId);
        post({ type: "preview:call-result", callId: message.callId, ok: false, error: errorShape(error) });
      },
    );
  };

  windowValue.addEventListener("message", onMessage);
  const onNavigation = () => {
    bumpRevision();
    post({ type: "preview:url-changed", url: windowValue.location.href, title: documentValue.title });
  };
  windowValue.addEventListener("hashchange", onNavigation);
  windowValue.addEventListener("popstate", onNavigation);
  const onPageHide = () => selections.clearPreview();
  windowValue.addEventListener("pagehide", onPageHide);
  return () => {
    selections.dispose();
    picker.dispose();
    windowValue.removeEventListener("pagehide", onPageHide);
    observer.disconnect();
    windowValue.removeEventListener("message", onMessage);
    windowValue.removeEventListener("hashchange", onNavigation);
    windowValue.removeEventListener("popstate", onNavigation);
    refs.clear();
    cancelled.clear();
    identity = null;
  };
}
