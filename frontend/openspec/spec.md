# 诊断中心 Agent 备份与恢复交互优化规格

## 范围

页面范围：`/agents/diagnostics` 诊断中心内的 `workspaceRecoveryPanel`。

代码范围：

- `frontend/src/pages/marketing/agent-settings-page.tsx`
- 必要时补充同目录测试或 repository 测试
- i18n generated 文件

## 交互模型

### 面板结构

面板改为“任务控制台”结构：

1. 标题区：展示“Agent 备份与恢复”、当前 Agent 名称、Agent 文件路径。
2. 能力说明：默认只显示一句摘要，范围和排除项放入可展开详情。
3. 当前任务区：展示当前任务类型、阶段、最近更新时间和主状态。
4. 操作区：两个主操作按钮：
   - `备份到邮箱`
   - `从备份恢复`
5. 详情区：按任务归属展示日志；无任务时显示一个带主行动作的空态。

不得使用嵌套卡片；面板内重复项保持 `rounded-md`、轻边框和紧凑工具感。

### 导出流程

1. 按钮可用条件：
   - activeBot 存在
   - activeBot.status 为 `running`
   - 当前没有导出或导入任务处于非终态
   - 当前没有 reset Agent 流程运行
   - 用户已绑定 email
2. 点击后展示产品内确认弹窗，内容包括：
   - 目标 Agent
   - 导出范围 `/home/agentuser/.hermes`
   - 结果将发送到绑定邮箱
3. 确认后立即写入本地 `starting` 状态并调用 `startRescueExport`。
4. 后端返回 accepted 或 already running 后，自动加载状态并轮询。

### 导入流程

1. 点击 `从备份恢复` 时打开文件选择器，仅接受 zip。
2. 文件选择后展示确认弹窗，内容包括：
   - 文件名与大小
   - 目标 Agent
   - 覆盖恢复风险
3. 确认后立即写入本地 `starting` 状态并调用 `importHermesWorkspace`。
4. 上传、发起 worker action、状态轮询沿用现有 repository 能力。

### 状态归并

导出和导入仍保留独立后端状态，但前端展示时派生 `currentWorkspaceTask`：

- 若导出运行中，当前任务为导出。
- 否则若导入运行中，当前任务为导入。
- 否则优先展示最近一次有状态的任务。
- 运行中任务互斥：任一任务非终态时，另一个主操作不可发起，并提示“当前已有 Agent 备份或恢复任务运行中”。

终态仍为：

- `completed`
- `failed`

其它 phase 均视为运行中。

### 阶段文案

导出阶段文案使用导出语义：

- `locating`：定位 Agent
- `enter_rescue` / `wait_rescue` / `wait_remote_access`：准备导出环境
- `prepare_archive` / `start_tat` / `wait_tat` / `finalize_archive`：生成备份包
- `copy_archive`：上传备份包
- `notify_email` / `confirm_email_delivery`：发送邮件
- `cleanup_remote` / `exit_rescue` / `wait_running`：恢复运行环境

导入阶段文案使用导入语义：

- `locating` / `wait_remote_access`：连接 Agent
- `prepare_import`：校验备份包
- `start_tat` / `wait_tat`：恢复 Agent
- `finalize_import`：确认恢复结果
- `cleanup_import_object`：清理临时文件
- `notify_email` / `confirm_email_delivery`：发送邮件

### 错误处理

新增前端错误清洗函数，把常见原始错误转换为主文案：

- `last=PENDING` 或 `timed out waiting for ins-`：导出环境启动超时，Agent 所在云主机仍在准备中。请稍后重试。
- `timed out waiting for TAT agent online`：远程命令通道暂时不可用，请稍后重试。
- `hermes_import_zip_required`：请选择 Hermes 导出的 zip 备份包。
- `uploaded archive is empty` / `bad zip member` / `Not a valid zip`：备份包无法识别或已损坏，请重新选择 zip 文件。
- `missing_user_email`：请先在账号页绑定邮箱。

主文案只展示产品化错误；原始错误和原始日志放入“备份或恢复详情”。

## 可访问性

- 确认弹窗使用项目已有 Dialog 或 AlertDialog primitive，不使用 `window.confirm`。
- icon-only 操作必须有 `aria-label`。
- 禁用按钮原因应在按钮附近或 tooltip 中说明。
- 文件 input 保持隐藏但由按钮触发；不得阻止用户粘贴或键盘操作。

## 验证

- 针对阶段文案、错误清洗、互斥任务派生逻辑补充单元测试。
- 运行 `pnpm i18n:extract`、`pnpm i18n:check`、相关 Vitest、`pnpm check`。
- 本地预览至少 smoke 诊断中心面板：空态、未绑定邮箱、导出失败态、导入文件选择态。
