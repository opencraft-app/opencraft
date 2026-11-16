import { BrowserAutomationError, type BrowserAutomation } from "@opencraft/browser-core";

type Reply<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; retryable: boolean; outcome?: "not-dispatched" | "unknown" } };
export interface ElectronAutomationPort {
  connectAutomation(guestId: number): Promise<Reply<{ lease: string; capabilities: BrowserAutomation["capabilities"] }>>;
  invokeAutomation(guestId: number, lease: string, requestId: string, method: string, input: unknown): Promise<Reply<any>>;
  cancelAutomation(guestId: number, lease: string, requestId: string): Promise<unknown>;
  releaseAutomation(guestId: number, lease: string): Promise<unknown>;
}
function unwrap<T>(reply: Reply<T>): T {
  if (!reply.ok) throw new BrowserAutomationError(reply.error.code, reply.error.message, reply.error.retryable, reply.error.outcome);
  return reply.value;
}

/** A renderer client holds a Main-issued document lease, never a debugger port. */
export function createElectronBrowserAutomation(guest: HTMLElement & { getWebContentsId(): number }, port: ElectronAutomationPort): BrowserAutomation {
  const guestId = guest.getWebContentsId();
  let disposed = false;
  const available = [port?.connectAutomation, port?.invokeAutomation, port?.cancelAutomation, port?.releaseAutomation].every(method => typeof method === "function");
  const connected = available ? port.connectAutomation(guestId).then(unwrap)
    : Promise.reject(new BrowserAutomationError("AUTOMATION_UNAVAILABLE", "Native browser automation is unavailable"));
  // Eagerly obtain the native document lease at dom-ready, not at a later action.
  void connected.catch(() => {});
  const assertLive = () => {
    if (disposed) throw new BrowserAutomationError("PAGE_CLOSED", "Browser document is no longer active");
  };
  const call = async (method: string, input: unknown = {}) => {
    assertLive();
    const client = await connected; assertLive();
    const writes = !['inspect', 'readContext', 'wait'].includes(method);
    const previous = writes ? guest.ownerDocument.activeElement : null;
    const requestId = crypto.randomUUID(); let controlLost = false;
    const blur = () => {
      if (controlLost) return;
      controlLost = true;
      void port.cancelAutomation(guestId, client.lease, requestId).catch(() => {});
    };
    const focusChanged = () => { if (guest.ownerDocument.activeElement !== guest) blur(); };
    // Chromium's embedded guest input requires the embedder's native focus path
    // as well as focus inside the guest document. Restore it only if the user
    // has not moved focus during this operation; Main fences that loss too.
    if (writes) guest.focus({ preventScroll: true });
    if (writes) {
      guest.ownerDocument.addEventListener('focusin', focusChanged, true);
      guest.ownerDocument.defaultView?.addEventListener('blur', blur);
    }
    try {
      const reply = await port.invokeAutomation(guestId, client.lease, requestId, method, input);
      if (controlLost) throw new BrowserAutomationError('CONTROL_LOST', 'Browser input focus changed', false, reply.ok ? 'unknown' : reply.error.outcome);
      const result = unwrap(reply);
      assertLive(); return result;
    } finally {
      guest.ownerDocument.removeEventListener('focusin', focusChanged, true);
      guest.ownerDocument.defaultView?.removeEventListener('blur', blur);
      if (writes && guest.ownerDocument.activeElement === guest && previous instanceof HTMLElement && previous.isConnected && previous !== guest)
        previous.focus({ preventScroll: true });
    }
  };
  return {
    capabilities: { protocolVersion: 1, backend: "electron-cdp", domInspection: available,
      semanticInput: available, trustedInput: available, networkObservation: "none", screenshot: false, deviceEmulation: "none" },
    readContext: options => call("readContext", options), inspect: () => call("inspect"),
    click: input => call("click", input), fill: input => call("fill", input), press: input => call("press", input),
    scroll: input => call("scroll", input), wait: input => call("wait", input),
    dispose() {
      if (disposed) return;
      disposed = true;
      void connected.then(client => port.releaseAutomation(guestId, client.lease)).catch(() => {});
    },
  };
}
