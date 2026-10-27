import { useHostConnectionPhase } from "../runtime/appserver-runtime-context";
import { useIntl } from "@opencraft/i18n/react";

export function TargetConnectionStatus({ hostId, showLabel }: { hostId: string; showLabel?: boolean }) {
  const phase = useHostConnectionPhase(hostId);
  return <ConnectionLabel phase={phase} showLabel={showLabel} />;
}

export function ConnectionLabel({ phase, showLabel = false }: { phase: string; showLabel?: boolean }) {
  const intl = useIntl();
  const message = connectionMessage(phase);
  return showLabel ? <span className="environment-connection-label"><ConnectionStatus phase={phase} /><span>{intl.formatMessage(message)}</span></span> : <ConnectionStatus phase={phase} />;
}

/** Pure presentation: only the runtime owns connection state. */
export function ConnectionStatus({ phase }: { phase: string }) {
  const intl = useIntl();
  const label = intl.formatMessage(connectionMessage(phase));
  return <span className="workbench-connection-status" data-phase={phase} role="img" aria-label={label} title={label} />;
}

function connectionMessage(phase: string) {
  return phase === "ready" ? { id: "settings.connection.ready", defaultMessage: "Connected" }
    : phase === "idle" ? { id: "settings.connection.notStarted", defaultMessage: "Not started" }
    : phase === "error" ? { id: "settings.connection.error", defaultMessage: "Connection failed" }
    : phase === "reconnecting" ? { id: "settings.connection.reconnecting", defaultMessage: "Reconnecting" }
    : { id: "settings.connection.connecting", defaultMessage: "Connecting" };
}
