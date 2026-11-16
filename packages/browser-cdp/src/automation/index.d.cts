import type { BrowserAutomation } from '@opencraft/browser-core';
import type { CdpTransport, CdpCallOptions } from '../transport';
export const capabilities: BrowserAutomation['capabilities'];
export interface CdpAutomation extends BrowserAutomation {
  invoke(method: 'inspect' | 'readContext' | 'click' | 'fill' | 'press' | 'scroll' | 'wait',
    input?: Readonly<Record<string, unknown>>, options?: CdpCallOptions): Promise<unknown>;
}
export function createCdpAutomation(options: {
  readonly transport: CdpTransport;
  readonly sessions: () => readonly { readonly sessionId: string }[];
  readonly instanceId: string;
  readonly platform?: string;
  /** Keep native rendering active until the returned release is called. */
  readonly acquireDrawing: () => (() => void) | Promise<() => void>;
}): CdpAutomation;
