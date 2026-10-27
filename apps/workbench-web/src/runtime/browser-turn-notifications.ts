import { turnCompletionKey, type TurnCompletion } from "@opencraft/workbench-runtime";

export interface BrowserNotificationEnvironment {
  readonly secure: boolean;
  readonly notification: typeof Notification | null;
  readonly serviceWorkers: ServiceWorkerContainer | null;
  pageUrl(): string;
  focus(): void;
}

export interface BrowserNotificationSnapshot {
  readonly supported: boolean;
  readonly permission: NotificationPermission;
  readonly error: boolean;
}

function browserEnvironment(): BrowserNotificationEnvironment {
  return {
    secure: globalThis.isSecureContext === true,
    notification: typeof Notification === "undefined" ? null : Notification,
    serviceWorkers: typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : null,
    pageUrl: () => window.location.href,
    focus: () => window.focus(),
  };
}

/** A platform port; it never requests permission in response to a Turn event. */
export class BrowserTurnNotifications {
  private readonly listeners = new Set<() => void>();
  private readonly windows = new Set<Notification>();
  private readonly ownerId: string = globalThis.crypto?.randomUUID?.()
    ?? globalThis.crypto?.getRandomValues(new Uint32Array(4)).join("-") ?? "";
  private snapshot: BrowserNotificationSnapshot;
  private registration: Promise<{ registration: ServiceWorkerRegistration; clientId: string } | null> | null = null;
  private disposed = false;

  constructor(private readonly environment = browserEnvironment()) {
    this.snapshot = this.readSnapshot(false);
  }

  getSnapshot = (): BrowserNotificationSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  refresh = (): void => { this.publish(false); };
  prepare = (): void => {
    if (this.snapshot.supported && this.snapshot.permission === "granted") void this.prepareWorker();
  };

  /** Call synchronously inside the user's click; do not await storage first. */
  async requestPermission(): Promise<NotificationPermission> {
    if (!this.snapshot.supported || !this.environment.notification) return "denied";
    try {
      const permission = await this.environment.notification.requestPermission();
      this.publish(false);
      if (permission === "granted") await this.prepareWorker();
      return permission;
    } catch {
      this.publish(true);
      return "denied";
    }
  }

  async show(completion: TurnCompletion, title: string, body: string, allowed: () => boolean, onClick: () => void): Promise<void> {
    if (!this.canShow(allowed)) return;
    try {
      const worker = await this.prepareWorker();
      if (!this.canShow(allowed)) return;
      const tag = `opencraft-turn:${turnCompletionKey(completion)}`;
      if (worker) {
        await worker.registration.showNotification(title, {
          body, tag,
          data: { kind: "opencraft-turn", ownerId: this.ownerId, clientId: worker.clientId, pageUrl: this.environment.pageUrl(), completion },
        });
      } else {
        const notification = new this.environment.notification!(title, { body, tag });
        this.windows.add(notification);
        notification.onclose = () => { this.windows.delete(notification); };
        notification.onerror = () => { this.windows.delete(notification); this.publish(true); };
        notification.onclick = () => {
          notification.close();
          if (this.disposed) return;
          this.environment.focus();
          onClick();
        };
      }
    } catch { this.publish(true); }
  }

  /** The worker's sender Client ID and this owner nonce bind clicks to one app. */
  observeClicks(onClick: (completion: TurnCompletion) => void): () => void {
    const listener = (event: MessageEvent) => {
      const value = event.data;
      if (this.disposed || value?.kind !== "opencraft-turn-click" || value.ownerId !== this.ownerId) return;
      const completion = value.completion;
      if (typeof completion?.hostId !== "string" || typeof completion.threadId !== "string" || typeof completion.turnId !== "string"
        || !["completed", "failed", "interrupted"].includes(completion.status)) return;
      onClick(completion);
    };
    this.environment.serviceWorkers?.addEventListener("message", listener);
    return () => this.environment.serviceWorkers?.removeEventListener("message", listener);
  }

  dispose(): void {
    this.disposed = true;
    for (const notification of this.windows) notification.close();
    this.windows.clear();
    this.listeners.clear();
  }

  private canShow(allowed: () => boolean): boolean {
    return !this.disposed && this.snapshot.supported && allowed() && this.environment.notification?.permission === "granted";
  }
  private readSnapshot(error: boolean): BrowserNotificationSnapshot {
    return { supported: this.environment.secure && this.environment.notification !== null && this.ownerId !== "",
      permission: this.environment.notification?.permission ?? "denied", error };
  }
  private publish(error: boolean): void {
    if (this.disposed) return;
    const snapshot = this.readSnapshot(error);
    if (snapshot.permission === this.snapshot.permission && snapshot.error === this.snapshot.error) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) { try { listener(); } catch { /* Presentation cannot affect execution. */ } }
  }

  private prepareWorker(): Promise<{ registration: ServiceWorkerRegistration; clientId: string } | null> {
    if (!this.environment.serviceWorkers) return Promise.resolve(null);
    if (this.registration) return this.registration;
    this.registration = (async () => {
      const url = new URL("./turn-notification-worker.js?no-inline", import.meta.url);
      // A dedicated nested scope avoids replacing the preview/proxy/host worker.
      const registration = await this.environment.serviceWorkers!.register(url, { scope: new URL("./turn-notifications/", url).href });
      const worker = registration.active ?? registration.installing ?? registration.waiting;
      if (!worker) throw new Error("Notification worker unavailable");
      if (worker.state !== "activated") await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => { clearTimeout(timeout); worker.removeEventListener("statechange", check); error ? reject(error) : resolve(); };
        const check = () => { if (worker.state === "activated") finish(); else if (worker.state === "redundant") finish(new Error("Notification worker retired")); };
        const timeout = setTimeout(() => finish(new Error("Notification worker activation timed out")), 5000);
        worker.addEventListener("statechange", check);
        check();
      });
      const clientId = await new Promise<string>((resolve, reject) => {
        const channel = new MessageChannel();
        const timeout = setTimeout(() => { channel.port1.close(); reject(new Error("Notification worker identity timed out")); }, 3000);
        channel.port1.onmessage = event => {
          clearTimeout(timeout); channel.port1.close();
          typeof event.data === "string" ? resolve(event.data) : reject(new Error("Notification Client identity unavailable"));
        };
        worker.postMessage({ kind: "opencraft-turn-client" }, [channel.port2]);
      });
      return { registration, clientId };
    })().catch(() => { this.registration = null; return null; });
    return this.registration;
  }
}
