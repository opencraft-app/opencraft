import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { defineMessages } from "@opencraft/i18n";
import { useIntl } from "@opencraft/i18n/react";
import type { ThreadRecoveryResource } from "@opencraft/workbench-runtime";

const messages = defineMessages({
  continued: { id: "turnRecovery.continued", defaultMessage: "Automatically continued after a service restart ({attempts}/{limit})." },
  exhausted: { id: "turnRecovery.exhausted", defaultMessage: "Automatic continuation stopped after {limit} attempts. Send a message to continue." },
  unconfirmed: { id: "turnRecovery.unconfirmed", defaultMessage: "Automatic continuation could not be confirmed. Check this conversation before continuing." },
});
export function ThreadRecoveryNotice({ threadId, resource, children }: { threadId: string | null; resource: ThreadRecoveryResource; children?: (notice: ReactNode | null) => ReactNode }) {
  const intl = useIntl();
  const subscribe = useCallback((listener: () => void) => threadId ? resource.subscribe(threadId, listener) : () => {}, [resource, threadId]);
  const read = useCallback(() => threadId ? resource.getSnapshot(threadId) : null, [resource, threadId]);
  const notice = useSyncExternalStore(subscribe, read, read);
  useEffect(() => { if (threadId) void resource.refresh(threadId); }, [resource, threadId]);
  const content = notice ? <p className="thread-recovery-notice" role="status" data-state={notice.state}>
    {intl.formatMessage(messages[notice.state], { attempts: notice.attempts, limit: notice.limit })}
  </p> : null;
  return children ? children(content) : content;
}
