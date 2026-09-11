import { useHostConnectionPhase } from "../runtime/appserver-runtime-context";

export function TargetConnectionStatus({ hostId }: { hostId: string }) {
  const phase = useHostConnectionPhase(hostId);
  return <ConnectionStatus phase={phase} />;
}

/** Pure presentation: only the runtime owns connection state. */
export function ConnectionStatus({ phase }: { phase: string }) {
  const label = phase === "ready" ? "Connected" : phase === "reconnecting" ? "Reconnecting"
    : phase === "error" ? "Connection error" : phase === "idle" ? "Not connected" : phase;
  return <span className="workbench-connection-status" data-phase={phase} role="img" aria-label={label} title={label} />;
}
