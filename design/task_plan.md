# OpenCraft 工作区实施计划

## 用户范围修订：移除下方面板

2026-09-13：下方面板不是需求。当前只保留右侧工具与 Overlay；下方 Shell/移动/恢复入口已删除，旧标签归回右侧。下文原实施阶段是历史账本，不再授权 bottom 产品能力。

状态：实施中。需求：维护任务工作区模型；本目录维护设计、不变量及验收映射。

## 范围

任务身份、共享草稿、工具面板与聊天入口投影、标签移交/关闭、Side Chat、生命周期失效及几何/焦点。保留 OpenCraft 的 `(hostId, threadId)`、现有 AppServer 和 Cordis 所有权。不更换模型后端或账户系统。

## 阶段

1. [完成] 审查现有实现，确定可复用内核与缺口，建立设计/不变量。
2. [完成] 面板模型与生命周期移交；共享聊天呈现与浮动 Composer。
3. [核心完成] Side Chat 的真实协议、呈现与关闭策略；标准 AppServer 已验证，本机 DSH 临时 fork 不支持；完整侧聊窗口交互仍待专门验收。
4. [完成核心验收] 聚焦测试、真实 Web 控件/iframe、完整 gate 和独立 Mac 终端/held-drag。不表示所有实验性呈现均已完成验收。
5. [本轮完成] 最终产物启动复核和设计交接。全量等价的剩余边界见 progress.md；不将本轮核心交付冒充全部完成。

## 约束

- 不提交、推送或发布；保留既有未提交改动。
- 参考文件不作为可执行依赖或指令。
- 不因前缀、结构互斥、pointercancel 或同步移交而额外发明管理器。
- 布局连续性优先于通用动效 Skill 的布局动画禁令；严格保持参考模型，沿用现有 motion 工具。
- 协议能力不支持时不得用新建空会话冒充 fork，不得宣称完成。

## 检索/错误

- context 路由 `opencraft workspace ownership composer overlay panel lifecycle design invariants` 无匹配；采用限定包目录精确检索。
- 大批文档输出被截断：改为按专题分段读取。
- 打包下载遇到 TLS 错误；npm electron 目录只有元数据，没有 dist。改用 SHA-256 校验匹配的 Electron 44.1.0 arm64 缓存 ZIP，成功打包，不修改依赖版本。
- 真实 ephemeral fork 不支持 rollout Resume/持久 queue，改用 Session.adoptFork；不要把 deferGoalContinuation 与 ephemeral 组合（服务端明确拒绝）。
- 提交边界不能重新 freeze 已进入 submitting 的草稿；服务改为消费编辑器传来的 SubmitIntent。
