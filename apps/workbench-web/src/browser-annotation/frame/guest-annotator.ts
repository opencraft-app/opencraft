import type { BrowserAnnotator } from "@opencraft/browser-core";
import { CONSOLE_PREFIX, FRAME_CHANNEL } from "./frame-agent";
import { createAgentAnnotator } from "./frame-annotator";
import { annotationAgentSource } from "./frame-source";

/** The parts of Electron's <webview> this needs. */
export interface AnnotatableGuest {
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(): Promise<{ toDataURL(): string }>;
  getURL(): string;
  getTitle(): string;
  addEventListener(type: "console-message" | "did-start-navigation", listener: (event: Event & { message?: string; isMainFrame?: boolean; isInPlace?: boolean }) => void): void;
  removeEventListener(type: "console-message" | "did-start-navigation", listener: (event: Event & { message?: string; isMainFrame?: boolean; isInPlace?: boolean }) => void): void;
}

/**
 * Desktop <webview> guest. The guest runs in another process, so the host can
 * neither see its DOM nor its pointer events: the same in-page agent handles
 * them. Host->guest goes through executeJavaScript; guest->host through console
 * lines carrying a per-guest token. Page scripts can read and forge those
 * lines, which is why every field is sanitized as untrusted page evidence.
 */
export function createGuestAnnotator(guest: AnnotatableGuest): BrowserAnnotator & { dispose(): void; refresh(): void } {
  let generation = 0, navigating = false, disposed = false;
  const navigationListeners = new Set<() => void>();
  const token = crypto.randomUUID();
  const receiver = JSON.stringify(`opencraft.annotation.${token}`);
  const install = annotationAgentSource({ token, transport: { kind: "console" } });
  // Each document needs its own agent; installing twice is a no-op in the page.
  const deliver = (message: Record<string, unknown>) => {
    if (disposed && message.type !== "dispose") return Promise.reject(new Error("Preview closed"));
    if (navigating) return Promise.reject(new Error("Preview navigated"));
    const json = JSON.stringify({ channel: FRAME_CHANNEL, token, ...message });
    return guest.executeJavaScript(`(() => { const r = window[Symbol.for(${receiver})]; if (!r) { ${install} } window[Symbol.for(${receiver})]?.(${json}); ${message.type === "marks" ? "return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Annotation overlay did not paint')), 3000); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); });" : ""} })()`)
      .then(() => undefined);
  };
  const annotator = createAgentAnnotator({
    send: deliver,
    subscribe: (listener) => {
      const onConsole = (event: Event & { message?: string }) => {
        const line = event.message;
        if (typeof line !== "string" || !line.startsWith(CONSOLE_PREFIX) || line.length > 64 * 1024) return;
        try {
          const data = JSON.parse(line.slice(CONSOLE_PREFIX.length)) as Record<string, unknown>;
          if (data && data.channel === FRAME_CHANNEL && data.token === token) listener(data);
        } catch { /* not ours */ }
      };
      guest.addEventListener("console-message", onConsole);
      return () => guest.removeEventListener("console-message", onConsole);
    },
    document: () => ({ url: guest.getURL(), title: guest.getTitle(), generation: String(generation) }),
    subscribeNavigation: listener => {
      navigationListeners.add(listener);
      const onNavigation = (event: Event & { isMainFrame?: boolean; isInPlace?: boolean }) => {
        if (event.isMainFrame === false || event.isInPlace === true) return;
        navigating = true; ++generation; listener();
      };
      guest.addEventListener("did-start-navigation", onNavigation);
      return () => { navigationListeners.delete(listener); guest.removeEventListener("did-start-navigation", onNavigation); };
    },
    capture: async () => (await guest.capturePage()).toDataURL(),
  });
  // After a navigation the agent is gone; reinstalling makes it report
  // "ready", and the annotator restores interception and markers.
  return {
    ...annotator,
    dispose: () => { disposed = true; annotator.dispose(); },
    refresh: () => { if (disposed) return; navigating = false; ++generation; for (const listener of navigationListeners) listener(); void deliver({ type: "ping" }).catch(() => undefined); },
  };
}
