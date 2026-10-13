# 为 OpenCraft 全部 SQLite 库建立统一迁移账本、升级前备份与更新门禁

更新：2026-10-13

## 路线

正式设计见 [sqlite-lifecycle](../sqlite-lifecycle.md)；本目标按其第 4 阶段「其他权威库」落地，并把一键更新的回退语义补齐。

- [x] 阶段 0：评估现状并选定方案。9 个库中 2 个有账本；更新器只回退代码（thr_7gi4fzwvkk）
- [ ] 阶段 1：共享 node:sqlite 生命周期模块（账本、升级前备份、无账本旧库处置）+ 纵向切片：document-storage 换实现保持基线 hash、session-routing 接入 ← 进行中（最近线程 thr_ivpebcdpvw）
- [ ] 阶段 2：Host 其余库接入：thread-catalog（document 加版本字段）、executions（合并 hypernode DDL 为单一 owner）、managed-connectors、account-pool（owner 是 codex-core 进程，升级路径独立）
- [ ] 阶段 3：Electron Main 两库接入：ui-preferences、connector-configuration
- [ ] 阶段 4：daemon 全部库就绪后才监听与报告健康；真实升级/回退门禁接入 `test:server-updates`
- [ ] 阶段 5：文档回写（sqlite-lifecycle 现状、AGENTS 规则）、autoreview、合并 main

## 关键决策

保留 node:sqlite、不引入 ORM、不合库的理由已在 [sqlite-lifecycle](../sqlite-lifecycle.md) 第 1、6 节。以下只记本目标新增的取舍。

- 2026-10-13 内部开发阶段不为无账本旧库做逐库历史形态识别：结构与当前基线完全一致则采纳并补账本，否则备份后移开重建。原因：用户明确可容忍数据重建，要求舍弃历史包袱。影响：阶段 1 的模块契约；阶段 2、3 不写 legacy-baseline 代码。
- 2026-10-13 升级前备份由各库 owner 在迁移前用 `VACUUM INTO` 完成，更新器不碰数据目录。原因：只有 owner 持有连接并能保证 WAL 一致性。影响：阶段 1 模块；阶段 4 门禁断言备份存在。
- 2026-10-13 更新器回退只回退代码，不自动恢复备份；备份文件保留供人工恢复。原因：自动恢复会丢弃升级后的写入。影响：阶段 4 行为；阶段 5 文档与更新页文案。
- 2026-10-13 迁移 SQL 以 TS 常量随各库 owner 源码交付，不另起 SQL 资产目录。原因：随 bundle 自然打包，省去发行包资产检查。影响：阶段 1 契约；阶段 4 打包验证范围。
- 2026-10-13 管家与用户约定：每个阶段合并前派一次独立审查；合并到 main 的方式由用户裁决。

## 用户待办

| 状态 | 事项 | 为什么只能用户做 | 挡住 | 提出 |
| --- | --- | --- | --- | --- |
| 待办 | 决定阶段 5 的合并方式：PR 到 main，还是本地 ff 合并 | 分支策略与仓库可见性由仓库所有者决定 | 阶段 5 | 2026-10-13 |
