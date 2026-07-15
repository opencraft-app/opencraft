"use client";

import { useEffect, useState } from "react";
import {
  ACCOUNT_PREVIEW_STATES,
  DEFAULT_ACCOUNT_PREVIEW_KEY,
} from "@/repositories/account-preview-states";

/**
 * 账号页本地预览「交互状态切换器」——右下角浮层。
 *
 * 仅在本地 mock 预览模式（NEXT_PUBLIC_AUTH_API_BASE_URL=mock）下渲染，
 * 生产/真实后端环境一律不出现，不影响线上。
 *
 * 点击某个状态：改写 URL 的 ?state= 并重新加载页面，
 * 由 fake-repositories 的 getSession 按 state 重置假会话。
 */
const isMockPreviewEnabled = (): boolean => {
  const base = (
    (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_AUTH_API_BASE_URL : undefined)
    ?? (typeof import.meta !== "undefined" ? import.meta.env?.VITE_AUTH_API_BASE_URL : undefined)
  )?.trim().toLowerCase();
  return base === "mock";
};

export const AccountPreviewStateSwitcher = () => {
  const [enabled, setEnabled] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [currentKey, setCurrentKey] = useState<string>(DEFAULT_ACCOUNT_PREVIEW_KEY);

  useEffect(() => {
    if (!isMockPreviewEnabled() || typeof window === "undefined") return;
    setEnabled(true);
    const key = new URLSearchParams(window.location.search).get("state");
    setCurrentKey(key && key.trim().length > 0 ? key.trim() : DEFAULT_ACCOUNT_PREVIEW_KEY);
  }, []);

  if (!enabled) return null;

  const applyState = (key: string) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("state", key);
    // 清掉可能残留的假会话存储，确保按新状态重建
    try {
      window.localStorage.removeItem("lightclaw-fake-auth-v1");
    } catch {
      // ignore
    }
    window.location.href = url.toString();
  };

  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 2147483000,
        fontFamily: "PingFang SC, system-ui, sans-serif",
      }}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            border: "1px solid #E6E9EF",
            background: "#202020",
            color: "#fff",
            fontSize: 13,
            fontWeight: 500,
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
            cursor: "pointer",
          }}
        >
          预览状态
        </button>
      ) : (
        <div
          style={{
            width: 260,
            maxHeight: "70vh",
            overflowY: "auto",
            background: "#fff",
            border: "1px solid #E6E9EF",
            borderRadius: 12,
            boxShadow: "0 16px 40px rgba(0,0,0,0.18)",
            padding: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: "rgba(0,0,0,0.9)" }}>
              账号页预览状态
            </span>
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-label="收起"
              style={{
                border: "none",
                background: "transparent",
                color: "rgba(0,0,0,0.5)",
                fontSize: 16,
                lineHeight: 1,
                cursor: "pointer",
              }}
            >
              ×
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {ACCOUNT_PREVIEW_STATES.map((state) => {
              const active = state.key === currentKey;
              return (
                <button
                  key={state.key}
                  type="button"
                  onClick={() => applyState(state.key)}
                  style={{
                    textAlign: "left",
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: active ? "1px solid #202020" : "1px solid #E9ECF1",
                    background: active ? "rgba(32,32,32,0.06)" : "#fff",
                    color: "rgba(0,0,0,0.85)",
                    fontSize: 12.5,
                    lineHeight: "18px",
                    fontWeight: active ? 600 : 400,
                    cursor: "pointer",
                  }}
                >
                  {state.label}
                </button>
              );
            })}
          </div>
          <p style={{ margin: "10px 2px 0", fontSize: 11, color: "rgba(0,0,0,0.4)", lineHeight: "16px" }}>
            仅本地 mock 预览可见 · 切换会重载页面
          </p>
        </div>
      )}
    </div>
  );
};
