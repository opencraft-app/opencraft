import type { DesktopProductFactory, DesktopProductPorts, DesktopProductSession } from "./product-contract.js";

interface IpcPort {
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

/** Owns product handlers and fences retained callbacks after teardown. */
export function activateDesktopProduct(factory: DesktopProductFactory | null,
  ports: Omit<DesktopProductPorts, "handle">,
  ipc: IpcPort, trusted: (event: unknown) => boolean): DesktopProductSession | null {
  if (factory === null) return null;
  if (typeof factory !== "function") throw new Error("Invalid desktop product factory");
  const channels = new Set<string>();
  let active = true;
  let session: DesktopProductSession;
  const releaseHandlers = () => {
    const errors: unknown[] = [];
    for (const channel of channels) {
      try { ipc.removeHandler(channel); } catch (error) { errors.push(error); }
    }
    channels.clear();
    return errors;
  };
  try {
    session = factory({ ...ports, handle(channel, handler) {
      if (!active) throw new Error("Desktop product is disposed");
      if (!channel || channels.has(channel)) throw new Error("Invalid or duplicate desktop product handler");
      ipc.handle(channel, (event, ...args) => {
        if (!active || !trusted(event)) throw new Error("Untrusted desktop product caller");
        return handler(...args);
      });
      channels.add(channel);
    } });
    if (!session || typeof session.receiveUrl !== "function" || typeof session.cancelInteractions !== "function" || typeof session.dispose !== "function") {
      throw new Error("Invalid desktop product session");
    }
  } catch (error) {
    active = false;
    const errors = releaseHandlers();
    if (errors.length) throw new AggregateError([error, ...errors], "Desktop product activation failed");
    throw error;
  }
  return {
    receiveUrl: url => active ? session.receiveUrl(url) : null,
    cancelInteractions() { if (active) session.cancelInteractions(); },
    dispose() {
      if (!active) return;
      active = false;
      const errors: unknown[] = [];
      try { session.dispose(); } catch (error) { errors.push(error); }
      errors.push(...releaseHandlers());
      if (errors.length) throw new AggregateError(errors, "Desktop product disposal failed");
    },
  };
}

export function composeDesktopBridge(core: Readonly<Record<string, unknown>>, product: Readonly<Record<string, unknown>>) {
  if (Object.keys(product).some(key => Object.hasOwn(core, key))) throw new Error("Desktop product cannot replace a core bridge");
  return Object.freeze({ ...core, ...product });
}
