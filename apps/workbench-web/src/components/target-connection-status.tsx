import { useHostConnectionPhase, useHostExecutionState } from "../runtime/appserver-runtime-context";
import { useIntl } from "@opencraft/i18n/react";

export function TargetConnectionStatus({ hostId, showLabel }: { hostId: string; showLabel?: boolean }) {
  const phase = useHostConnectionPhase(hostId);
  const execution = useHostExecutionState(hostId);
  return <ConnectionLabel phase={phase} execution={execution} showLabel={showLabel} />;
}

export function ConnectionLabel({ phase, execution, showLabel = false }: { phase: string; execution?: string; showLabel?: boolean }) {
  const intl = useIntl();
  const message = connectionMessage(phase, execution);
  return showLabel ? <span className="environment-connection-label"><ConnectionStatus phase={phase} execution={execution} /><span>{intl.formatMessage(message)}</span></span> : <ConnectionStatus phase={phase} execution={execution} />;
}

/** Pure presentation: only the runtime owns connection state. */
export function ConnectionStatus({ phase, execution }: { phase: string; execution?: string }) {
  const intl = useIntl();
  const label = intl.formatMessage(connectionMessage(phase, execution));
  return <span className="workbench-connection-status" data-phase={execution === "recovering" ? "reconnecting" : execution === "unavailable" ? "error" : phase} role="img" aria-label={label} title={label} />;
}

function connectionMessage(phase: string, execution?: string) {
  if (execution === "recovering" || execution === "unavailable") return {id: "chat.execution.recovering", defaultMessage: "Execution is recovering. New messages will wait in the queue."};
  return phase === "ready" ? { id: "settings.connection.ready", defaultMessage: "Connected" }
    : phase === "idle" ? { id: "settings.connection.notStarted", defaultMessage: "Not started" }
    : phase === "error" ? { id: "settings.connection.error", defaultMessage: "Connection failed" }
    : phase === "reconnecting" ? { id: "settings.connection.reconnecting", defaultMessage: "Reconnecting" }
    : { id: "settings.connection.connecting", defaultMessage: "Connecting" };
}
