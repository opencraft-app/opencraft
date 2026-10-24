import type { AuthorizedAttachment } from './index';
import { bindOrderedTransport } from './transport';

export interface ReliableDataChannel {
  readonly readyState: string;
  readonly bufferedAmount: number;
  readonly ordered: boolean;
  readonly maxPacketLifeTime: number | null;
  readonly maxRetransmits: number | null;
  send(message: string): void;
  close(): void;
}
/** Signaling, ICE and resource authorization belong to the host. */
export function bindWebRTCInput(attachment: AuthorizedAttachment, channel: ReliableDataChannel) {
  if (!channel.ordered || channel.maxPacketLifeTime !== null || channel.maxRetransmits !== null)
    throw new TypeError('Remote input requires a reliable ordered DataChannel');
  return bindOrderedTransport('webrtc', attachment, {
    get open() { return channel.readyState === 'open'; },
    get bufferedAmount() { return channel.bufferedAmount; },
    send: message => channel.send(message),
    close: () => channel.close(),
  });
}
