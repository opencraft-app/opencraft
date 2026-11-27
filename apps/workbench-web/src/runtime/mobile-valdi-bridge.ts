import {
  isMobileContainerEvent,
  resolveMobileContainerTransport,
  type MobileActionSheetItem,
  type MobileContainerRequest,
} from "@opencraft/client-product/mobile-container";
import { mobileContainer } from "./mobile-container";

let nextDialogSequence = 0;

export function requestMobileHaptic(style: "selection" | "light" | "warning", target: Window = window): boolean {
  const identity = mobileContainer(target);
  const transport = resolveMobileContainerTransport(target);
  if (!identity || !transport || identity.capabilities?.valdi !== true) return false;
  const request: MobileContainerRequest = { ...identity, type: "haptic", style };
  transport.postMessage(JSON.stringify(request));
  return true;
}

export function requestMobileConfirmDialog(
  options: {
    readonly title: string;
    readonly message?: string;
    readonly confirmLabel: string;
    readonly cancelLabel: string;
    readonly destructive?: boolean;
    readonly signal?: AbortSignal;
  },
  target: Window = window,
): Promise<boolean> | null {
  const identity = mobileContainer(target);
  const transport = resolveMobileContainerTransport(target);
  if (!identity || !transport || identity.capabilities?.valdi !== true) return null;
  if (options.signal?.aborted) return Promise.resolve(false);
  const requestId = String(++nextDialogSequence);
  return new Promise<boolean>((resolve) => {
    const cleanup = () => {
      target.removeEventListener("opencraft-mobile", onEvent);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    const onEvent = (event: Event) => {
      const value: unknown = (event as CustomEvent).detail;
      if (!isMobileContainerEvent(value, identity.runtimeId)) return;
      if (value.type === "confirm-dialog-result" && value.requestId === requestId) {
        cleanup();
        resolve(value.confirmed);
      }
    };
    target.addEventListener("opencraft-mobile", onEvent);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const request: MobileContainerRequest = {
      ...identity,
      type: "confirm-dialog",
      requestId,
      title: options.title,
      ...(options.message === undefined ? {} : { message: options.message }),
      confirmLabel: options.confirmLabel,
      cancelLabel: options.cancelLabel,
      ...(options.destructive === undefined ? {} : { destructive: options.destructive }),
    };
    transport.postMessage(JSON.stringify(request));
  });
}

export function requestMobileActionSheet(
  options: {
    readonly title?: string;
    readonly message?: string;
    readonly cancelLabel: string;
    readonly actions: readonly MobileActionSheetItem[];
    readonly signal?: AbortSignal;
  },
  target: Window = window,
): Promise<string | null> | null {
  const identity = mobileContainer(target);
  const transport = resolveMobileContainerTransport(target);
  if (!identity || !transport || identity.capabilities?.valdi !== true || options.actions.length === 0) return null;
  if (options.signal?.aborted) return Promise.resolve(null);
  const requestId = String(++nextDialogSequence);
  return new Promise<string | null>((resolve) => {
    const cleanup = () => {
      target.removeEventListener("opencraft-mobile", onEvent);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      resolve(null);
    };
    const onEvent = (event: Event) => {
      const value: unknown = (event as CustomEvent).detail;
      if (!isMobileContainerEvent(value, identity.runtimeId)) return;
      if (value.type === "action-sheet-result" && value.requestId === requestId) {
        cleanup();
        resolve(value.actionId);
      }
    };
    target.addEventListener("opencraft-mobile", onEvent);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const request: MobileContainerRequest = {
      ...identity,
      type: "action-sheet",
      requestId,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.message === undefined ? {} : { message: options.message }),
      cancelLabel: options.cancelLabel,
      actions: options.actions,
    };
    transport.postMessage(JSON.stringify(request));
  });
}
