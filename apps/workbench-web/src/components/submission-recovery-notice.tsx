import { useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useIntl } from '@opencraft/i18n/react';
import { AlertIcon, CircleIcon } from '@opencraft/design-system-web/action-icons';
import { Button } from './ui/button';
import './submission-recovery-notice.scss';

export interface RecoverableSubmission {
  readonly commandId: string;
  readonly preview: string;
  readonly state: 'unknown' | 'failed';
}

/** The message owner performs the operation; this view owns only button feedback. */
export function SubmissionRecoveryNotice({ submission, onAbandon, onRetry }: {
  readonly submission: RecoverableSubmission;
  readonly onAbandon: (id: string) => Promise<void>;
  readonly onRetry: (id: string) => Promise<void>;
}) {
  const intl = useIntl();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const unknown = submission.state === 'unknown';
  const run = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true); setError(false);
    try { await (unknown ? onAbandon : onRetry)(submission.commandId); setOpen(false); }
    catch { setError(true); }
    finally { running.current = false; setBusy(false); }
  };
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild><button type="button" className="submission-recovery-trigger"
      data-status-kind={unknown ? 'unknown' : 'failed'}>
      {unknown ? <CircleIcon aria-hidden="true" size={8} /> : <AlertIcon aria-hidden="true" size={12} />}
      {intl.formatMessage(unknown
        ? { id: 'chat.message.unconfirmed', defaultMessage: 'Delivery unconfirmed' }
        : { id: 'chat.message.notSent', defaultMessage: 'Not sent' })}
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="submission-recovery-popover" side="top" align="end"
      sideOffset={4} collisionPadding={12}
      aria-label={intl.formatMessage({ id: 'chat.delivery.recovery', defaultMessage: 'Message delivery' })}>
      <p>{intl.formatMessage(unknown
        ? { id: 'chat.delivery.unknownHelp', defaultMessage: 'This message may still arrive. Stop waiting to send new messages; this does not cancel or resend the original.' }
        : { id: 'chat.delivery.failedHelp', defaultMessage: 'This message was not sent. Retry adds it to the end of the local queue.' })}</p>
      <Button variant="secondary" disabled={busy} onClick={() => void run()}>
        {intl.formatMessage(unknown
          ? { id: 'chat.delivery.abandon', defaultMessage: 'Stop waiting' }
          : { id: 'chat.delivery.retryTail', defaultMessage: 'Retry at end of queue' })}
      </Button>
      {error ? <p role="alert">{intl.formatMessage({ id: 'chat.delivery.actionFailed', defaultMessage: 'Could not save this change. Try again.' })}</p> : null}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
