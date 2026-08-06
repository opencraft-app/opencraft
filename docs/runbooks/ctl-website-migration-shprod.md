# ctl 建站迁移上生产 Runbook（000029–000046）

面向 CloudBase 静态建站一期在 `shprod` 的库变更执行。

关联交接文档：`docs/handover/2026-08-05-cloudbase-static-site-handover.md`

## 1. 执行入口：不是手工跑 SQL

`ctl` 的库变更有受控入口，**不要**用临时 mysql pod 逐条粘贴 SQL：

```bash
python3 .ci/runtime/commands/run_gitops_db_job.py \
  --service ctl \
  --env shprod \
  --operation migration \
  --revision <合入 master 的 commit sha> \
  --apply \
  --wait
```

它做的事：把当前 checkout 的 `ctl/migrations/` 渲染成一次性 ConfigMap，挂给
`migrate/migrate:v4.18.3`，执行 `migrate -path /migrations -database "${db_url}" up`。

脚本前置校验：

- 当前 `HEAD` 必须等于 `--revision`
- `ctl/migrations/` 不能有未提交改动

参考：`docs/runbooks/gitops-db-job-runbook.md`

### 与 Argo 稳态发布的关系

`argocd/services/ctl/shprod/delete-migration-job.yaml` 用 `$patch: delete` 显式移除了稳态
migrate Job，所以**迁移不会随 Argo 同步自动发生**，必须显式触发上面的一次性 job。
这是有意设计，不是配置缺失。

## 2. golang-migrate 的 dirty 语义（执行前必须理解）

`migrate` 按 `schema_migrations.version` 增量推进。任何一条迁移中途报错，会把该表标记为
**dirty**，此后**所有** ctl 迁移都会被拒绝执行，直到人工介入清理版本号并修复。

因此：**一条在生产会失败的迁移，代价不是"这条没生效"，而是阻塞整条迁移通道。**

2026-08-05 就抓到过一条这样的迁移，见下节。

## 3. 已知坑：跨表 JOIN 的 collation 不一致

`000046` 原始写法直接 JOIN `website_sites` 与 `user_resource_quota` 的 `user_id`，
在北京实测报错：

```
ERROR 1267 (HY000): Illegal mix of collations
(utf8mb4_0900_ai_ci,IMPLICIT) and (utf8mb4_unicode_ci,IMPLICIT) for operation '='
```

根因在迁移文件本身，与环境无关：

| 迁移 | 建表方式 | 结果 collation |
|---|---|---|
| `000003_create_user_resource_quota` | 显式 `COLLATE=utf8mb4_unicode_ci` | 固定 `utf8mb4_unicode_ci` |
| `000029_create_website_sites` | 只写 `DEFAULT CHARSET=utf8mb4`，未指定 COLLATE | **跟随库默认，逐环境不同** |

北京 `ctl` 库默认是 `utf8mb4_0900_ai_ci`，而该实例的 `collation_server` 是
`utf8mb4_general_ci` —— 两者不一致本身就说明**不能假设生产与北京相同**。

已修复：在 `000046` 的关联条件上显式 `COLLATE utf8mb4_unicode_ci`。
该写法与库默认无关，已在 `0900_ai_ci` 和 `general_ci` 两种库上分别验证通过。

> 后续再写跨表 JOIN 的迁移时，只要一侧涉及 `website_*` 表、另一侧涉及 000003 之前建的表，
> 就必须显式 COLLATE。

## 4. 字符集：客户端必须指定 utf8mb4

若绕过受控入口、改用 `mysql < file` 手工执行，**必须**带
`--default-character-set=utf8mb4`，否则建表语句里的中文 COMMENT 会存成乱码
（试跑中实际复现：`TCB环境ID` → `TCBçŽ¯å¢ƒID`）。

已确认 000029–000046 **没有任何中文数据字面量**，seed 全是数字 JSON，
所以乱码风险只波及注释，不损坏业务数据。受控入口的 DSN 不受此问题影响。

## 5. 上线前校验（2026-08-05 已在北京完成）

### 5.1 全序列干净库试跑

在北京 MySQL 上建空库跑完 000001–000046 全 46 条，两种库 collation 各一遍：

| 库 collation | 结果 |
|---|---|
| `utf8mb4_0900_ai_ci`（同北京 ctl） | 46/46 通过 |
| `utf8mb4_general_ci`（同 server 默认） | 46/46 通过 |

试跑库已删除（`ctl_dryrun_0900` / `ctl_dryrun_gen`）。

复现方式：把所有 `*.up.sql` 按序拼接、每条前后插入 `SELECT '>>> BEGIN <file>'` 标记，
一次性喂给 mysql 客户端（默认遇错即停，最后一个标记就是失败点）。

### 5.2 schema 漂移比对

用 `mysqldump --no-data` 比对「北京现网 ctl」与「迁移文件跑出来的干净库」：

北京现网**多出**以下对象，均**不在任何迁移文件里**，属历史手工 DDL 遗留，生产不会有：

| 表 | 多出对象 | 说明 |
|---|---|---|
| `website_sites` | `current_generation int` | 孤儿列，代码不引用 |
| `website_releases` | `generation int` | 孤儿列；配套的 `idx_website_releases_site_gen` 唯一索引曾导致二次发布失败，已 DROP |
| `website_operations` | `attempt_count int` | 孤儿列，代码用的是 `attempt` |
| `website_operations` | `idx_website_operations_lease` | 多余索引 |

一处**定义差异**（非孤儿）：

| 列 | 北京现网 | 迁移文件定义 |
|---|---|---|
| `website_operations.lease_token` | `varchar(64) DEFAULT NULL` | `varchar(64) NOT NULL DEFAULT ''` |

已核查代码：所有 `lease_token` 比较都是拿真实 token 匹配，释放租约写 `""`，
Go 侧 `LeaseToken string` 为非指针（NULL 扫描为 `""`）。两种定义对现有代码路径均无害，
生产会拿到迁移文件定义的 `NOT NULL DEFAULT ''`，即预期形态。

> 结论：**北京的 schema 漂移不影响生产**，但也意味着北京的测试结果不能 100% 代表生产，
> 生产执行后仍需重跑一次 5.2 的比对。

## 6. 生产执行清单

- [ ] 代码已合入 `master`，记下 commit sha
- [ ] `git checkout <sha>`，确认 `ctl/migrations/` 干净
- [ ] 先不加 `--apply` 空跑一次，确认渲染出的 job 指向正确的 namespace / DB
- [ ] 备份或确认 `ctl` 库有可用快照（`migrate` 不做 schema rollback）
- [ ] 执行 `--apply --wait`
- [ ] 确认 `schema_migrations.version = 46` 且 `dirty = 0`
- [ ] 重跑 5.2 的 schema 比对，确认与迁移文件定义一致
- [ ] 抽查 `bundle.static_site_quota`：free = 1 站，general/ai = 3 站

## 7. 回滚

`migrate` 支持 `down`，且 000029–000046 每条都配了 `.down.sql`。但注意：

- `000040` DROP 了 `website_usage_daily`，down 只能重建空表，**原数据不可恢复**
- `000045` / `000046` 是数据去重，down 无法还原被删除的重复行

因此回滚前必须先确认库快照可用，不要指望 `migrate down` 能完全还原。
