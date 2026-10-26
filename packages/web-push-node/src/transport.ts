import type { DuplexTransport, TransportSubmissionContext } from '@opencraft/appserver-client/transport';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';

/** Only trusted transport metadata supplies actor identity. A push observer cannot
 * reject, replay or mutate an engine submission. History proves admission later. */
export class PushObservationTransport implements DuplexTransport {
  constructor(private readonly inner: DuplexTransport,
    private readonly observe: (value: {actorId:string;threadId:string;inputId:string}) => void) {}
  get status() { return this.inner.status; }
  connect(signal?: AbortSignal) { return this.inner.connect(signal); }
  send(frame: string, signal?: AbortSignal) { return this.inner.send(frame,signal); }
  async sendWithContext(frame: string, context: TransportSubmissionContext, signal?: AbortSignal) {
    try {
      const value = JSON.parse(frame), params = value.params;
      if (context.actorContext && ['turn/start','turn/steer','thread/queue/add'].includes(value.method)
        && typeof value[LOGICAL_CLIENT_FIELD] === 'string'
        && typeof params?.threadId === 'string' && params.threadId.length > 0 && params.threadId.length <= 1024
        && typeof params.clientUserMessageId === 'string' && params.clientUserMessageId.length > 0 && params.clientUserMessageId.length <= 1024) {
        context.resourceOwner?.assertCurrent();
        this.observe({actorId:context.actorContext.actorId,threadId:params.threadId,inputId:params.clientUserMessageId});
      }
    } catch { /* An unavailable notification consumer must not change execution. */ }
    if (this.inner.sendWithContext) await this.inner.sendWithContext(frame,context,signal);
    else await this.inner.send(frame,signal);
  }
  subscribeMessage: DuplexTransport['subscribeMessage'] = listener => this.inner.subscribeMessage(listener);
  subscribeStatus: DuplexTransport['subscribeStatus'] = listener => this.inner.subscribeStatus(listener);
  subscribeRecoveryHint: NonNullable<DuplexTransport['subscribeRecoveryHint']> = listener => this.inner.subscribeRecoveryHint?.(listener) ?? (() => {});
  close() { return this.inner.close(); }
}
