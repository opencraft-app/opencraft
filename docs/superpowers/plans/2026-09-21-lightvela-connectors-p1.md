# LightVela 连接器 P1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Agent 设置页新增「连接器」面板，复用 ai-server 已建成的连接器平台（OAuth + 实例下发），首批开放腾讯会议（tencent-meeting）。

**Architecture:** 前端（mono2/frontend）新增 API client + 面板组件，通过 REST 调 ai-server `api/connectors/**`（带 `X-Product: lightvela` + `Authorization: Bearer` 鉴权）；OAuth 授权用新窗口 + postMessage 感知完成。服务端仅 ai-server catalog 加 `products.lightvela` 配置（跨仓库 MR）。

**Tech Stack:** React 19 + TypeScript、vitest + @testing-library/react、现有 i18n（`t()` + `pnpm i18n:check`）。

**Spec:** `docs/superpowers/specs/2026-09-21-lightvela-connectors-p1-design.md`

## Global Constraints

- 所有用户可见文案走 `t()`，完成后执行 `pnpm i18n:check` 必须通过。
- Token 永不下发浏览器：前端只持有授权状态（状态/时间），不存任何凭据。
- 鉴权头固定两枚：`X-Product: lightvela` + `Authorization: Bearer <token>`（token 复用 `readStoredAuthToken()` 的既有存储键）。
- ai-server 域名通过 `NEXT_PUBLIC_AI_SERVER_BASE_URL` 注入（部署配置项，构建时确认具体值；本地 dev 用 sandbox 值）。
- 日志与错误信息不打印 `code`/`token`/`Authorization`。
- 每个任务完成后跑该任务测试；全部完成后跑 `npx vitest run src/pages/marketing/__tests__/agent-connectors-panel.test.tsx src/lib/__tests__/connectors-client.test.ts`。
- **提交前必须经用户确认**（本协作的铁律）。

## ai-server API 契约（已从源码核实，controller/connectors.controller.ts）

| 端点（POST，除注明） | 入参 | 出参要点 |
|---|---|---|
| `api/connectors/mcp/instance/list` | `{ instanceId }` | `{ items: ConnectorItem[] }`（含 key/name/connectorType/状态） |
| `api/connectors/mcp/builtin/enable` | `{ instanceId, connectorKey }` | 成功 `{status:'ok'...}` 或 `{status:'auth_required', authorizationUrl, flowId}` |
| `api/connectors/oauth/start` | `{ instanceId, connectorKey }` | `{ authorizationUrl, flowId }` |
| GET `api/connectors/oauth/callback` | （OAuth 回调） | HTML：`postMessage({type:'connector.oauth.complete', flowId, connectorKey, status}, origin)` 后自动关窗 |
| `api/connectors/oauth/complete` | `{ instanceId, connectorKey, flowId }` | 授权落库结果 |
| `api/connectors/oauth/cancel` | `{ instanceId, connectorKey, flowId }` | 取消结果 |
| `api/connectors/mcp/builtin/disable` | `{ instanceId, connectorKey }` | 断开结果 |
| `api/connectors/mcp/builtin/retry-delivery` | `{ instanceId, connectorKey }` | 重试下发结果 |

**核心交互流**：点「连接」→ `builtin/enable` → 若 `auth_required` 则 `window.open(authorizationUrl)` → 监听 `message`（校验 origin 为 ai-server 域名）→ 收到 `connector.oauth.complete` 后调 `oauth/complete` → 刷新列表。用户直接可用的连接器（无 OAuth）enable 即成功。

---

### Task 1: connectors API client

**Files:**
- Create: `frontend/src/lib/connectors-client.ts`
- Create: `frontend/src/lib/__tests__/connectors-client.test.ts`
- Modify: `frontend/src/app-env.d.ts`（补 `NEXT_PUBLIC_AI_SERVER_BASE_URL` 声明）

**Interfaces:**
- Produces: `listInstanceConnectors(instanceId)`、`enableBuiltinConnector(instanceId, connectorKey)`、`completeConnectorOAuth(instanceId, connectorKey, flowId)`、`cancelConnectorOAuth(...)`、`disableBuiltinConnector(...)`、`retryConnectorDelivery(...)`、`CONNECTOR_OAUTH_COMPLETE_MESSAGE`（postMessage 事件类型常量）
- 类型：`ConnectorItem { key: string; name: string; connectorType: 'mcp_proxy' | 'local_cli'; status: 'not_connected' | 'connected' | 'expired' | 'failed' | 'auth_required'; authorizedAt?: number; deliveryWarning?: boolean }`、`EnableResult { status: 'ok' | 'auth_required'; authorizationUrl?: string; flowId?: string }`

- [ ] **Step 1: 写失败测试**

```ts
// frontend/src/lib/__tests__/connectors-client.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_OAUTH_COMPLETE_MESSAGE,
  listInstanceConnectors,
  enableBuiltinConnector,
} from "@/lib/connectors-client";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
vi.stubGlobal("localStorage", {
  getItem: (k: string) => (k === "lh_auth_token" ? "tok-123" : null),
  setItem: vi.fn(), removeItem: vi.fn(),
});

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_AI_SERVER_BASE_URL", "https://ai-server.example.com");
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("connectors-client", () => {
  it("listInstanceConnectors 携带 x-product 与 Bearer 头并解析 items", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [{ key: "tencent-meeting", name: "腾讯会议", connectorType: "local_cli", status: "connected" }] }), { status: 200 }),
    );
    const items = await listInstanceConnectors("ins-1");
    expect(items[0]?.key).toBe("tencent-meeting");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["X-Product"]).toBe("lightvela");
    expect(init.headers.Authorization).toBe("Bearer tok-123");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("https://ai-server.example.com/api/connectors/mcp/instance/list");
  });

  it("enableBuiltinConnector 返回 auth_required 时透传 authorizationUrl/flowId", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "auth_required", authorizationUrl: "https://oauth.example.com", flowId: "f-1" }), { status: 200 }),
    );
    const r = await enableBuiltinConnector("ins-1", "tencent-meeting");
    expect(r).toEqual({ status: "auth_required", authorizationUrl: "https://oauth.example.com", flowId: "f-1" });
  });

  it("401 抛出未登录错误（不含 token 明文）", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(listInstanceConnectors("ins-1")).rejects.toThrow("登录已过期");
  });

  it("CONNECTOR_OAUTH_COMPLETE_MESSAGE 事件类型常量稳定", () => {
    expect(CONNECTOR_OAUTH_COMPLETE_MESSAGE).toBe("connector.oauth.complete");
  });
});
```

注：`localStorage` 键若与实际 `readStoredAuthToken` 使用的键不一致，以 `src/pages/auth/wechat-pay-page.tsx` 中 `AUTH_TOKEN_STORAGE_KEY` 的实际值为准（实现时 import 复用，勿新造存储）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/connectors-client.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 client**

```ts
// frontend/src/lib/connectors-client.ts
/** ai-server 连接器 API client。契约：controller/connectors.controller.ts（ai-server 仓库）。 */

export const CONNECTOR_OAUTH_COMPLETE_MESSAGE = "connector.oauth.complete";

export type ConnectorStatus = "not_connected" | "connected" | "expired" | "failed" | "auth_required";
export interface ConnectorItem {
  key: string;
  name: string;
  connectorType: "mcp_proxy" | "local_cli";
  status: ConnectorStatus;
  authorizedAt?: number;
  /** 已授权但下发未完成（实例离线/版本不满足）时为 true */
  deliveryWarning?: boolean;
}
export interface EnableResult {
  status: "ok" | "auth_required";
  authorizationUrl?: string;
  flowId?: string;
}

function aiServerBase(): string {
  const base = (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_AI_SERVER_BASE_URL : "")?.trim();
  if (!base) throw new Error("连接器服务暂不可用，请稍后重试");
  return base.replace(/\/+$/, "");
}

function readStoredAuthToken(): string | null {
  const storage = globalThis.localStorage;
  if (!storage?.getItem) return null;
  const token = storage.getItem("lh_auth_token")?.trim(); // 与 readStoredAuthToken 既有键一致，实现时对齐
  return token || null;
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-Product": "lightvela" };
  const token = readStoredAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${aiServerBase()}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error("登录已过期，请重新登录后再试");
  if (!res.ok) throw new Error(`连接器服务异常（${res.status}）`);
  return (await res.json()) as T;
}

export async function listInstanceConnectors(instanceId: string): Promise<ConnectorItem[]> {
  const data = await post<{ items?: ConnectorItem[] }>("/api/connectors/mcp/instance/list", { instanceId });
  return Array.isArray(data.items) ? data.items : [];
}

export async function enableBuiltinConnector(instanceId: string, connectorKey: string): Promise<EnableResult> {
  return post<EnableResult>("/api/connectors/mcp/builtin/enable", { instanceId, connectorKey });
}

export async function completeConnectorOAuth(instanceId: string, connectorKey: string, flowId: string): Promise<{ ok: boolean }> {
  return post("/api/connectors/oauth/complete", { instanceId, connectorKey, flowId });
}

export async function cancelConnectorOAuth(instanceId: string, connectorKey: string, flowId: string): Promise<void> {
  await post("/api/connectors/oauth/cancel", { instanceId, connectorKey, flowId });
}

export async function disableBuiltinConnector(instanceId: string, connectorKey: string): Promise<void> {
  await post("/api/connectors/mcp/builtin/disable", { instanceId, connectorKey });
}

export async function retryConnectorDelivery(instanceId: string, connectorKey: string): Promise<void> {
  await post("/api/connectors/mcp/builtin/retry-delivery", { instanceId, connectorKey });
}
```

同时在 `frontend/src/app-env.d.ts` 的 `ProcessEnv` 接口补：`readonly NEXT_PUBLIC_AI_SERVER_BASE_URL?: string;`

- [ ] **Step 4: 跑测试通过**

Run: `cd frontend && npx vitest run src/lib/__tests__/connectors-client.test.ts`
Expected: PASS（4 用例）

- [ ] **Step 5: 提交（先经用户确认）**

```bash
git add frontend/src/lib/connectors-client.ts frontend/src/lib/__tests__/connectors-client.test.ts frontend/src/app-env.d.ts
git commit -m "连接器 API client / feat: add ai-server connectors api client"
```

---

### Task 2: 连接器面板（列表渲染 + 状态展示）

**Files:**
- Create: `frontend/src/pages/marketing/agent-connectors-panel.tsx`
- Create: `frontend/src/pages/marketing/__tests__/agent-connectors-panel.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `listInstanceConnectors` / `ConnectorItem`
- Produces: `export function ConnectorsPanel({ instanceId }: { instanceId: string })`（默认导出同名）

- [ ] **Step 1: 写失败测试（列表渲染 + 状态徽标 + 空态）**

```tsx
// frontend/src/pages/marketing/__tests__/agent-connectors-panel.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsPanel } from "@/pages/marketing/agent-connectors-panel";
import * as client from "@/lib/connectors-client";

vi.mock("@/i18n/t", () => ({ t: (s: string) => s }));
vi.mock("@/lib/connectors-client", () => ({
  listInstanceConnectors: vi.fn(),
  enableBuiltinConnector: vi.fn(),
  completeConnectorOAuth: vi.fn(),
  cancelConnectorOAuth: vi.fn(),
  disableBuiltinConnector: vi.fn(),
  retryConnectorDelivery: vi.fn(),
  CONNECTOR_OAUTH_COMPLETE_MESSAGE: "connector.oauth.complete",
}));

beforeEach(() => vi.clearAllMocks());

describe("ConnectorsPanel", () => {
  it("渲染连接器卡片与状态徽标", async () => {
    vi.mocked(client.listInstanceConnectors).mockResolvedValue([
      { key: "tencent-meeting", name: "腾讯会议", connectorType: "local_cli", status: "not_connected" },
      { key: "tencent-docs", name: "腾讯文档", connectorType: "mcp_proxy", status: "connected", authorizedAt: 1_700_000_000_000 },
    ]);
    render(<ConnectorsPanel instanceId="ins-1" />);
    expect(await screen.findByText("腾讯会议")).toBeTruthy();
    expect(screen.getByText("腾讯文档")).toBeTruthy();
    expect(screen.getByRole("button", { name: "连接" })).toBeTruthy();
    expect(screen.getByText("已连接")).toBeTruthy();
  });

  it("下发警告状态显示同步提示", async () => {
    vi.mocked(client.listInstanceConnectors).mockResolvedValue([
      { key: "tencent-meeting", name: "腾讯会议", connectorType: "local_cli", status: "connected", deliveryWarning: true },
    ]);
    render(<ConnectorsPanel instanceId="ins-1" />);
    expect(await screen.findByText(/等待 Agent 在线后同步/)).toBeTruthy();
  });

  it("空列表显示引导文案", async () => {
    vi.mocked(client.listInstanceConnectors).mockResolvedValue([]);
    render(<ConnectorsPanel instanceId="ins-1" />);
    expect(await screen.findByText("暂无可用的连接器")).toBeTruthy();
  });

  it("加载失败显示重试且不抛错", async () => {
    vi.mocked(client.listInstanceConnectors).mockRejectedValue(new Error("登录已过期，请重新登录后再试"));
    render(<ConnectorsPanel instanceId="ins-1" />);
    expect(await screen.findByText(/登录已过期/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(client.listInstanceConnectors).toHaveBeenCalledTimes(2));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/pages/marketing/__tests__/agent-connectors-panel.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现面板骨架**

```tsx
// frontend/src/pages/marketing/agent-connectors-panel.tsx
/**
 * ConnectorsPanel — Agent 设置页「连接器」面板（P1）。
 * 数据与授权全走 ai-server 连接器平台（见 connectors-client.ts 契约注释）。
 * 红线：不持有/缓存任何凭据，只展示授权状态。
 */
import { useCallback, useEffect, useState } from "react";
import { t } from "@/i18n/t";
import { listInstanceConnectors, type ConnectorItem } from "@/lib/connectors-client";

const STATUS_LABELS: Record<string, string> = {
  not_connected: "未连接",
  connected: "已连接",
  expired: "已过期",
  failed: "连接失败",
  auth_required: "待授权",
};

export function ConnectorsPanel({ instanceId }: { instanceId: string }) {
  const [items, setItems] = useState<ConnectorItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setItems(await listInstanceConnectors(instanceId));
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [instanceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <section aria-label={t("连接器")} className="lh-connectors-panel">
      <header>
        <h3>{t("连接器")}</h3>
        <p>{t("连接第三方服务，让你的 Agent 直接调用")}</p>
      </header>
      {error && (
        <div role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void refresh()}>{t("重试")}</button>
        </div>
      )}
      {items === null ? (
        <p aria-busy="true">{t("加载中…")}</p>
      ) : items.length === 0 && !error ? (
        <p>{t("暂无可用的连接器")}</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.key} data-connector-key={item.key}>
              <span>{item.name}</span>
              <span>{item.connectorType === "local_cli" ? "CLI" : "MCP"}</span>
              <span data-status={item.status}>{t(STATUS_LABELS[item.status] ?? item.status)}</span>
              {item.deliveryWarning && <span>{t("已授权，等待 Agent 在线后同步")}</span>}
              {/* 连接/断开操作在 Task 3/4 注入 */}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default ConnectorsPanel;
```

- [ ] **Step 4: 跑测试通过**

Run: `cd frontend && npx vitest run src/pages/marketing/__tests__/agent-connectors-panel.test.tsx`
Expected: PASS（4 用例）

- [ ] **Step 5: 提交（先经用户确认）**

```bash
git add frontend/src/pages/marketing/agent-connectors-panel.tsx frontend/src/pages/marketing/__tests__/agent-connectors-panel.test.tsx
git commit -m "连接器面板骨架与列表渲染 / feat: connectors panel skeleton with list rendering"
```

---

### Task 3: OAuth 连接流程（enable → 新窗口授权 → postMessage → complete）

**Files:**
- Modify: `frontend/src/pages/marketing/agent-connectors-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/agent-connectors-panel.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `enableBuiltinConnector` / `completeConnectorOAuth` / `cancelConnectorOAuth` / `CONNECTOR_OAUTH_COMPLETE_MESSAGE`

- [ ] **Step 1: 追加失败测试（连接按钮触发授权流）**

```tsx
// 追加到 agent-connectors-panel.test.tsx 的 describe 内
it("点连接：auth_required 时打开授权窗口并监听 postMessage 完成", async () => {
  const windowOpen = vi.fn(() => ({ closed: true }) as unknown as Window);
  vi.stubGlobal("open", windowOpen);
  vi.mocked(client.listInstanceConnectors).mockResolvedValue([
    { key: "tencent-meeting", name: "腾讯会议", connectorType: "local_cli", status: "not_connected" },
  ]);
  vi.mocked(client.enableBuiltinConnector).mockResolvedValue({
    status: "auth_required", authorizationUrl: "https://oauth.example.com/auth", flowId: "flow-1",
  });
  vi.mocked(client.completeConnectorOAuth).mockResolvedValue({ ok: true });
  render(<ConnectorsPanel instanceId="ins-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "连接" }));
  await waitFor(() => expect(windowOpen).toHaveBeenCalledWith("https://oauth.example.com/auth", "_blank", "noopener"));
  // 模拟 ai-server 回调页 postMessage
  fireEvent(window, new MessageEvent("message", {
    origin: "https://ai-server.example.com",
    data: { type: "connector.oauth.complete", flowId: "flow-1", connectorKey: "tencent-meeting", status: "ok" },
  }));
  await waitFor(() => expect(client.completeConnectorOAuth).toHaveBeenCalledWith("ins-1", "tencent-meeting", "flow-1"));
  await waitFor(() => expect(client.listInstanceConnectors).toHaveBeenCalledTimes(2));
  vi.unstubAllGlobals();
});

it("点连接：enable 直接成功（无需 OAuth）时仅刷新列表", async () => {
  vi.mocked(client.listInstanceConnectors).mockResolvedValue([
    { key: "x", name: "X", connectorType: "mcp_proxy", status: "not_connected" },
  ]);
  vi.mocked(client.enableBuiltinConnector).mockResolvedValue({ status: "ok" });
  render(<ConnectorsPanel instanceId="ins-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "连接" }));
  await waitFor(() => expect(client.listInstanceConnectors).toHaveBeenCalledTimes(2));
  expect(client.completeConnectorOAuth).not.toHaveBeenCalled();
});

it("postMessage origin 不匹配时忽略（安全）", async () => {
  vi.mocked(client.listInstanceConnectors).mockResolvedValue([
    { key: "tencent-meeting", name: "腾讯会议", connectorType: "local_cli", status: "not_connected" },
  ]);
  vi.mocked(client.enableBuiltinConnector).mockResolvedValue({
    status: "auth_required", authorizationUrl: "https://oauth.example.com/auth", flowId: "flow-9",
  });
  vi.stubGlobal("open", vi.fn(() => ({}) as unknown as Window));
  render(<ConnectorsPanel instanceId="ins-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "连接" }));
  fireEvent(window, new MessageEvent("message", {
    origin: "https://evil.example.com", // 非法来源
    data: { type: "connector.oauth.complete", flowId: "flow-9", connectorKey: "tencent-meeting" },
  }));
  await new Promise((r) => setTimeout(r, 20));
  expect(client.completeConnectorOAuth).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/pages/marketing/__tests__/agent-connectors-panel.test.tsx`
Expected: FAIL（连接按钮不存在）

- [ ] **Step 3: 实现连接流程**

在 `agent-connectors-panel.tsx` 中：
1. 新增 `connect(item)` 处理器：调 `enableBuiltinConnector`；`status==='auth_required'` 时 `window.open(authorizationUrl, "_blank", "noopener")` 并记录 `{flowId, connectorKey}` 到 state（pendingFlow）。
2. 新增 `useEffect` 监听 `window` 的 `message` 事件：**必须校验 `event.origin` 等于 `NEXT_PUBLIC_AI_SERVER_BASE_URL` 的 origin**，且 `event.data?.type === CONNECTOR_OAUTH_COMPLETE_MESSAGE`、`flowId` 与 pendingFlow 匹配；命中后调 `completeConnectorOAuth` 并 `refresh()`；未命中一律忽略。
3. 组件卸载时移除监听；面板卸载时若有 pendingFlow 调 `cancelConnectorOAuth`（用户没完成授权就离开）。
4. 卡片 `not_connected` 状态渲染 `<button onClick={() => connect(item)}>{t("连接")}</button>`；`expired` 渲染「重新连接」。

- [ ] **Step 4: 跑测试通过**

Run: `cd frontend && npx vitest run src/pages/marketing/__tests__/agent-connectors-panel.test.tsx`
Expected: PASS（7 用例）

- [ ] **Step 5: 提交（先经用户确认）**

```bash
git add frontend/src/pages/marketing/agent-connectors-panel.tsx frontend/src/pages/marketing/__tests__/agent-connectors-panel.test.tsx
git commit -m "连接器 OAuth 授权流 / feat: connectors oauth flow with postMessage handshake"
```

---

### Task 4: 断开 / 重试下发

**Files:**
- Modify: `frontend/src/pages/marketing/agent-connectors-panel.tsx`
- Modify: `frontend/src/pages/marketing/__tests__/agent-connectors-panel.test.tsx`

- [ ] **Step 1: 追加失败测试**

```tsx
it("已连接卡片：断开需确认弹窗后调用 disable", async () => {
  vi.mocked(client.listInstanceConnectors).mockResolvedValue([
    { key: "tencent-meeting", name: "腾讯会议", connectorType: "local_cli", status: "connected" },
  ]);
  vi.mocked(client.disableBuiltinConnector).mockResolvedValue(undefined);
  render(<ConnectorsPanel instanceId="ins-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "断开" }));
  fireEvent.click(screen.getByRole("button", { name: "确认断开" })); // 确认弹窗
  await waitFor(() => expect(client.disableBuiltinConnector).toHaveBeenCalledWith("ins-1", "tencent-meeting"));
  await waitFor(() => expect(client.listInstanceConnectors).toHaveBeenCalledTimes(2));
});

it("下发警告卡片：显示重试下发按钮并调用 retry", async () => {
  vi.mocked(client.listInstanceConnectors).mockResolvedValue([
    { key: "tencent-meeting", name: "腾讯会议", connectorType: "local_cli", status: "connected", deliveryWarning: true },
  ]);
  vi.mocked(client.retryConnectorDelivery).mockResolvedValue(undefined);
  render(<ConnectorsPanel instanceId="ins-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "重试同步" }));
  await waitFor(() => expect(client.retryConnectorDelivery).toHaveBeenCalledWith("ins-1", "tencent-meeting"));
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现**：`connected` 卡片渲染「断开」按钮 → 点击弹确认层（复用面板内联 dialog，避免引新依赖）→ 确认后 `disableBuiltinConnector` + `refresh()`；`deliveryWarning` 卡片渲染「重试同步」按钮 → `retryConnectorDelivery` + `refresh()`；`failed` 渲染「重新连接」（同 expired 路径）。

- [ ] **Step 4: 跑测试通过** → PASS（9 用例）

- [ ] **Step 5: 提交（先经用户确认）**

```bash
git add -A frontend/src/pages/marketing/agent-connectors-panel.tsx frontend/src/pages/marketing/__tests__/agent-connectors-panel.test.tsx
git commit -m "连接器断开与重试下发 / feat: connectors disconnect and delivery retry"
```

---

### Task 5: 挂载到 Agent 设置页 + i18n

**Files:**
- Modify: `frontend/src/pages/marketing/agent-settings-page.tsx`（lazy import + 挂载，位置对齐 ChannelPanel 的模式，位于消息渠道面板之后）
- Modify: `frontend/src/i18n/generated/zh-CN.json` 等（按 `pnpm i18n:check` 报出的缺失键逐个补齐，中英同补）

**Interfaces:**
- Consumes: Task 2 的 `ConnectorsPanel({ instanceId })`；instanceId 取设置页现有的实例标识（对齐 ChannelPanel 取参方式，实现时从页面 props/context 取实际字段名）

- [ ] **Step 1: 挂载组件**

在 `agent-settings-page.tsx` 顶部 lazy 区（`AgentChannelPanel` 定义后）追加：

```tsx
const AgentConnectorsPanel = lazy(() =>
  import("@/pages/marketing/agent-connectors-panel").then((module) => ({ default: module.ConnectorsPanel })),
);
```

在 ChannelPanel 渲染位置之后追加（instanceId 以该文件实际变量名为准）：

```tsx
<Suspense fallback={null}>
  <AgentConnectorsPanel instanceId={instanceId} />
</Suspense>
```

- [ ] **Step 2: i18n 补齐**

Run: `cd frontend && pnpm i18n:check`
按报错把新增文案键补入全部 locale 文件（连接器/连接/断开/确认断开/重试/重试同步/已连接/未连接/已过期/连接失败/待授权/暂无可用的连接器/连接第三方服务，让你的 Agent 直接调用/已授权，等待 Agent 在线后同步/加载中…/登录已过期，请重新登录后再试/连接器服务异常/连接器服务暂不可用，请稍后重试）。
Expected: `pnpm i18n:check` 通过。

- [ ] **Step 3: 全量回归**

Run: `cd frontend && npx vitest run src/pages/marketing/__tests__/agent-connectors-panel.test.tsx src/lib/__tests__/connectors-client.test.ts && npx tsc --noEmit -p tsconfig.app.json`
Expected: 全 PASS、无类型错误。

- [ ] **Step 4: 提交（先经用户确认）**

```bash
git add frontend/src/pages/marketing/agent-settings-page.tsx frontend/src/i18n/
git commit -m "挂载连接器面板并补齐多语言 / feat: mount connectors panel with i18n"
```

---

### Task 6: ai-server 配置 MR（跨仓库，协调任务）

**仓库:** `lightcloud-fe/ai/ai-server`（非本仓库，向该团队提 MR）

- [ ] **Step 1:** 在 ai-server 部署配置的 `connectors.catalog['tencent-meeting'].products` 下新增 `lightvela: {}`。
- [ ] **Step 2:** 更新 `test/connectors-product-registry.test.js`：`getBuiltinConnectors(config, 'lightvela')` 断言从 `[]` 改为含 `tencent-meeting`。
- [ ] **Step 3:** 与 ai-server 团队确认：OAuth `redirect_uri` 是否需登记 lightvela.com 域名；`pnpm test -- connectors-product-registry` 通过后合入。
- [ ] **Step 4:** 部署配置注入 `NEXT_PUBLIC_AI_SERVER_BASE_URL`（mono2 前端的 Dockerfile/构建链，参照 `NEXT_PUBLIC_AUTH_API_BASE_URL` 模式，双站均需）。

---

### Task 7: E2E 手动验收（依赖 Task 1-6 完成）

- [ ] 国内站 lightvela.com 打开 Agent 设置页 → 连接器面板显示「腾讯会议」卡片。
- [ ] 点「连接」→ 腾讯云 OAuth 授权页 → 完成授权 → 窗口自动关闭 → 面板状态变「已连接」。
- [ ] 云端虾对话「帮我创建一个腾讯会议」→ 创建成功（tmeet CLI 调用）。
- [ ] 点「断开」→ 确认 → 状态回「未连接」；虾再调用失败且提示合理。
- [ ] 授权后实例离线场景：面板显示「已授权，等待 Agent 在线后同步」；实例上线后状态收敛。
- [ ] agentchat 侧回归：腾讯会议连接器在 agentchat 产品行为不变（产品隔离验证）。

---

## Self-Review 结论

- Spec 覆盖：§4 前端设计→Task 1-5；§5 ai-server 变更→Task 6；§8 验收→Task 7 + 各任务测试；§7 错误处理→Task 2（重试/空态）、Task 3（origin 校验/取消）、Task 4（下发警告/重试）。无遗漏。
- 占位符：Task 5 的 instanceId 变量名、Task 1 的 localStorage 键名标注了「以实际代码为准」的对齐指令——这是对既有代码的复用指示而非待定设计，实现时必须先读对齐，不得新造。
- 类型一致性：`ConnectorItem`/`EnableResult`/各函数签名在 Task 1 定义、Task 2-4 消费，已核对一致。
