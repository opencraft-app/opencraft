# Agents 加载体验统一设计

## 范围

本设计针对 `/agents/*` 页面、`frontend/src/components/agents` 和必要的 `frontend/src/components/ui` 基础组件。浏览器、终端、Workbench、支付、账务、Agent 生命周期和后端请求边界不在本次范围内。

实现进度：共享 `Spinner`、`Skeleton`、`AgentPageLoadingState` 已落地；Buddy、自动化、模型配置、通道、通用设置、记忆、Skills、Experts、文件、DeepSeek Harness 和工作台首屏在主数据未就绪时统一渲染居中页面状态。诊断页没有首屏异步主数据请求，保留静态控制台并仅在执行诊断时显示局部状态；会话列表属于侧栏导航，保留行级 Skeleton。浏览器、终端、Workbench 工具页和成就页仍不在本轮范围内。

当前代码中存在三类加载实现：`AgentState` 的状态面板、`ui/state-panel.tsx` 的通用状态卡片，以及页面内直接组合 `Loader2`、`animate-spin`、`animate-pulse` 的局部实现。请求、取消、重试和数据生命周期已由 controller、Context 或页面持有，本设计只统一展示契约。

## 目标

1. 首次加载保留真实内容几何，减少空白和高度跳变。
2. 刷新、提交、追加、流式输出等状态拥有不同的视觉反馈。
3. 加载结束、空数据和错误状态不互相伪装。
4. 所有加载反馈具备可访问语义和可翻译文案。
5. 基础组件不读取业务状态，Agents 视图不执行请求。

## 视觉和交互契约

### 基础原语

- `Spinner`：12 / 14 / 16 / 20px，使用次级文字色，图标默认 `aria-hidden`；调用端通过邻近文案提供可读状态。
- `Skeleton`：使用 `var(--surface-muted)`、`rounded-sm` 和真实内容尺寸；不使用渐变扫光；`motion-safe` 才允许轻微 pulse，`prefers-reduced-motion` 下停止动画。
- `LoadingState`：负责标题、说明、状态角色和可选 action；不发请求、不自动重试。
- `AgentPageLoadingState`：用于具体页面首屏数据未就绪的全内容状态；在页面内容区域居中显示 Spinner 和标题，不渲染未完成的局部卡片。
- `LoadingOverlay`：只覆盖需要暂时阻塞的既有内容，保留布局和标题；不用于首次空白页面。
- `Progress`：继续承载已知百分比的上传、安装和同步任务；未知进度不伪造百分比。

### 状态语义

```ts
type LoadingMode =
  | "initial"
  | "refreshing"
  | "submitting"
  | "loading-more"
  | "streaming";
```

- `initial`：无可用数据时显示结构化 Skeleton。
- `refreshing`：保留已有数据，只在触发器或内容顶部显示 Spinner。
- `submitting`：保留 Dialog 或表单，按钮显示 Spinner、`aria-busy="true"` 并暂时禁用重复动作。
- `loading-more`：保留已有列表，在列表尾部追加占位或 Spinner。
- `streaming`：保留历史内容，在消息尾部或输入区附近显示轻量进行中状态。
- 错误优先保留仍可使用的旧数据；空状态只在请求完成且结果为空时出现。

### 可访问性

- 初始状态容器使用 `role="status"`、`aria-busy="true"` 和简短可翻译文案。
- 错误使用 `role="alert"`；重试 action 位于错误附近。
- 已有内容刷新时只更新局部状态，避免重复播报整页内容。
- Skeleton 和装饰 Spinner 使用 `aria-hidden="true"`，不得隐藏唯一的状态文案。
- 所有操作按钮保持原有焦点、禁用和回焦行为。

### 页面首屏文案

页面级加载状态使用具体内容对象，避免只显示泛化的“加载中”：

| 页面 | 文案 |
| --- | --- |
| 通道 | 正在读取通道 |
| 模型 | 正在读取模型 |
| 技能 | 正在读取技能 |
| 定时任务 | 正在读取定时任务 |
| 人设 | 正在读取人设 |
| 记忆 | 正在读取记忆 |
| 云存储 | 正在加载云存储 |
| 诊断中心 | 正在加载诊断中心 |
| 高级设置 | 正在加载高级设置 |
| 工作台 | 正在加载工作台 |
| DeepSeek Harness | 正在加载 DeepSeek Harness |

## 页面组合

| 场景 | 组合方式 | 重点页面 |
| --- | --- | --- |
| Agent 壳体首次启动 | 顶部 Agent、侧栏导航、底部账户和内容区结构化 Skeleton | `agent-settings-loading-view.tsx` |
| 列表首次加载 | 页面主数据未就绪时居中页面状态；已有快照刷新保留内容 | automations、memory、skills、experts、channels、files |
| 重新获取 | 保留列表，刷新按钮内 Spinner | memory、automations、common settings |
| 保存/删除/安装 | 原按钮内 Spinner，固定按钮尺寸 | model config、common settings、skills、persona |
| 追加列表 | 底部 Spinner 或少量 Skeleton | session list、skills、experts |
| Chat 启动/流式输出 | 固定内容区域，状态文案和消息级指示器 | `agent-chat-status-view.tsx` |
| 错误 | 就近错误面板，提供一个主要重试入口 | 所有可重试请求 |

## 组件边界

- `components/ui` 只提供无业务的 DOM、样式、ARIA 和 ref 组合。
- `components/agents` 提供 Agents 专用 `AgentState`、加载样式和文档约束。
- 页面/controller 把请求状态映射到 `LoadingMode`，决定是否保留旧数据。
- 页面首屏门禁以“是否已有成功快照”为边界；空数组也是已完成快照，后续路径切换或刷新不得卸载整页。
- Repository、Context、SDK 和路由不因加载视觉调整而改变接口。
- `StatePanel` 继续兼容现有非 Agents 页面；迁移期间与 `AgentState` 共享 token，但不强制一次性替换所有消费者。

## 验收

- 首次请求不会先显示空列表再切换成内容。
- 刷新和保存不会清空已展示数据或改变按钮尺寸。
- 加载、空、错误、成功四种状态的角色和文案可被测试读取。
- 桌面、390px 手机和矮窗口保持内容几何稳定。
- 无新增请求、业务状态、依赖或后端逻辑。
