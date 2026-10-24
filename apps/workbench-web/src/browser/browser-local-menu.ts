export type BrowserMenuAction = 'copy' | 'copy-link';
export interface BrowserClipboardData { readonly text?: string; readonly html?: string }
export interface BrowserMenuLabels { readonly copy: string; readonly copyLink: string }
export interface BrowserMenuSnapshot {
  readonly id: string; readonly x: number; readonly y: number;
  readonly copy: boolean; readonly link: boolean;
}
interface NativeMenuPort {
  show(id: string, x: number, y: number, items: readonly { id: BrowserMenuAction; label: string; enabled: boolean }[]): Promise<BrowserMenuAction | null>;
  cancel(id: string): void;
  writeClipboard(data: BrowserClipboardData): Promise<void>;
}
interface Menu extends BrowserMenuSnapshot {
  current(): boolean;
  run(action: BrowserMenuAction): Promise<BrowserClipboardData>;
  focus(): void;
  error(message: string): void;
}

/** Owns a single local menu and copy intent across all physical pages. Remote
 * data alone can never write the clipboard. Retiring a view rejects its Blob. */
export class BrowserLocalMenuController {
  private menu: Menu | null = null;
  private snapshot: BrowserMenuSnapshot | null = null;
  private listeners = new Set<() => void>();
  private transaction: AbortController | null = null;
  private labels: BrowserMenuLabels = { copy: 'Copy', copyLink: 'Copy link address' };
  constructor(private readonly native: NativeMenuPort | undefined = (window as any).opencraftDesktop?.remoteBrowserMenu) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setLabels(labels: BrowserMenuLabels) { this.labels = labels; }
  open(menu: Omit<Menu, 'id'>) {
    this.retire();
    if (!menu.current() || !menu.copy && !menu.link) return;
    const current = this.menu = { ...menu, id: crypto.randomUUID() };
    if (this.native) {
      const items = [
        ...(menu.copy ? [{ id: 'copy' as const, label: this.labels.copy, enabled: true }] : []),
        ...(menu.link ? [{ id: 'copy-link' as const, label: this.labels.copyLink, enabled: true }] : []),
      ];
      void this.native.show(current.id, menu.x, menu.y, items).then(action => {
        if (this.menu !== current || !current.current()) return;
        if (action) this.select(current.id, action); else this.dismiss(current.id);
      }).catch(() => { if (this.menu === current) { this.dismiss(current.id); current.error('Could not open the menu'); } });
    } else {
      this.snapshot = { id: current.id, x: menu.x, y: menu.y, copy: menu.copy, link: menu.link };
      this.emit();
    }
  }
  dismiss(id: string) {
    if (this.menu?.id !== id) return;
    const old = this.menu;
    this.menu = null; this.snapshot = null; this.native?.cancel(id); this.emit();
    if (old.current()) old.focus();
  }
  select(id: string, action: BrowserMenuAction) {
    const menu = this.menu;
    if (!menu || menu.id !== id || !menu.current() || (action === 'copy' ? !menu.copy : !menu.link)) return;
    // Keep the native clipboard write inside a local user intent. The browser
    // ClipboardItem promises are created now, before the network round trip.
    this.copy(() => menu.run(action), menu.current, menu.error);
    this.dismiss(id);
  }
  copy(read: () => Promise<BrowserClipboardData>, current: () => boolean, error: (message: string) => void) {
    this.transaction?.abort();
    const transaction = this.transaction = new AbortController();
    const timer = setTimeout(() => {
      if (!transaction.signal.aborted && current()) error('Copy timed out. Select the text and try again.');
      transaction.abort();
    }, 10_000);
    const data = new Promise<BrowserClipboardData>((resolve, reject) => {
      transaction.signal.addEventListener('abort', () => reject(new Error('Copy canceled')), { once: true });
      void Promise.resolve().then(() => {
        if (transaction.signal.aborted || !current()) throw new Error('Copy canceled');
        return read();
      }).then(value => {
        if (transaction.signal.aborted || !current()) throw new Error('Copy canceled');
        if (!value || typeof value !== 'object'
          || value.text === undefined && value.html === undefined
          || value.text !== undefined && typeof value.text !== 'string'
          || value.html !== undefined && typeof value.html !== 'string'
          || (value.text?.length ?? 0) + (value.html?.length ?? 0) > 65536) throw new Error('Invalid clipboard result');
        resolve(value);
      }).catch(reject);
    });
    const alive = () => !transaction.signal.aborted && current();
    const written = this.native ? data.then(value => {
      if (!alive()) throw new Error('Copy canceled');
      return this.native!.writeClipboard(value);
    }) : writeBrowserClipboard(data, alive);
    void written.catch(() => {
      if (!transaction.signal.aborted && current()) error('Could not copy. Select the text and try again.');
      transaction.abort();
    })
      .finally(() => { clearTimeout(timer); if (this.transaction === transaction) this.transaction = null; });
  }
  retire() {
    this.transaction?.abort(); this.transaction = null;
    const id = this.menu?.id;
    this.menu = null; this.snapshot = null;
    if (id) this.native?.cancel(id);
    this.emit();
  }
  private emit() { for (const listener of this.listeners) listener(); }
}

function escaped(text: string) { return text.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!); }
function writeBrowserClipboard(data: Promise<BrowserClipboardData>, current: () => boolean): Promise<void> {
  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    // The Web Clipboard API fixes the offered MIME types at user activation.
    // Normalize a plain-only result to equivalent inert HTML; HTML-only custom
    // copies retain their exact HTML and offer an empty plain-text alternative.
    const text = data.then(value => {
      if (!current()) throw new Error('Copy canceled');
      return new Blob([value.text ?? ''], { type: 'text/plain' });
    });
    const html = data.then(value => {
      if (!current()) throw new Error('Copy canceled');
      return new Blob([value.html ?? `<pre>${escaped(value.text ?? '')}</pre>`], { type: 'text/html' });
    });
    void text.catch(() => {}); void html.catch(() => {});
    try { return navigator.clipboard.write([new ClipboardItem({ 'text/plain': text, 'text/html': html })]); }
    catch (error) { return Promise.reject(error); }
  }
  // LAN HTTP has no Async Clipboard API. Use the browser's clipboard command,
  // returning its actual result. No remote input is mirrored into an editor.
  return data.then(value => {
    if (!current()) throw new Error('Copy canceled');
    const focused = document.activeElement as HTMLElement | null;
    const helper = document.createElement('textarea');
    helper.setAttribute('aria-hidden', 'true'); helper.style.position = 'fixed'; helper.style.opacity = '0';
    document.body.append(helper); helper.focus(); helper.select();
    let handled = false;
    const copy = (event: ClipboardEvent) => {
      if (event.target !== helper || !event.clipboardData) return;
      event.preventDefault();
      if (value.text !== undefined) event.clipboardData.setData('text/plain', value.text);
      if (value.html !== undefined) event.clipboardData.setData('text/html', value.html);
      handled = true;
    };
    helper.addEventListener('copy', copy);
    try { if (!document.execCommand('copy') || !handled) throw new Error('Clipboard write refused'); }
    finally { helper.removeEventListener('copy', copy); helper.remove(); if (focused?.isConnected && current()) focused.focus({ preventScroll: true }); }
  });
}
