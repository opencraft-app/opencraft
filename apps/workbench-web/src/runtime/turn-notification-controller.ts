import type { UiPreferencesRuntime } from '@opencraft/ui-preferences';
import type { TurnCompletion } from '@opencraft/workbench-runtime';
import { BrowserTurnNotifications } from './browser-turn-notifications';
import { PwaTurnPushController, type PushMessages } from './pwa-turn-push';
import type { PushDevicePort } from './push-device';

/** One user feature, with page and persistent delivery adapters underneath it. */
export interface TurnNotificationSnapshot {
  readonly supported: boolean;
  readonly permission: NotificationPermission;
  readonly enabled: boolean;
  readonly busy: boolean;
  readonly delivery: 'page' | 'background';
  readonly backgroundAvailable: boolean;
  readonly testSent: boolean;
  readonly error: 'permission' | 'save' | 'delivery' | 'connection' | null;
}
type Preferences = Pick<UiPreferencesRuntime, 'get' | 'set' | 'subscribe'>;

export class TurnNotificationController {
  private readonly page: BrowserTurnNotifications;
  private readonly push: PwaTurnPushController | null;
  private readonly listeners = new Set<() => void>();
  private readonly stops: Array<() => void>;
  private preferences: Preferences | null = null;
  private snapshot: TurnNotificationSnapshot;
  private operation = false;
  private pagePaused = false;
  private disposed = false;
  private signedOut = false;
  private generation = 0;
  private error: TurnNotificationSnapshot['error'] = null;
  constructor(private readonly device?: PushDevicePort, page = new BrowserTurnNotifications(), push?: PwaTurnPushController) {
    this.page = page;
    this.push = push ?? (device?.supported ? new PwaTurnPushController(device) : null);
    this.snapshot = this.read();
    this.stops = [page.subscribe(() => this.publish())];
    if (this.push) this.stops.push(this.push.subscribe(() => this.publish()));
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private read(): TurnNotificationSnapshot {
    const local = this.page.getSnapshot(), push = this.push?.getSnapshot();
    return {
      supported: local.supported || this.push !== null, permission: this.device?.permission() ?? local.permission,
      enabled: !this.signedOut && ((!this.pagePaused && this.preferences?.get('chat.turnNotifications') === true) || push?.enabled === true),
      busy: this.operation || push?.phase === 'loading' || push?.phase === 'enabling' || push?.phase === 'disabling' || push?.phase === 'testing',
      delivery: push?.enabled ? 'background' : 'page',
      backgroundAvailable: this.push?.available() === true,
      testSent: push?.testSent === true,
      error: this.error ?? (local.error ? 'delivery' : push?.phase === 'error' ? 'connection' : null),
    };
  }
  private publish() {
    if (this.disposed) return;
    const next = this.read();
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  /** Provider attaches the existing preference owner; it does not create another store.
   * Existing page consent never silently creates a background subscription. */
  connect(preferences: Preferences) {
    this.preferences = preferences;
    let previous = preferences.get('chat.turnNotifications');
    const stop = preferences.subscribe(() => {
      const enabled = preferences.get('chat.turnNotifications');
      const changed = enabled !== previous; previous = enabled;
      if (changed && !enabled && !this.pagePaused && (this.operation || this.push?.getSnapshot().enabled)) void this.setEnabled(false);
      this.publish();
    });
    this.publish();
    if (this.snapshot.enabled) this.page.prepare();
    return () => { stop(); if (this.preferences === preferences) this.preferences = null; };
  }
  configure(locale: string, messages: PushMessages) { this.push?.configure(locale, messages); }
  refresh = async () => {
    this.page.refresh();
    await this.push?.refresh();
    this.publish();
  };
  /** No await before permission/subscribe: iOS needs the original click activation. */
  async setEnabled(enabled: boolean) {
    if (this.disposed || (this.operation && enabled) || !this.preferences) return;
    this.operation = true; this.error = null;
    const generation = ++this.generation, preferences = this.preferences;
    if (enabled) { this.signedOut = false; this.pagePaused = false; }
    else this.pagePaused = true;
    this.publish();
    try {
      if (enabled) {
        if (this.push?.available()) {
          const pending = this.push.enable();
          const success = await pending;
          if (!success) { this.error = this.read().permission === 'denied' ? 'permission' : 'connection'; return; }
        } else {
          const permission = this.page.requestPermission();
          if (await permission !== 'granted') { this.error = 'permission'; return; }
        }
        if (this.disposed || generation !== this.generation) return;
        await preferences.set('chat.turnNotifications', true, { optimistic: false });
      } else {
        // Stop the local path immediately. Keep a failed revocation visible as enabled
        // rather than pretending an active persistent subscription has been disabled.
        let saveFailed = false;
        try { await preferences.set('chat.turnNotifications', false, { optimistic: false }); } catch { saveFailed = true; }
        if (this.disposed || generation !== this.generation) return;
        if (this.push && !await this.push.disable()) this.error = 'connection';
        if (saveFailed) this.error = 'save';
      }
    } catch { if (generation === this.generation) this.error = 'save'; }
    finally { if (generation === this.generation) this.operation = false; this.publish(); }
  }
  test() { return this.push?.test(); }
  async beforeSignOut() {
    this.signedOut = true; this.operation = false; ++this.generation; this.publish();
    await this.push?.beforeSignOut();
  }
  show(completion: TurnCompletion, title: string, body: string, onClick: () => void) {
    if (!this.snapshot.enabled || this.signedOut || this.push?.handles(completion.hostId)) return Promise.resolve();
    return this.page.show(completion, title, body, () => this.snapshot.enabled && !this.signedOut && !this.push?.handles(completion.hostId), onClick);
  }
  observeClicks(onClick: (completion: TurnCompletion) => void) { return this.page.observeClicks(onClick); }
  dispose() {
    this.disposed = true; ++this.generation;
    this.stops.forEach(stop => stop()); this.listeners.clear(); this.push?.dispose(); this.page.dispose();
  }
}
