import { Menu, clipboard, ClipboardItem, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';

/** Only trusted workbench UI can present this menu. Remote pages never receive
 * this port, arbitrary roles, callbacks, URLs or host clipboard read access. */
export function installRemoteBrowserMenu(ipc: IpcMain, trusted: (event: IpcMainInvokeEvent) => boolean,
  window: () => BrowserWindow | null) {
  let active: { id: string; menu: Menu; finish(action: string | null): void } | null = null;
  const cancel = (id?: string) => {
    if (!active || id !== undefined && active.id !== id) return;
    const old = active; active = null;
    const owner = window(); if (owner && !owner.isDestroyed()) old.menu.closePopup(owner);
    old.finish(null);
  };
  const check = (event: IpcMainInvokeEvent) => { if (!trusted(event)) throw new Error('Untrusted browser menu caller'); };
  ipc.handle('opencraft:remote-browser-menu-show', (event, id: unknown, x: unknown, y: unknown, items: unknown) => {
    check(event);
    const owner = window();
    if (!owner || owner.isDestroyed() || typeof id !== 'string' || !/^[a-zA-Z0-9-]{20,100}$/.test(id)
      || typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)
      || !Array.isArray(items) || items.length < 1 || items.length > 2) throw new Error('Invalid browser menu');
    const seen = new Set<string>();
    const rows = items.map(item => {
      if (!item || !['copy', 'copy-link'].includes(item.id) || seen.has(item.id)
        || typeof item.label !== 'string' || !item.label || item.label.length > 100 || typeof item.enabled !== 'boolean')
        throw new Error('Invalid browser menu item');
      seen.add(item.id);
      return { id: item.id as string, label: item.label as string, enabled: item.enabled as boolean };
    });
    cancel();
    return new Promise<string | null>(resolve => {
      let settled = false;
      const finish = (action: string | null) => {
        if (settled) return; settled = true;
        if (active?.id === id) active = null;
        resolve(action);
      };
      const menu = Menu.buildFromTemplate(rows.map(row => ({ label: row.label, enabled: row.enabled, click: () => finish(row.id) })));
      active = { id, menu, finish };
      const [width, height] = owner.getContentSize();
      menu.popup({ window: owner, x: Math.max(0, Math.min(width - 1, Math.round(x))),
        y: Math.max(0, Math.min(height - 1, Math.round(y))), callback: () => finish(null) });
    });
  });
  ipc.handle('opencraft:remote-browser-menu-cancel', (event, id: unknown) => { check(event); if (typeof id === 'string') cancel(id); });
  ipc.handle('opencraft:remote-browser-clipboard-write', (event, value: unknown) => {
    check(event);
    if (!value || typeof value !== 'object') throw new Error('Invalid clipboard data');
    const data = value as Record<string, unknown>;
    if (Object.keys(data).some(key => key !== 'text' && key !== 'html')
      || data.text === undefined && data.html === undefined
      || data.text !== undefined && typeof data.text !== 'string'
      || data.html !== undefined && typeof data.html !== 'string'
      || String(data.text ?? '').length + String(data.html ?? '').length > 65536) throw new Error('Invalid clipboard data');
    return clipboard.write([new ClipboardItem({
      ...(typeof data.text === 'string' ? { 'text/plain': new Blob([data.text], { type: 'text/plain' }) } : {}),
      ...(typeof data.html === 'string' ? { 'text/html': new Blob([data.html], { type: 'text/html' }) } : {}),
    })]);
  });
  return cancel;
}
