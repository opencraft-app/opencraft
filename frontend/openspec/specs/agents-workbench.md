# Agent 桌面宿主 (Agents Workbench)

## 概述

Agents Workbench 是 Lightclaw 的产品级 Vela 入口，负责在 `/agents/workbench` 下加载 mono2 bot 列表、自动注入并启动 VM `velad`、构建 TAT 端口转发传输、并挂载 web 嵌入式工作台（本地 session rail + Vela SessionListSurface + ChatSurface）。

## 页面 / 路由

- 路由：`/agents/workbench`
- 入口页面：`pages/marketing/agents-workbench/AgentsWorkbenchPage.tsx`

## 核心组件

| 组件 / 文件 | 职责 |
|-------------|------|
| `AgentsWorkbenchPage.tsx` | 工作台页面入口（Next App Router 页面） |
| `VelaWorkbenchDesktopHost.tsx` | Vela 桌面宿主组件 |
| `host-state.ts` | 宿主状态管理 |
| `velad-endpoint.ts` | Velad 端点定义与解析 |
| `velad-release.ts` | Velad 版本发行管理 |
| `velad-transport.ts` | Velad 传输层（TAT 端口转发） |

## 数据流

1. **加载 bot 列表**：通过 `repositories.bots` 加载 mono2 bot 列表，选取承载 `velad` 的 VM。
2. **启动 VM velad**：在打开 TAT 传输前，通过 `debug/exec` 自动注入并启动 VM `velad`。
3. **构建传输**：通过 TAT 端口转发构建 mono2 专属 `velad` 传输。
4. **挂载工作台**：web 嵌入式，含本地 session rail + Vela `SessionListSurface` 和 `ChatSurface`。

## 业务规则（Non-goals）

- **不导入** Electron 桌面应用 shell 或其全局样式到本 Next 页面。
- **不重新实现** Vela chat 渲染。
- **不导入** velalink 的 demo proxy 路径作为 mono2 endpoint。

## 测试覆盖

- `__tests__/velad-endpoint.test.ts` — velad 端点解析
- `__tests__/workbench-desktop-shell-boundary.test.ts`（11KB）— 桌面 shell 边界

## 待用户补充

- velad 版本检查 / 升级提示 / 兼容性策略
- 国内 / 国际站差异（桌面端是否双站都支持）
- 与后端服务（ai-gateway / service-gateway）的协作关系
- 鉴权与自动重连策略
