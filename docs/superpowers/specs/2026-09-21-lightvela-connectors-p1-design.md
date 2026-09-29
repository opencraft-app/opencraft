# LightVela 连接器能力 · 第一期设计（P1）

日期：2026-09-21
状态：设计已确认，待实现计划
输入文档：`连接器文档.md`（方案调研与 OAuth 架构）、`新连接器上架指引.md`（ai-server 连接器上架 SOP）

## 1. 背景与目标

LightVela 需要连接器能力，让用户的云端 Agent 能调用第三方服务。方案分两层：

- **应用层**：第三方服务的 MCP / CLI 连接器，多业务团队共同建设、相互复用。
- **权限层**：OAuth 鉴权由平台统一承载（AgentChat 已建设的 ai-server 连接器平台），各产品复用。

一期目标：

1. **尽快让 LightVela 用上连接器**——完整闭环（面板 → 授权 → 实例下发 → Agent 调用）。
2. **为共建打样**——跑通第一个连接器的全生命周期，沉淀后续 Google 生态与共建规范的经验。

## 2. 调研结论（设计依据）

对 ai-server（`lightcloud-fe/ai/ai-server`，master）与 AgentChat-web 的代码调研结论：

| 检查项 | 状态 | 证据 |
|---|---|---|
| 连接器平台（注册表 / OAuth / 下发 / 审计） | 已建成且成熟 | `service/connectors/`（connectorsRegistry / connectorsOAuth / connectorsInstall / connectorsInstanceQuery），专项与回归测试齐全 |
| 产品枚举含 lightvela | 是 | `connectorsShared.ts: ConnectorProduct = 'agentchat' | 'clawpro' | 'lightvela'` |
| LightVela 身份鉴权对接 | 已预留 | `lightVelaOauthRequest.helper.ts`、`checkLogin.middleware.ts` 支持 `x-product: lightvela` |
| 实例下发链路 | 已建成 | OpenClaw/Hermes 双路径（native 兼容 + plugin 正式），`connectorOwnershipProof` 支持 lightvela |
| 前端连接器中心（AgentChat-web） | 已存在 | `src/components/connectors/ConnectorCenter.tsx` |
| **对 lightvela 开放的连接器** | **零** | `connectors-product-registry.test.js` 断言 `getBuiltinConnectors(config, 'lightvela') === []` |
| 腾讯会议连接器 | 已存在（agentchat 在用） | `tencent-meeting`：`local_cli` 型，binary=`tmeet`，`authType: tencent_cloud_oauth` |
| 腾讯文档连接器 | 已存在（agentchat/clawpro 在用） | `tencent-docs`：`mcp_proxy` 型，application=`tencent-docs-agentchat` |

**核心结论**：复用 ai-server 权限层不是方案选择而是既成事实；一期的主要开发工作在 LightVela 前端面板，服务端仅一处配置变更。

## 3. 一期方案

### 3.1 架构总览

```
用户在 LightVela 网页
    │
    ▼ /agents/{id} → 连接器 panel（新开发）
    │  列表来自 ai-server connector 查询接口（x-product: lightvela）
    │
    ├─ 未授权 → 点「连接」→ ai-server OAuth prepare → 跳腾讯云 OAuth 授权页
    │                                    → 回调 ai-server → 授权记录落库
    │
    ├─ 已授权 → 面板显示「已连接」；ai-server 通用 TAT 下发到该用户的云端虾实例
    │           （OpenClaw ≥1.2.19 / Hermes ≥0.0.19 走 plugin 正式路径，低版本 native 兼容路径）
    │
    └─ Agent 在对话中调用 tmeet CLI（腾讯会议 local_cli 型连接器）
```

### 3.2 面板位置决策（已选定的方案）

Agent 详情页（`/agents/{id}`）新增「连接器」panel，与消息渠道 / 定时任务同级。理由：连接器的最终消费者是虾实例，用户心智中「给这只虾装能力」的位置就是 Agent 详情页。

已否决的备选：账号设置页（授权与生效位置割裂、账号页已过重）、独立 /connectors 页（一期过重、入口深）。

### 3.3 一期范围边界（明确不做）

- 不做 MCP Gateway 代连（长期演进方向，见 `连接器文档.md` §4.2）。
- 不做连接器市场独立页面。
- 不做 Google 生态（二期首批新连接器）。
- 不修改 OpenClaw / Hermes runtime（下发走平台通用 TAT）。
- 不引入 WebSocket 授权状态推送（一期用刷新/轻量轮询）。

## 4. 前端设计（mono2/frontend）

### 4.1 组件

```
src/pages/marketing/agent-connectors-panel.tsx
src/pages/marketing/__tests__/agent-connectors-panel.test.tsx
```

挂载到 Agent 详情页，对标 `agent-channel-panel` / `agent-automations-panel` 的既有 panel 模式。

### 4.2 面板结构

```
连接器
├── 顶部说明：「连接第三方服务，让你的 Agent 直接调用」
├── 连接器卡片列表（来自 connector 查询接口）
│   ├── 图标 + 名称 + 简介 + 类型标签（MCP / CLI）
│   ├── 状态：未连接 / 已连接（含授权时间）/ 已过期 / 连接失败
│   └── 操作：连接 / 断开（revoke，需确认弹窗）/ 重新连接
└── 空态：按 products 过滤后为空时展示引导文案
```

### 4.3 ai-server 接口对接（3 类，均已存在）

| 前端动作 | 接口 | 说明 |
|---|---|---|
| 拉取连接器列表+状态 | connector 查询（connectorsInstanceQuery 服务） | 请求带 `x-product: lightvela`，鉴权走 lightvela token（`lightVelaOauthRequest.helper` 预留链路） |
| 发起授权 | OAuth prepare → `authorizationUrl` → 新窗口打开 | 授权回跳 ai-server 成功页，引导用户回到 LightVela |
| 断开/重连 | revoke / 重新 prepare | 复用平台授权生命周期 |

授权完成的感知：用户从授权页切回后，面板刷新授权状态（轻量轮询兜底），不引入 WebSocket。

### 4.4 国际化与站点

- 所有用户可见文案走 `t()`，执行 `pnpm i18n:check`（上架指引要求）。
- 国内站（lightvela.com）与国际站（lightvela.ai）共用同一面板；连接器可见性由 ai-server 按 `products.lightvela` 与区域配置过滤。Google 生态上线后天然只在国际站可见，同一机制。

## 5. ai-server 侧变更（唯一服务端改动）

### 5.1 catalog 配置

```yaml
connectors:
  catalog:
    tencent-meeting:
      name: 腾讯会议
      connectorType: local_cli
      authType: tencent_cloud_oauth
      products:
        agentchat: { ... }   # 已有
        lightvela: {}         # 新增（local_cli + tencent_cloud_oauth 型无需独立 application 绑定）
```

### 5.2 跨团队协调事项

| 事项 | 说明 |
|---|---|
| `products.lightvela` 配置合入 | 向 ai-server 提 MR，跑 `connectors-product-registry` 测试 |
| 测试断言更新 | `getBuiltinConnectors(config, 'lightvela')` 从断言 `[]` 改为 `[tencent-meeting]` |
| OAuth 回调域名 | 腾讯云 OAuth 的 redirect_uri 如需登记 lightvela.com 域名，在应用注册侧办理 |

### 5.3 后续标准 OAuth 连接器的差异（Google 二期适用）

标准 OAuth 连接器需按 `products.lightvela: { application: 'xxx-lightvela' }` 绑定独立应用（clientId/clientSecret/authorizeUrl/tokenUrl）。tencent_cloud_oauth 型复用腾讯云统一身份，无此要求。

## 6. 安全边界（前端必须遵守）

- Token 只在 ai-server 服务端解密使用，不下发到浏览器；前端只持有授权状态（时间/scope 展示）。
- 授权查询校验五元组（产品 / 当前用户 / userAuthId / connectorKey / 授权状态），前端不做绕过。
- 日志不打印 `code` / `token` / `client_secret` / Authorization 头。
- 前端不缓存任何授权凭据。

## 7. 错误处理与降级

| 场景 | 处理 |
|---|---|
| ai-server 不可达 | 面板显示重试入口，不阻塞 Agent 详情页其他 tab |
| 授权回跳失败（取消/超时） | 回到面板显示「未连接」，可重新发起 |
| 授权过期 | 状态「已过期」+「重新连接」 |
| 下发失败（实例离线/版本不满足） | 授权成功但面板显示 warning「已授权，等待 Agent 在线后同步」（复用平台 check-local 状态语义） |
| 实例版本未知/非法 | 平台不下发，面板透传该状态 |

## 8. 测试与验收

### 前端（mono2）

- `agent-connectors-panel.test.tsx`：列表渲染与 products 过滤、状态徽标、连接按钮触发 prepare、revoke 确认弹窗、空态、i18n。
- API 层：`x-product: lightvela` 头注入、401 处理。

### ai-server（配合团队）

- `connectors-product-registry` 断言更新。
- 按上架指引第六节全量验收：产品隔离（双向）、授权生命周期（新授权/取消/过期/重授权）、用户隔离、双 runtime 下发与调用。

### 端到端（真机）

- 国内站授权腾讯会议 → 云端虾对话「帮我创建一个会议」→ tmeet 创建成功。
- 断开授权后调用失败且提示合理。

## 9. 二期规划

### 9.1 Google 生态（新连接器批量生产）

- 按《上架指引》在 `thirdApplications/google-*/` 开发，`authType: oauth` + 独立 application 绑定。
- 候选：Gmail / Calendar / Drive / Docs（按业务优先级）。
- 国际站专属（products 仅 lightvela + 区域过滤，天然不出现在国内站）。

### 9.2 共建机制（目标 D 的落地形态）

- 载体：ai-server `connectors.catalog` 即共同维护的连接器列表；《上架指引》即贡献 SOP。
- 一期跑通后补充：连接器贡献模板（代码骨架 + 测试清单 + 验收记录）、多产品复用指引。
- 不引入新的包管理基础设施（catalog 即列表，避免过度设计）。

### 9.3 长期演进锚点（不在本期承诺）

- MCP Gateway 代连（`连接器文档.md` §4.2）。
- 对话窗口内快捷连接入口（对齐 AgentChat 交互）。
