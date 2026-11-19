import { forwardedRecordIdentity } from '@opencraft/appserver-protocol';
/** Directory labels and readable preview are derived. Freeze the first presentation;
 * replay identity retains all provider document content and nested media identities. */
export function forwardedEnvelopeIdentity(event) {
  return event.forwardedRecord
    ? {
        ...event,
        text: '',
        forwardedRecord: forwardedRecordIdentity(event.forwardedRecord),
      }
    : event;
}
