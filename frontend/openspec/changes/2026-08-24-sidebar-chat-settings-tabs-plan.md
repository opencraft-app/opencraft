# 侧边栏「对话/设置」双 Tab 改造 plan (v2)

> 分支：`feature/sidebar-chat-settings-tabs`（基于 master `2920f25e5`）
> 日期：2026-08-24
> 状态：待 review

## 一、需求（已确认）

1. 侧边栏**最顶部**（在 Agent profile 之上）加「对话」「设置」两个 tab（分段控制器）
2. 「设置」tab：保留当前所有菜单，**移除「对话」菜单项**（对话入口由 tab 承担）
3. 「对话」tab：「最近会话」分组，**接入真实数据**（从升级后的 SDK 拉取历史会话列表）
4. **tab 只影响侧边栏内容**，右侧主区域按当前路由走
5. 升级 `@tencent/agentchat-lightvela-panel` 到 `1.4.0-beta.0`（SDK 支持多 session）

## 二、现状（关键代码位置）

| 内容 | 位置 |
|---|---|
| 侧边栏 `<aside class="lv-agents-sidebar">` | `agent-settings-page.tsx:4855` |
| Agent profile 块 | `agent-settings-page.tsx:4856-5058` |
| 导航 `<nav class="lv-agents-nav">` | `agent-settings-page.tsx:5060` |
| settingsGroups 四分组 | `agent-settings-page.tsx:4787-4827` |
| 「对话」菜单项（`SHOW_AGENTCHAT_ENTRY` 门控） | `agent-settings-page.tsx:4801-4803` |
| `SHOW_AGENTCHAT_ENTRY` 常量（仅 1 处引用） | `agent-settings-page.tsx:519` |
| 反馈链接 | `agent-settings-page.tsx:5142-5152` |
| Chat 入口面板 | `agent-chat-panel.tsx` (lazy 加载) |
| Chat 主区渲染（保持不动） | `agent-settings-page.tsx:5222` → AgentChatPanel |
| 菜单 ID/路径映射 | `src/lib/agent-routes.ts:50-65` |
| 侧边栏样式 | `src/styles.css` |
| i18n 词条 | `src/i18n/generated/{zh-CN,en-US,id-ID,zh-Hant,zh-to-key}.json` |
| SDK 当前版本 | `@tencent/agentchat-lightvela-panel@1.2.6`（types 只暴露 `LightVelaPanel` 高阶组件） |
| SDK 目标版本 | `1.4.0-beta.0`（同步升 `@tencent/agentchat-claw-{components,hooks,panel}` 与 `agentchat-i18n`） |

## 三、改动方案

### 1. SDK 升级（package.json + pnpm-lock）

- `frontend/package.json:48`：`"@tencent/agentchat-lightvela-panel": "1.2.6"` → `"1.4.0-beta.0"`
- 其余子依赖（`@tencent/agentchat-claw-{components,hooks,panel}` 与 `@tencent/agentchat-i18n`）由 1.4.0-beta.0 反向传递升到对应 beta 版
- `pnpm install` 重生 lock
- **风险**：beta 版 API 可能与 1.2.6 既有调用方式不兼容；升级后必须跑 vitest 验证 `agent-chat-panel.tsx` 不挂

### 2. Tab 状态（agent-settings-page.tsx）

```tsx
const [sidebarTab, setSidebarTab] = useState<'chat' | 'settings'>(
  activeSection === 'chat' ? 'chat' : 'settings',
);
```

- 纯本地 state，刷新回到路由推导的初始值，不做持久化
- 仅切侧边栏内容，不动路由

### 3. Tab 条 UI（aside 最顶部、Agent profile 之上）

- 两个 `<button role="tab" aria-selected>`：「对话」「设置」
- 视觉对齐截图（分段控制器，浅灰底圆角，选中项白底）
- 新增 CSS（`src/styles.css`）：
  - `.lv-agents-sidebar-tabs`、`.lv-agents-sidebar-tab`、`.lv-agents-sidebar-tab.is-active`

### 4. 「设置」tab 内容

- 现有 nav 原样保留：Agent profile + 隐藏工具组 + settingsGroups + 反馈链接
- 唯一变化：**删除「使用」组中的对话菜单项**（`4801-4803` 的条件块）
- `SHOW_AGENTCHAT_ENTRY` 常量一并删除（已确认仅 1 处引用）
- chat 主区渲染（`5222`）与路由**完全不动**；点击「默认会话」仍可进入

### 5. 「对话」tab 内容（**核心新功能**）

#### 5.1 数据来源（实施时已确认）

SDK 1.4.0-beta.0 的多会话 API 为**受控桥接**模式（`LightVelaPanelProps.multiSession`）：
- 宿主传 `selectedChatId` + 三个回调：`onSessionStateChange`（回传 `sessions/loading`）、`onSelectedChatIdChange`（SDK 创建会话/兜底切换时同步宿主）、`onSessionActionsChange`（回传 `renameSession` 动作句柄）
- 会话结构 `LightVelaSession`：`{ chatId, title, titleLocked?, createdAt?, updatedAt?, pinned? }`
- SDK 不渲染会话列表，宿主（侧边栏）负责渲染——与本期设计完全匹配

#### 5.2 渲染结构

```
最近会话（分组 label）
├─ [会话 1]   ⋯（重命名）  ← active 态高亮
├─ [会话 2]   ⋯
├─ …
（空态：渲染「默认对话」可点入口）
```

- 列表项点击 → 主区切到对应 session（路由 + 状态双管齐下，具体方式按 SDK API 定）
- 选中态：当前 session id 高亮（按 SDK 实际 API 定）
- 三点菜单：**仅「重命名」**（Why-NOT 删除：SDK 1.4.0-beta.0 的 `LightVelaSessionActions` 只导出 `renameSession`，无删除 API；不绕过 SDK 用 acli 脚本自行删除，避免与 SDK 会话状态不一致。待 SDK 后续版本提供删除 API 后补齐）
- **新建会话入口在对话 SDK 面板内**（不在侧边栏；侧边栏不渲染「新建会话」项）
- 加载态：骨架屏（与现有风格一致）
- 空态：渲染「默认对话」可点列表项（跳 `/agents/chat`，行为对齐原「对话」菜单项，保证 SDK 未回传会话前也有入口）
- 错误态：toast 提示 + 重试按钮
- **tab 点击联动主区**：点「设置」回到前一个设置菜单（无记忆默认「通道」）；点「对话」进入 chat 页并默认选中第一个会话

#### 5.3 性能

- 列表虚拟滚动（如 >20 项）— 现有侧边栏没有虚拟滚动，先按 50 项硬限，超过 50 提示「分页/搜索」，避免引入新依赖

#### 5.4 SDK 对接注意事项核验清单（2026-08-26，SDK 开发者给出）

| # | 注意事项 | 核验结论 |
|---|---|---|
| 1 | 判断会话有效用 `chatId == null`，**勿用真值判断**（`chatId === ""` 是合法默认会话） | ✅ 已合规：全部 `== null` / `===` 比较，无 `if (chatId)` |
| 2 | `onSelectedChatIdChange` 收到值必须写回 `selectedChatId` | ✅ 已合规：回调内 `setSelectedChatId(chatId)` |
| 3 | 切换 Agent/实例时会话列表与选中值需按 instanceId 分开保存或重置 | ✅ 已补：`useEffect` 监听 `sdkInstance?.InstanceId` 变化，清空 sessions/loading/selectedChatId/actions/重命名与菜单态；SDK 会按新实例重新下发默认会话 |
| 4 | 面板右上角已有新建会话按钮，第一期宿主无需调用新建接口 | ✅ 已合规：侧边栏无新建入口 |
| 5 | 删除会话暂未开放为宿主公共动作 | ✅ 已合规：三点菜单仅「重命名」 |
| 6 | 首条消息后 SDK 自动更新默认标题，经 `onSessionStateChange` 下发 | ✅ 已兼容：列表直接渲染 `session.title`，自动反映 |
| 7 | 会话列表请求超 5s SDK 返回当前列表并结束 loading；一直为空需查实例 Hermes 插件是否支持会话协议 | ✅ 已兼容：loading 结束+空列表走「默认对话」兜底入口。**排障指引**：若会话列表持续为空，检查实例 Hermes 插件版本是否支持会话协议（SDK 侧 5s 超时机制） |

### 6. i18n 新词条

| zh-CN | en-US | id-ID | zh-Hant |
|---|---|---|---|
| 对话 | Chats | Obrolan | 對話 |
| 设置 | Settings | Pengaturan | 設置 |
| 最近会话 | Recent | Terbaru | 最近會話 |
| 新建会话 | New chat | Obrolan baru | 新建會話 |
| 重命名 | Rename | Ganti nama | 重新命名 |
| 删除 | Delete | Hapus | 刪除 |
| 加载失败 | Failed to load | Gagal memuat | 載入失敗 |
| 重试 | Retry | Coba lagi | 重試 |

### 7. 测试

- **新增** `agent-settings-sidebar-tabs.test.tsx`：tab 切换、设置 tab 不含对话项、对话 tab 拉取/渲染会话、三点菜单、重命名/删除 action 触发
- **更新** `agent-settings-nav-order.test.ts`：删除对话项后需同步更新顺序断言
- **回归** 跑全部 marketing tests + 现有 `agent-channel-*.test.ts`，确保 SDK 升级不破坏

### 8. 明确不做（边界）

- 不动 AgentChatPanel 内部 / chat 路由 / 主区渲染逻辑
- 不做搜索/筛选会话、文件夹、会话分组
- 不做会话导出
