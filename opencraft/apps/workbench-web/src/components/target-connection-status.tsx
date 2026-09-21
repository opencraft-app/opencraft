import { useHostConnectionPhase } from "../runtime/appserver-runtime-context";

export function TargetConnectionStatus({ hostId, showLabel = false }: { hostId: string; showLabel?: boolean }) {
  const phase = useHostConnectionPhase(hostId);
  return showLabel ? <span className="environment-connection-label"><ConnectionStatus phase={phase} /><span>{phase === "ready" ? "已连接" : phase === "idle" ? "未连接" : phase === "error" ? "连接失败" : phase === "reconnecting" ? "重新连接中" : "连接中"}</span></span> : <ConnectionStatus phase={phase} />;
}

/** Pure presentation: only the runtime owns connection state. */
export function ConnectionStatus({ phase }: { phase: string }) {
  const label = phase === "ready" ? "Connected" : phase === "reconnecting" ? "Reconnecting"
    : phase === "error" ? "Connection error" : phase === "idle" ? "Not connected" : phase;
  return <span className="workbench-connection-status" data-phase={phase} role="img" aria-label={label} title={label} />;
}
