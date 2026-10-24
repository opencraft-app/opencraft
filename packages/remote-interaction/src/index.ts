export { CreditWindow, parseMediaConfig, parseMediaFeedback, packetId } from './protocol.cjs';
export type { MediaConfig, MediaFeedback, FeedbackStage, CreditOptions } from './protocol.cjs';
export type { OrderedWire, SendResult } from './transport';
export { bindOrderedTransport } from './transport';

export type TransportKind = 'websocket' | 'webrtc';
/** Adapters attach an existing authorized resource; they never create or navigate it. */
export interface AuthorizedAttachment {
  readonly resourceId: string;
  readonly incarnation: string;
  readonly connectionEpoch: string;
}
export interface InteractionTransport {
  readonly kind: TransportKind;
  readonly attachment: AuthorizedAttachment;
  readonly inputDelivery: 'reliable-ordered';
  sendInput(message: string): import('./transport').SendResult;
  close(): void;
}
