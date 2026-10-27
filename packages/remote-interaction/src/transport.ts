import type { AuthorizedAttachment, TransportKind } from './index';

export interface OrderedWire {
  readonly open: boolean;
  readonly bufferedAmount: number;
  send(message: string): void;
  close(): void;
}
export type SendResult = 'sent' | 'blocked' | 'closed' | 'oversize' | 'unknown';

/** One existing authorized attachment; no internal send queue and no replay. */
export function bindOrderedTransport(kind: TransportKind, attachment: AuthorizedAttachment, wire: OrderedWire) {
  const identity = Object.freeze({ ...attachment });
  let retired = false;
  for (const value of Object.values(identity)) if (!value) throw new TypeError('Attachment identity is required');
  return {
    kind, attachment: identity, inputDelivery: 'reliable-ordered' as const,
    sendInput(message: string): SendResult {
      if (retired || !wire.open) return 'closed';
      const bytes = new TextEncoder().encode(message).byteLength;
      if (bytes > 65536) return 'oversize';
      if (wire.bufferedAmount + bytes > 65536) return 'blocked';
      try { wire.send(message); return 'sent'; }
      catch { retired = true; try { wire.close(); } catch {} return 'unknown'; }
    },
    close() { retired = true; wire.close(); },
  };
}
