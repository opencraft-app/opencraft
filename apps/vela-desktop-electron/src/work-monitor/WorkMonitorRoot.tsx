import { useEffect, useState } from "react";
import {
  readRuntimeBootstrap,
  type RuntimeBootstrap,
} from "../desktopBridge";
import { WorkMonitorApp } from "./WorkMonitorApp";
import styles from "./work-monitor.module.css";

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
      <main className={styles.workMonitorApp}>
        <div className={styles.workMonitorError} role="alert">
          <span>Monitor unavailable</span>
          <strong>Missing session id</strong>
        </div>
      </main>
    );
  }

  if (bootstrap.status === "ready") {
    return <WorkMonitorApp hostInfo={bootstrap.info} sessionId={sessionId.trim()} />;
  }

  return (
    <main className={styles.workMonitorApp}>
      <div className={styles.workMonitorLoading} data-state={bootstrap.status}>
        <span>{bootstrap.status === "starting" ? "Connecting" : "Monitor failed"}</span>
        <strong>
          {bootstrap.status === "starting" ? bootstrap.message : bootstrap.error}
        </strong>
      </div>
    </main>
  );
}
