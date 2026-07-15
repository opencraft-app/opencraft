# 当前需求状态

## 当前进行中

- **需求名**：统一 Agent 名称真源并清理出生证旧逻辑
- **启动日期**：2026-07-14
- **TAPD**：用户文字需求：排查并修复 Agent 名称 “我的Hermes / Hermes宝宝” 不一致，清理出生证与“第几个 Hermes 宝宝”旧逻辑
- **分支**：`frontsandbox/hermes-agent-name-investigation`
- **规模**：L
- **当前阶段**：实现已完成，前端验证通过；Go 目标测试受本机 Go 1.21.5 / go.work 1.26 toolchain 限制暂未执行；gateway-dashboard 因无锁文件未擅自安装依赖，仅完成静态残留扫描
>
> 上一个需求：「LightVela 场景任务安装器 v1」已于 2026-07-14 归档（18/18 任务完成）。
> - 详细变更记录：`openspec/changes/2026-07-14-frontsandbox-scenario-task-installer.md`
> - 分支：`frontsandbox/scenario-task-installer`
>
> 历史归档：
>   - 2026-07-14：LightVela 场景任务安装器 v1（18/18 任务）
>   - 2026-07-02：诊断中心 Agent 备份与恢复交互优化（16/16 任务）
>   - 2026-06-17：SEO CR 边界加固（4/4 任务）
>   - 2026-06-17：Hermes Agent 版本更新公告（1/1 任务）
>
> 执行 `/feai-start` 启动新需求。
