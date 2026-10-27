import type { TrustedExtensionDefinition } from '@opencraft/extension-runtime';
import { WebSocketTransport, type AppServerWebSocket } from '@opencraft/appserver-transport-websocket';
import { CONNECT_DESKTOP_SERVER, parseDesktopServerConnection, type DesktopServerConnection, type DesktopServerPort } from '@opencraft/app-host-protocol/desktop-server';
import type { HostConnectionJson, HostConnectionProvider } from '@opencraft/workbench-runtime';

export function desktopServerPort(): DesktopServerPort | null {
  return (globalThis as typeof globalThis & { opencraftDesktop?: { servers?: DesktopServerPort } }).opencraftDesktop?.servers ?? null;
}
/** Adapt the existing socket transport; it retains attempt cancellation and physical cleanup. */
class NativeServerSocket implements AppServerWebSocket {
  private readonly events = new EventTarget();
  addEventListener: AppServerWebSocket['addEventListener'] = (type, listener, options) => this.events.addEventListener(type, listener as EventListener, options);
  removeEventListener: AppServerWebSocket['removeEventListener'] = (type, listener) => this.events.removeEventListener(type, listener as EventListener);
  private dispatchEvent(event: Event): void { this.events.dispatchEvent(event); }
  readyState = 0;
  private readonly port: MessagePort;
  constructor(config: DesktopServerConnection) {
    const channel = new MessageChannel(); this.port = channel.port1;
    this.port.onmessage = event => {
      const value = event.data;
      if (this.readyState >= 2 || !value || typeof value !== 'object') return;
      if (value.type === 'open') { this.readyState = 1; this.dispatchEvent(new Event('open')); }
      else if (value.type === 'message' && typeof value.data === 'string' && this.readyState === 1) this.dispatchEvent(new MessageEvent('message', { data: value.data }));
      else if (value.type === 'error') { this.dispatchEvent(new Event('error')); this.close(1006); }
      else if (value.type === 'close') this.close(1000);
    };
    this.port.start();
    window.postMessage({ type: CONNECT_DESKTOP_SERVER, ...config }, window.location.origin, [channel.port2]);
  }
  send(frame: string): void { if (this.readyState !== 1) throw new Error('Server socket is not open'); this.port.postMessage(frame); }
  close(code = 1000): void {
    if (this.readyState >= 2) return;
    this.readyState = 3; this.port.close(); this.dispatchEvent(new CloseEvent('close', { code }));
  }
}
export const DesktopServerProvider: HostConnectionProvider = {
  id: 'opencraft.desktop-server', label: 'OpenCraft Server', targets: ['electron'], configVersion: 1,
  validate(value) { if (!desktopServerPort()) throw new Error('Desktop server bridge unavailable'); return { ...parseDesktopServerConnection(value) } as HostConnectionJson; },
  createTransport(value) {
    const config = parseDesktopServerConnection(value);
    return new WebSocketTransport({ url: config.origin.replace(/^http/u, 'ws') + '/appserver', createSocket: () => new NativeServerSocket(config) });
  },
};

export const DesktopServerConnectionExtension: TrustedExtensionDefinition = {
  manifest: { manifestVersion: 1, id: 'opencraft.desktop-server', name: 'Desktop server connections', description: 'Connect the desktop workbench with native server sign-in.', version: '1.0.0', apiVersion: 1, trust: 'trusted', platforms: ['electron'], activationEvents: ['onStartupFinished'] },
  activate(api) { api.internal.register('hostConnectionProvider', DesktopServerProvider); },
};
