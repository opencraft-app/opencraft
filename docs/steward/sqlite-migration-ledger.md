# 为 OpenCraft 全部 SQLite 库建立统一迁移账本、升级前备份与更新门禁

更新：2026-10-13

## 路线

正式设计见 [sqlite-lifecycle](../sqlite-lifecycle.md)；本目标按其第 4 阶段「其他权威库」落地，并把一键更新的回退语义补齐。

- [x] 阶段 0：评估现状并选定方案。9 个库中 2 个有账本；更新器只回退代码（thr_7gi4fzwvkk）
- [x] 阶段 1：共享模块 `packages/sqlite-node`（账本、升级前备份、无账本旧库处置）+ 纵向切片 document-storage、session-routing；已独立审查（thr_ivpebcdpvw，rebase 后 commit cb5fb91）
- [x] 阶段 2：其余六库接入：Host 的 thread-catalog（document 加版本字段）、executions（基线迁移为唯一 DDL 权威）、managed-connectors、account-pool（owner 是 codex-core 进程，升级路径独立）；Electron Main 的 ui-preferences、connector-configuration（thr_awp42y5zzb，commit 78805d0、544d7b7）
- [x] 阶段 3：daemon 启动时打开并迁移全部 Host 库，未就绪不监听 IPC；处置结果经 `daemon/ready` 到 gateway `/health.storage`；单元测试 + 更新 smoke 预置旧库验证，proof 在 `.local/server-updates/proof.json`（thr_w9hu76q468，commit f16b25c，已独立复审）
- [ ] 阶段 4a：文档回写（sqlite-lifecycle、platform-architecture、web-deployment、AGENTS 规则）、整条分支 autoreview、`npm run gate`；推送前停下 ← 进行中（最近线程 thr_szsu3diywa）
- [ ] 阶段 4b：管家收尾工作簿后，推送分支、开 PR 到 main、CI 通过后按仓库惯例合并

## 关键决策

保留 node:sqlite、不引入 ORM、不合库的理由已在 [sqlite-lifecycle](../sqlite-lifecycle.md) 第 1、6 节。以下只记本目标新增的取舍。

- 2026-10-13 内部开发阶段不为无账本旧库做逐库历史形态识别：结构与当前基线完全一致则采纳并补账本，否则备份后移开重建。原因：用户明确可容忍数据重建，要求舍弃历史包袱。影响：阶段 1 的模块契约；阶段 2、3 不写 legacy-baseline 代码。
- 2026-10-13 升级前备份由各库 owner 在迁移前用 `VACUUM INTO` 完成，更新器不碰数据目录。原因：只有 owner 持有连接并能保证 WAL 一致性。影响：阶段 1 模块；阶段 4 门禁断言备份存在。
- 2026-10-13 更新器回退只回退代码，不自动恢复备份；备份文件保留供人工恢复。原因：自动恢复会丢弃升级后的写入。影响：阶段 4 行为；阶段 5 文档与更新页文案。
- 2026-10-13 迁移 SQL 以 TS 常量随各库 owner 源码交付，不另起 SQL 资产目录。原因：随 bundle 自然打包，省去发行包资产检查。影响：阶段 1 契约；阶段 4 打包验证范围。
- 2026-10-13 executions 库里 hypernode 表的 DDL 以 `dsh-execution-authority.ts` 的基线迁移为唯一权威；`hypernode/*.js` 的 `initializeSchema` 原文保留，作为 `scripts/check-dsh-source.mjs` 校验的镜像，并用 schemaFingerprint 等价测试防漂移。原因：这些方法体必须与 HyperNode 参考源逐方法一致，不能删。影响：阶段 2 executions 接入；以后改 hypernode 表结构必须同时加迁移并同步参考源。
- 2026-10-13 Host 的五个库在 daemon 启动时全部打开并迁移，失败则 daemon 不监听、进程非零退出；DSH 引擎仍懒启动。处置摘要作为 `daemon/ready` 的可选字段传到 gateway `/health.storage`，更新器的 `ok` 判定不变。原因：更新器只在重启窗口内轮询健康，迁移必须发生在这个窗口里，而不是用户第一次连接时；gateway 以子进程拉起 daemon，只能走握手传递。影响：阶段 3 实现；Electron 端消费同一握手字段但本目标不改其 UI。
- 2026-10-13 内部开发阶段不要求 N-1 旧二进制兼容，门禁不跑旧二进制回退；只断言启动期迁移结果可见、备份存在、健康门控生效、同源两版升级与回退连续。原因：用户要求舍弃历史包袱；smoke 的两版 release 都由当前源码打包。影响：阶段 3 的 smoke 断言与 proof 边界说明；阶段 4 文档要把 sqlite-lifecycle 第 4 节的兼容规则改写为现状。
- 2026-10-13 Host 存储有单一 owner claim（`storage/daemon-storage-owner.ts`）：claim 阶段用短互斥，生命周期由活进程身份保护，不依赖 heartbeat。原因：迁移可能长于任何 heartbeat 间隔，heartbeat 过期会让第二个 daemon 误以为可以接管。影响：阶段 4 文档必须描述该语义；以后改成 heartbeat 式租约需要重新论证。
- 2026-10-13 管家与用户约定：阶段 4 对整条分支派一次独立审查，然后开 PR 到 main，CI 通过后合并，不本地 ff 推送。原因：用户裁决，与仓库近期 PR 流程（#27、#28）一致。影响：阶段 4 收尾方式。

## 用户待办

| 状态 | 事项 | 为什么只能用户做 | 挡住 | 提出 |
| --- | --- | --- | --- | --- |
| 已完成 | 决定阶段 4 的合并方式：PR 到 main，还是本地 ff 合并（选 PR） | 分支策略与仓库可见性由仓库所有者决定 | 阶段 4 | 2026-10-13 |
