import { useEffect, useRef } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { useAsyncNotices } from "./async-notices";
type ExecutionState = "ready" | "recovering" | "unavailable" | undefined;

/** Execution failure leaves the transcript and Composer mounted and readable. */
export function ExecutionRecoveryNotice({hostId, execution}: {hostId: string; execution: ExecutionState}) {
  const intl = useIntl(), notices = useAsyncNotices();
  const previous = useRef<{hostId: string; execution: ExecutionState} | null>(null);
  useEffect(() => {
    const prior = previous.current;
    if (prior?.hostId === hostId && prior.execution === execution) return;
    previous.current = {hostId, execution};
    if (execution === "recovering" || execution === "unavailable") notices.warning({key: `execution:${hostId}`,
      message: intl.formatMessage({id: "chat.execution.recovering", defaultMessage: "Execution is recovering. New messages will wait in the queue."})});
    else if (execution === "ready" && prior?.hostId === hostId && (prior.execution === "recovering" || prior.execution === "unavailable")) {
      notices.info({key: `execution:${hostId}`, message: intl.formatMessage({id: "chat.execution.recovered", defaultMessage: "Execution restored. Queued messages will continue."})});
    }
  }, [hostId, execution, intl, notices]);
  return null;
}
