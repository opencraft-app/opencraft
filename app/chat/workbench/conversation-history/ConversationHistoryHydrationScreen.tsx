"use client";

import type { CSSProperties } from "react";

const shellStyle = {
  alignItems: "center",
  background: "#fff",
  color: "#6f737a",
  display: "flex",
  flexDirection: "column",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Segoe UI", system-ui, ui-sans-serif, sans-serif',
  gap: 14,
  height: "100dvh",
  justifyContent: "center",
  minHeight: "100dvh",
  WebkitFontSmoothing: "antialiased",
} satisfies CSSProperties;

const spinnerStyle = {
  animation: "vela-history-spin 900ms linear infinite",
  border: "2px solid #ececef",
  borderTopColor: "#8c9096",
  borderRadius: "999px",
  height: 24,
  width: 24,
} satisfies CSSProperties;

const labelStyle = {
  fontSize: 14,
  fontWeight: 620,
} satisfies CSSProperties;

export function ConversationHistoryHydrationScreen() {
  return (
    <main aria-busy="true" aria-label="Loading conversation history" style={shellStyle}>
      <style>
        {`@keyframes vela-history-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}
      </style>
      <div aria-hidden="true" style={spinnerStyle} />
      <div style={labelStyle}>正在加载完整会话</div>
    </main>
  );
}
