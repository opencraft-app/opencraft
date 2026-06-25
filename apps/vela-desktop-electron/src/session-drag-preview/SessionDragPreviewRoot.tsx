import { useEffect, useState } from "react";
import {
  readRuntimeBootstrap,
  type RuntimeBootstrap,
} from "../desktopBridge";
import { SessionPreviewStatus } from "../session-preview";
import { SessionDragPreviewApp } from "./SessionDragPreviewApp";

export interface SessionDragPreviewRootProps {
  sessionId: string;
}

export function SessionDragPreviewRoot({ sessionId }: SessionDragPreviewRootProps) {
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
    return <PreviewStatus label="Preview unavailable" value="Missing session id" />;
  }

  if (bootstrap.status === "ready") {
    return <SessionDragPreviewApp hostInfo={bootstrap.info} sessionId={sessionId.trim()} />;
  }

  return (
    <PreviewStatus
      label={bootstrap.status === "starting" ? "Connecting" : "Preview failed"}
      value={bootstrap.status === "starting" ? bootstrap.message : bootstrap.error}
    />
  );
}

function PreviewStatus({ label, value }: { label: string; value: string }) {
  return (
    <SessionPreviewStatus
      label={label}
      role={label.includes("failed") || label.includes("unavailable") ? "alert" : "status"}
      value={value}
    />
  );
}
