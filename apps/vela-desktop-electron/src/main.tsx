import React from "react";
import { createRoot } from "react-dom/client";
import { DesktopApp } from "./DesktopApp";
import { SessionDragPreviewRoot } from "./session-drag-preview";
import { WorkMonitorRoot } from "./work-monitor";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

const searchParams = new URLSearchParams(window.location.search);
const windowKind = searchParams.get("window");
const sessionId = searchParams.get("session_id") ?? "";

createRoot(root).render(
  <React.StrictMode>
    {windowKind === "work-monitor" ? (
      <WorkMonitorRoot sessionId={sessionId} />
    ) : windowKind === "session-drag-preview" ? (
      <SessionDragPreviewRoot sessionId={sessionId} />
    ) : (
      <DesktopApp />
    )}
  </React.StrictMode>,
);
