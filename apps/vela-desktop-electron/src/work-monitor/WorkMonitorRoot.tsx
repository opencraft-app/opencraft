import { useEffect, useState } from "react";
import {
  readRuntimeBootstrap,
  type RuntimeBootstrap,
} from "../desktopBridge";
import { SessionPreviewStatus } from "../session-preview";
import { WorkMonitorApp } from "./WorkMonitorApp";

export interface WorkMonitorRootProps {
  sessionId: string;
}

export function WorkMonitorRoot({ sessionId }: WorkMonitorRootProps) {
  const [bootstrap, setBootstrap] = useState<RuntimeBootstrap>({
    status: "starting",
    message: "Connecting to runtime...",
  });

  useEffect(() => {
    let cancelled = false;
    void readRuntimeBootstrap().then((nextBootstrap) => {
      if (!cancelled) setBootstrap(nextBootstrap);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!sessionId.trim()) {
    return (
      <SessionPreviewStatus
        label="Monitor unavailable"
        role="alert"
        value="Missing session id"
      />
    );
  }

  if (bootstrap.status === "ready") {
    return <WorkMonitorApp hostInfo={bootstrap.info} sessionId={sessionId.trim()} />;
  }

  return (
    <SessionPreviewStatus
      label={bootstrap.status === "starting" ? "Connecting" : "Monitor failed"}
      role={bootstrap.status === "starting" ? "status" : "alert"}
      value={bootstrap.status === "starting" ? bootstrap.message : bootstrap.error}
    />
  );
}
