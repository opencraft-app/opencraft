# 同 SP 变配（启航 → 巡游 / 启航 AI → 巡游 AI）联调与发布手册

> **日期**：2026-09-02
> **需求**：TAPD [1010132091137784162](https://tapd.woa.com/tapd_fe/10132091/story/detail/1010132091137784162)
> **范围**：trade（计费协议与订单）、ctl（权益状态机与编排）、sandbox（实例规格变更）三个服务的源码改动，以及联调环境的配置与运营数据前置。
> **状态口径**：源码就绪不等于可联调。第二节的前置数据缺失时链路会失败，但**失败发生的时机不同**，见 2.1——只有前三项是扣款前 fail-closed，资源池映射缺失要到扣款后才暴露。

## 一、链路总览

```
用户 → ctl  GET  /v1/passes/{pass_id}/modify/bundles       可变配套餐 + 实时差价
            POST /v1/passes/{pass_id}/modify/order         建单
            POST /v1/passes/{pass_id}/modify/order-url     建单 + 支付页
            POST /v1/passes/{pass_id}/modify/order-and-pay 建单 + 代扣（联调）
        ↓ 询价 / 下单
      trade  POST /internal/trade/inquiry/modify
             POST /internal/trade/orders/modify[/place-and-pay]
        ↓ jifei qcloud.price.getPrice / generateDeals[AndPay]
      计费
        ↓ 回调（同步，秒级预算）
      trade  lightvela.pass.checkModify   → ctl POST /internal/ctl/passes/{pass_id}/check-modify
             lightvela.pass.modifyResource → ctl POST /internal/ctl/passes/{pass_id}/modify
        ↓ 受理即返（异步收敛）
      ctl    变配父 task（pass: active → modifying）
        ↓ 每台实例一个子 task
      sandbox POST /internal/sandboxes/{id}/modify
              GET  /internal/sandbox-modify-operations/{operation_id}
        ↓ 停机 → ResetInstancesType → ResizeInstanceDisks → 开机 → rebind pool
      ctl    切 VelaGW 订阅 → 事务提交 bundle + agent_quota → pass 回 active
        ↓
      trade  POST /internal/trade/flows/{flow_id}/complete
```

关键时序约束：`modifyResource` 回调只做"受理"（CAS + 入队），真正的收敛是十几分钟到小时级；计费拿到的是 `flowId`，终态由 ctl 父 task 回调 trade 推进 `trade_flow`。

## 二、联调前置（缺一项就跑不通）

| 项目 | 位置 / 责任方 | 校验方式 |
|---|---|---|
| trade 侧 `scene='modify'` 的 categoryId | 运营数据，`trade.trade_bundle_definition.category_ids` | 执行 `scripts/seed_trade_modify_scene_category.sql`，核对末尾 SELECT |
| 四个 SP 各自的 Modify CategoryID | 计费接入单，[accesslist](https://xy.tcb.woa.com/xy/app/prod/access/accesslist) | 测试/预发值已回读为 `2025048`、`2025275`、`2025257`、`2025272`；国内 / 国际是两个 trade 库，脚本各站跑一次；生产执行前仍须确认变更单已正式发布且财管审批完成 |
| ctl bundle 的 `instance_spec_id` 配对 | 运营数据，`ctl.bundle` | 回读源/目标 Bundle 实际 `instance_spec_id`；当前测试数据观测为启航 `spec-2c4g50g`、巡游 `spec-4c8g80g`，但规格名不是需求硬编码门禁 |
| 目标规格的资源池映射 | GitOps `argocd/services/ctl/<env>/*ctl-conf-rewrite.yaml` + sandbox DB | 以目标 Bundle 实际 `instance_spec_id` 反查对应 template/SKU/pool，并确认 pool 在 sandbox DB 真实存在 |

### 2.1 前三项扣款前拦截，资源池映射不是

前三项都在 `checkModify` 覆盖的校验面内：categoryId 缺失会让询价报 `category_ids[scene=modify] missing`，`instance_spec_id` 为空会返回 `ErrPassModifyTargetNotAllowed`，都发生在计费扣款之前。

**资源池映射缺失是个例外，它不会在扣款前被拦下。** 按需求 §5.3，`checkModify` 只做 Trade/CTL DB 与本地 BundleDefinition 校验，明确**不调用 Sandbox**，所以它无法知道目标 Bundle 的实际规格是否有可用 pool。真实路径是：checkModify 放行 → 用户扣款 → `modifyResource` 受理 → pass 进入 `modifying` → 父 task 调 `ResolveModifyTargetPool` 拿不到 pool 而报错 → 父 task 按"永不放弃"节奏重试（30s × 1<<30）。

后果是用户已付款、pass 卡在 `modifying`，直到运维补上映射后自动收敛。这符合 §8.3 的前滚收敛设计，也不违反 §11「不存在权益已升级但实例永久停在启航且 flow 显示成功」——flow 不会被标成成功。但它意味着**联调前必须先回读目标环境的 pool 映射**，不能指望链路帮你挡住。

零实例的 pass 不受此影响：父 task 不解析 pool。

以下是当前 Cruise 测试数据实际解析到 `spec-4c8g80g` 时的 GitOps 配置现状（"已有"指配置在 master 上就存在，不代表 sandbox DB 已录入；若 BundleDefinition/Bundle 实际配置变化，必须按实时目标规格重新回读，不能把本表当固定产品契约）：

| 环境 | template_class | pool | 配置状态 |
|---|---|---|---|
| shprod | `openclaw-4c8g80g` | `pool-sh-4c8g80g-01` | 已有 |
| sgprod | `openclaw-4c8g80g` | `pool-1787798066081877763-1` | 已有 |
| beijing-sandbox | `openclaw-4c8g80g` | `pool-c-4c8g-01` | 已有 |
| sandbox-bj-7 | `openclaw-4c8g80g` | `pool-bj7-4c8g80g` | 已有 |
| sandbox-kr-1 | `openclaw-4c8g80g` | `pool-kr-4c8g-01` | CTL 配置已修正为运行库里的真实 Pool ID；联调前仍需回读 Pool 状态与 CLEAN 容量 |

回读 SQL 需在**实际部署了 sandbox 的环境**上执行；国内测试环境 bj-7 把 pool 换成 `pool-bj7-4c8g80g`：

```sql
-- 目标环境的 sandbox 库
SELECT id FROM template_classes WHERE id = 'openclaw-4c8g80g';
-- 系统盘规格在 skus 上（migration 000008），派生 pool 继承它；4C8G 契约要求 80GB
SELECT id, template_class_id, instance_type, system_disk_size
FROM skus WHERE id = 'sku-hermes-4c8g';
SELECT id, instance_type, status, desired_capacity FROM pools WHERE id = 'pool-kr-4c8g-01';
SELECT * FROM template_pool_bindings
WHERE template_class_id = 'openclaw-4c8g80g' AND pool_id = 'pool-kr-4c8g-01';
```

ctl bundle 规格配对核验：

```sql
-- ctl 库
SELECT bundle_id, bundle_state, agent_quota, credit, ai_gateway_plan_id, instance_spec_id
FROM bundle
WHERE bundle_id IN (
  'bundle_launch_01', 'bundle_cruise_01',
  'bundle_launch_ai_01', 'bundle_cruise_ai_01'
);
```

> 四个 Modify CategoryID 当前只确认已发布到测试/预发。共享测试库执行 seed 后，末尾汇总中当前站点存在的两个 SP 必须为 `READY`，另两个站点的 SP 应为 `NOT_PRESENT_IN_THIS_SITE`；生产变更单未发布前严禁在生产库 seed。

## 三、DB migration

| 服务 | migration | 内容 |
|---|---|---|
| ctl | `000029_add_pass_modify_fields` | `pass` 增 `modify_flow_id`、`modify_target_bundle_id` |
| sandbox | `000009_create_modify_operations` | 新建 `modify_operations` 变配台账表 |
| trade | `000009_add_modify_support` | `trade_order.order_type` / `trade_flow.flow_type` 注释补 modify 取值（无结构变更） |

三份都有配套 `.down.sql`。ctl 的两列可空、sandbox 是新表、trade 只改注释，回滚不丢已有数据。

### 3.1 必须先迁移再发镜像（否则会以难排查的形态失败）

**ctl 的 schema 守卫在容器里是失效的，不要指望它挡住顺序错误。**
`main/common.verifySchemaVersion` 会比对 DB 版本与 `migrations/` 目录里的最大版本号，但 `ctl/Dockerfile` 只 COPY 了 `bin/`、`i18n`、`conf/server/common` —— 镜像里没有 `migrations/`，于是 `resolveMigrationsDir` 找不到目录直接 `return nil`，守卫整段跳过。这个守卫只在本地开发（有源码树）生效。

后果：先发镜像后迁移不会 crash-loop，而是正常启动，然后所有读写 pass 的请求在运行时报 `Unknown column 'modify_flow_id' in 'field list'`。看起来像代码 bug，实际是顺序问题。

**常驻环境的迁移是 K8s Job，Job 名不变就不会重跑。**
Job 是不可变对象，Argo 见到同名已存在的 Job 就认为无需变更，迁移永远不执行，随后 sandbox 变配接口报 `modify_operations` 表不存在。sandbox 侧 Job 名在 `argocd/services/sandbox/<env>/kustomization.yaml` patch 成固定后缀（`beijing-sandbox` = `sandbox-db-migrate-v4`，`beijing-sandbox-2` / `shprod` / `sgprod` = `-v3`），**要应用 000009 必须把目标环境的后缀往上 bump 一位**；ctl 侧 Job 名取自 `argocd/services/ctl/<env>/ctl-platform.env` 的 `REPLACE_CTL_MIGRATION_JOB_NAME`（shprod / sgprod 当前均为 `ctl-migrate-20260330155152`），需换成新时间戳才会重跑。本改动集不含任何 bump，放行常驻环境部署时才提交。

**但 §10.3 指定的两个测试环境都不走 Argo 迁移，bump 对它们无效。** 两边的 playground overlay 都把迁移 Job 显式删掉了——`argocd/services/sandbox/sandbox-bj-7/delete-migration-job.yaml` 对 `sandbox-db-migrate-v2` 打 `$patch: delete`，ctl 侧则按 `argocd/services/ctl/sandbox-bj-7/README.md`「steady-state sync 只接管常驻 workload，不接 migration job」复用 `beijing-sandbox` overlay 的同名删除。所以 **bj-7 / kr-1 的 000029 与 000009 都必须手工 `migrate up` 执行**，在这两个环境里去 bump Job 名是无效动作。

正确顺序：**先把迁移跑到 000029 / 000009（测试环境手工执行，常驻环境 bump Job 名并确认 Job 完成）→ 再发三个服务的镜像 → 最后 seed 运营数据**。

### 3.1.1 kr-1 的源码声明与实时环境不一致，联调必须先做运行态回读

仓库当前仍未在 `argocd/catalogs/playground/seoul-playground/sandbox-kr-1/` 注册
`sandbox.yaml`，`argocd/services/sandbox/` 下也没有 `sandbox-kr-1` overlay；但
2026-09-07 对共享测试环境的运行态探测已经看到 Sandbox API/Worker Ready、Sandbox
schema 版本 8，不能再按“韩国无 Sandbox”跳过有实例链路。

这表示韩国 Sandbox 当前属于未被本仓库声明完整覆盖的测试环境事实，可能随人工部署变化。
每次联调前必须重新回读 Deployment/Pod、schema、`openclaw-4c8g80g`、
`sku-hermes-4c8g`、`pool-kr-4c8g-01`、绑定与 CLEAN 容量。运行态具备这些条件时，
kr-1 应同时覆盖零实例和有实例完整闭环；缺任一项时先补测试环境，不得把用例降级成
“只验零实例”后宣称国际站通过。

### 3.2 积分切换的保证在 velagw，不在 ctl —— 联调时别把"订阅无名字"当 bug

需求 §7.2 写的调用形态是 `ApplySubscription(PlanID, SubscriptionName: "package:{userID}:{passID}", IsUnique: true, IdempotencyKey: "modify:{dealName}")`，并解释为「不同 Plan 使用相同唯一订阅名完成替换」。实际实现里 ctl 的 `EnsureAiGatewayEntitlement` **不传 `SubscriptionName`**（这是它与续费共用的既有形态），所以联调时在 newapi 侧会看到一条没有名字的 package 订阅。

这不影响正确性，因为替换语义并不由订阅名决定。`velagw/internal/gateway/service.go` 的逻辑是：

1. `reusableUniqueSubscription` 只在**上游 PlanID 相同**时才复用；变配的目标 Plan 与启航 Plan 不同，所以必然新建一条，用户拿到目标套餐的完整额度（巡游 200 / 巡游 AI 10000）。
2. 随后 `IsUnique` 分支遍历该用户其余在活订阅并作废，**唯独跳过 `isAdditiveSubscription`**（名字前缀 `free-credit:`）——这是 `free-credit:*` 得以保留的机制。
3. 重投时 `IdempotencyKey` 转成 newapi 的 `RequestID` 去重；且首次成功后目标 Plan 已在活，第一步的 PlanID 匹配会直接复用，不会叠加第二份。

上游对应用例：`velagw/internal/gateway/periodless_subscription_test.go` 的 `TestApplySubscriptionSwitchPreservesAdditiveCredits`（走的是带名字的形态；不带名字只影响订阅有无 name，复用判定同样由 PlanID 决定）。

**联调要观察的三点**：目标 Plan 的订阅在活且额度是目标套餐完整值；原启航订阅已作废；`free-credit:*` 条目仍在、余额未变。

### 3.3 放行执行清单（逐条可复制）

以下命令按顺序执行，**不可颠倒**。凭据全部用占位符，执行前从 SOPS / K8s Secret 取值注入环境变量，不要写进任何文件或命令历史。

约定：

| 占位符 | 取值来源 |
|---|---|
| `$KCTX` | bj-7 所在集群的 kubeconfig context（catalog `destinationName: beijing-playground`；集群与 AppProject 均未登记在本仓库 `argocd/clusters/`、`argocd/projects/`，需从 Argo CD 控制面确认） |
| `$NS` | `lightvela-playground-sandbox-bj-7` |
| `$CTL_DB_PASS` / `$SANDBOX_DB_PASS` / `$TRADE_DB_PASS` | 目标环境 K8s Secret（`ctl-runtime-secrets` / `sandbox-runtime-secrets` / `trade-runtime-secrets`）；ctl 的 `server_conf_rewrite.toml` 里是 AES-CBC 密文，不是明文，不要直接拿来当 DSN |
| `$NEW_CTL_DIGEST` / `$NEW_SANDBOX_*_DIGEST` / `$NEW_TRADE_TAG` | 本次改动集构建产物 |

所需权限：bj-7 集群的 `port-forward` + `get pod/secret`（步骤 1-2、4）；`git.woa.com:wisp/mono2` 的 `gitops` 分支推送权限（步骤 3）；trade/ctl 库的 DDL 权限（步骤 1、5）。**步骤 3 属于部署动作，必须先拿到虾米老师明确放行。**

#### 步骤 0：确认起点版本（只读，失败无需回滚）

在本机 mono2 工作树执行，先把 DB 打通到 bj-7：

```bash
# 终端 A：保持前台运行
kubectl --context "$KCTX" -n "$NS" port-forward svc/mysql 13306:3306
```

```bash
# 终端 B
cd ctl && make migrate-version DB_DSN="mysql://root:$CTL_DB_PASS@tcp(127.0.0.1:13306)/ctl_sandbox_bj_7?multiStatements=true"
cd ../sandbox && make migrate-version DB_DSN="mysql://root:$SANDBOX_DB_PASS@tcp(127.0.0.1:13306)/sandbox_sandbox_bj_7?multiStatements=true"
```

预期：ctl 报 `28`、sandbox 报 `8`，且都不带 `(dirty)`。

- 若带 `(dirty)`：**停止**，先人工核对上一次失败的迁移，`migrate force <上一版本>` 后再继续；带 dirty 直接 up 会跳过 SQL 只推版本号。
- 若 ctl 已是 `29` / sandbox 已是 `9`：跳过对应的步骤 1。
- 数据库名以目标环境实际值为准：ctl 侧可从 `argocd/services/ctl/sandbox-bj-7/patch-ctl-conf-rewrite.yaml` 的 `[db].database` 回读（当前为 `ctl_sandbox_bj_7`）；sandbox 侧本仓库未落盘明文库名，需从 `sandbox-runtime-secrets` 回读，**不要按命名规律猜**。

#### 步骤 1：手工执行迁移（先于发镜像）

bj-7 的 ctl 与 sandbox 迁移 Job 都被 overlay 删掉了（见 §3.1），必须手工跑：

```bash
cd ctl && make migrate-up DB_DSN="mysql://root:$CTL_DB_PASS@tcp(127.0.0.1:13306)/ctl_sandbox_bj_7?multiStatements=true"
cd ../sandbox && make migrate-up DB_DSN="mysql://root:$SANDBOX_DB_PASS@tcp(127.0.0.1:13306)/sandbox_sandbox_bj_7?multiStatements=true"
```

预期输出：`Running database migrations (up)...` 后无 error 退出；再跑一次 `migrate-version` 应得 ctl `29`、sandbox `9`。

回滚：`make migrate-down DB_DSN=...`（各回退一版）。ctl 的两列可空、sandbox 是新表，回滚不丢既有数据；但**若此时已发过新镜像，回滚迁移会立刻让 pass 读写在运行时报错**，所以回滚顺序必须是先回镜像再回迁移。

#### 步骤 2：trade 迁移（本环境需要额外确认）

trade 000009 只改 `COMMENT`，不影响运行时，但 bj-7 的 `trade-migrate` Job 名固定为 `trade-migrate` 且镜像 pin 在旧 tag（`argocd/services/trade/sandbox-bj-7/trade-migration-job.yaml`，见 §3.4），Argo 不会重跑它。要让版本号推进到 9，手工执行：

```bash
cd trade && go run ./cmd/trade-migrate
# 需要 TRADE_MYSQL_DSN 或 (TRADE_DB_USER / TRADE_DB_PASSWORD / MYSQL_HOST / MYSQL_PORT / TRADE_DB)
```

预期：`trade migrations applied`。

**可以有意跳过**：本迁移无结构变更，跳过只会让 trade 的 `schema_migrations` 停在 8，不影响本次联调；但下一个 trade 迁移落地前必须补上，否则版本号断层。若选择跳过，在交接里写明。

#### 步骤 3：部署三个服务镜像（写操作，需放行）

bj-7 由 ApplicationSet `sandbox-family` 从 `gitops` 分支自动同步（`argocd/apps/beijing-sandbox/sandbox-family-appset.yaml:13/30`，`automated.selfHeal: true`），所以"发镜像"= 改 platform env 并推 `gitops`：

| 服务 | 要改的文件 | 要改的键 |
|---|---|---|
| ctl | `argocd/services/ctl/sandbox-bj-7/ctl-platform.env` | `CTL_IMAGE`、`CTL_DEPLOYED_AT` |
| sandbox | `argocd/services/sandbox/sandbox-bj-7/sandbox-platform.env` | `SANDBOX_API_IMAGE`、`SANDBOX_WORKER_IMAGE` 及对应 `*_DEPLOYED_AT` |
| trade | `argocd/services/trade/sandbox-bj-7/trade-platform.env` | trade 镜像键 + 部署时间戳 |

```bash
# 在 mono2 的 gitops 分支工作树执行；改完提交推送（需用户放行）
git -C <gitops-worktree> add argocd/services/{ctl,sandbox,trade}/sandbox-bj-7/*.env
git -C <gitops-worktree> commit -m "deploy(sandbox-bj-7): pass same-SP modify"
git -C <gitops-worktree> push origin gitops
```

验证（不要只看 Argo 显示 Synced，要回读 revision 与镜像）：

```bash
argocd app get ctl-sandbox-bj-7   --refresh -o wide
argocd app get sandbox-sandbox-bj-7 --refresh -o wide
argocd app get trade-sandbox-bj-7 --refresh -o wide
kubectl --context "$KCTX" -n "$NS" get deploy -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[0].image}{"\n"}{end}'
```

预期：三个 app 的 `Revision` 等于刚推的 commit，状态 `Synced` + `Healthy`，Deployment 镜像等于新 digest。

回滚：把 env 文件 revert 成上一个 digest 再推 `gitops`（`selfHeal` 会自动收敛）。**不要用 `kubectl set image` 直接改**，selfHeal 会把它冲掉。

#### 步骤 4：录入 sandbox 资源池映射（若尚未录入）

按 §2.1 的 SQL 先回读；缺失的才补。bj-7 的目标是 `openclaw-4c8g80g` + `pool-bj7-4c8g80g` + `sku-hermes-4c8g`（`argocd/services/ctl/sandbox-bj-7/patch-ctl-conf-rewrite.yaml:46-51`）。

这一项**必须在放用户流量之前**完成：按 §2.1，`checkModify` 不调 sandbox，映射缺失不会在扣款前被拦下，用户会先付款再卡在 `modifying`。

回滚：删掉刚插入的 `template_pool_bindings` 行即可；`pools` / `template_classes` 若被其他链路引用不要删。

#### 步骤 5：seed 运营数据（最后一步）

```bash
mysql --host=127.0.0.1 --port=13306 --user=root --password \
  --database=trade_sandbox_bj_7 < scripts/seed_trade_modify_scene_category.sql
```

预期：末尾 SELECT 里 `bundle_cruise_01` 的 `scenes` 含 `modify`。脚本对已有 modify 的行幂等跳过，可重复执行。

回滚：仅测试环境需要撤销本次 seed 时执行
`scripts/rollback_trade_modify_scene_category.sql`。它只删除 scene/category 同时匹配的
单条记录；检测到重复 modify scene 时会拒绝自动删除，避免误伤既有运营数据。

四个测试/预发 CategoryID 均已回读并写入脚本。执行后必须检查汇总：当前站点的通用、
AI 两个 SP 都为 `READY`、`matched_rows=3`、`exact_modify_rows=3`、
`duplicate_modify_rows=0`；另一个站点的 SP 为 `NOT_PRESENT_IN_THIS_SITE`。

#### kr-1（国际站）要跳过哪些步骤

| 步骤 | kr-1 |
|---|---|
| 0 / 1 ctl 迁移 | 执行（该环境部署了 ctl） |
| 0 / 1 sandbox 迁移 | 执行；先实时回读当前版本，预期从 8 升到 9 |
| 2 trade 迁移 | 执行（该环境部署了 trade；Job 情况需另行回读，本仓库 `argocd/services/trade/sandbox-kr-1/` 下的清单与 bj-7 不同） |
| 3 部署镜像 | 发 Sandbox → CTL → Trade；发布方式先按运行态所属部署链路确认，不假设缺失的 GitOps overlay |
| 4 资源池映射 | 回读并补齐 `openclaw-4c8g80g`、`sku-hermes-4c8g`、`pool-kr-4c8g-01` 与绑定，确认可用 CLEAN 容量 |
| 5 seed | 执行，国际通用 `2025257`、国际 AI `2025272` 都必须得到 `READY` |

kr-1 的验收不能只停在零实例：国际通用和国际 AI 都要真实支付，并至少包含一条有实例的
停机、改配、扩盘、开机和资源池重绑闭环。

### 3.4 §3.1 之外的四处补充（本轮核查新增）

1. **本改动集含三份迁移，不是两份。** 除 ctl `000029` 与 sandbox `000009` 外还有 `trade/migrations/000009_add_modify_support`。三份编号在 `origin/master` 上都不存在（master 最高分别为 ctl 000028 / sandbox 000008 / trade 000008），无撞号。
2. **bj-7 的 trade 迁移 Job 没有被删除，但同样不会重跑。** `argocd/services/trade/sandbox-bj-7/kustomization.yaml:13` 把 `trade-migration-job.yaml` 作为 resource 引入，Job 名固定 `trade-migrate`、镜像 pin 在 `trade:trade-ecedf932d2b4`。Job 是不可变对象，名字不变 Argo 就不会重建，且该镜像里不含 000009。这与 ctl / sandbox 在 bj-7 被 `$patch: delete` 的机制不同，但结论相同：**要应用 trade 000009 得手工跑或同时改 Job 名与镜像。**
3. **bj-7 的 ctl 没有 rewrite `[adapter.trade].base_url`。** kr-1（`argocd/services/ctl/sandbox-kr-1/patch-ctl-conf-rewrite.yaml:93-94`）和 sgprod 都显式写了，bj-7 的 `patch-ctl-conf-rewrite.yaml` 里没有该段；`ctl/conf/server/common/server_conf.toml:284-287` 的默认值是空串。它可能由 SOPS 加密的 `ctl-conf-common` 覆盖（本地无法解密核对），**联调前必须在 bj-7 的运行 Pod 里回读实际生效值**，否则 ctl 侧调 trade 的链路会打到空地址：

```bash
kubectl --context "$KCTX" -n "$NS" exec deploy/ctl -- \
  sh -c 'grep -A4 "\[adapter.trade\]" /path/to/server_conf.toml'
```

4. **目标套餐的 VelaGW Plan 必须处于 active。** `velagw/internal/gateway/service.go:1417-1420`：目标 Plan 不 active 且没有可复用唯一订阅时直接返 `ErrPlanNotFound`。这一项不在 §2 的前置表里，联调前需回读 `ctl.bundle.ai_gateway_plan_id`（巡游 / 巡游 AI）对应的 Plan 在目标环境 newapi 侧是否 active。

## 四、联调步骤

前置：目标 pass 处于 `active`、套餐为 `bundle_launch_01`、名下实例都在稳定态（非 creating / pausing / modifying）。

环境选择见 §3.1.1：bj-7 与 kr-1 都必须先完成运行态前置回读；两边都要覆盖实例收敛，不能用另一站点的有实例结果替代。

**0. 用户侧入口（前端走这条；下面 1-2 步是它内部调的 trade 内部 RPC）**

```bash
# 可变配套餐 + 实时差价。不传 target_bundle_id，服务端按当前 pass 推导合法目标。
curl -s "$CTL/v1/passes/$PASS_ID/modify/bundles" -H "X-User-Id: $USER_ID"

# 建单 + 代扣（联调；生产前端走 modify/order-url 拿支付页）
curl -s -X POST "$CTL/v1/passes/$PASS_ID/modify/order-and-pay" \
  -H "X-User-Id: $USER_ID" -H 'Content-Type: application/json' \
  -d '{"target_bundle_id":"bundle_cruise_01"}'
```

`modify/bundles` 返回 `source_bundle_id` + `modify_bundle_set[]`，每项含 `target_bundle_id`、`bundle`（cpu / memory / system_disk_size / credit）和 `modify_price` 六字段；国际站 `currency=USD` 且 `tax_price` 非零。pass 不在 `active` 或无升配路径时返回空数组而不是报错。

**1. 询价（trade 内部 RPC，直连排障用）**

```bash
curl -s -X POST "$TRADE/internal/trade/inquiry/modify" \
  -H "Authorization: Bearer $TRADE_INTERNAL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "externalUserId": "usr_xxx",
    "uin": "<uin>",
    "appId": "<appId>",
    "resourceId": "<passId>",
    "sourceBundleId": "bundle_launch_01",
    "targetBundleId": "bundle_cruise_01",
    "curDeadline": "2026-10-01 12:00:00",
    "payMode": 1
  }'
```

期望：`prices[0].real_total_cost` 是差价（不是巡游全价）。`curDeadline` 必须与 `ctl.pass.expired_time` 严格一致（北京时间字面值），否则计费按 `checkModify` 口径判到期时间漂移。

**2. 下单 + 支付**

联调用一体化端点省掉跳收银台：

```bash
curl -s -X POST "$TRADE/internal/trade/orders/modify/place-and-pay" \
  -H "Authorization: Bearer $TRADE_INTERNAL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '<同上 body>'
```

生产链路走两步式 `POST /internal/trade/orders/modify` + 现有 pay-url 端点。

**3. 观察回调与受理**

```sql
-- trade 库：modifyResource 受理后 flow 仍应为 in_progress；订单为 paid_pending_provision
SELECT id, deal_name, flow_type, status, resource_id, created_time
FROM trade_flow WHERE deal_name = '<dealName>';
SELECT deal_name, order_type, status, resource_id
FROM trade_order WHERE deal_name = '<dealName>';

-- ctl 库：pass 进入 modifying，且 modify_flow_id 等于上面的 flow id
SELECT pass_id, status, bundle_id, modify_flow_id, modify_target_bundle_id
FROM pass WHERE pass_id = '<passId>';
```

**4. 观察实例收敛**

```sql
-- sandbox 库：每台实例一条台账
SELECT idempotency_key, sandbox_id, status, current_step, target_pool_id, updated_at
FROM modify_operations WHERE sandbox_id IN (...);
```

单台耗时主要在腾讯云侧的停机 → 改配 → 扩盘 → 开机，十几分钟量级；多实例串行。

**5. 终态核对**

```sql
-- ctl：pass 回 active + bundle 切到目标 + agent_quota 提到目标额度
SELECT pass_id, status, bundle_id, modify_flow_id FROM pass WHERE pass_id = '<passId>';
-- trade：只有 ctl 完成回调后，flow/order 才同时进入终态
SELECT status FROM trade_flow WHERE id = <flowId>;
SELECT status, resource_id FROM trade_order WHERE deal_name = '<dealName>';
```

同时确认 VelaGW 订阅已切到目标 Plan（巡游 200 / 巡游 AI 10000 额度按替换语义直接生效，源套餐周期内已用积分不做差值扣减，独立赠送的 `free-credit:*` 不受影响）。

## 五、故障处理

| 现象 | 定位 | 处理 |
|---|---|---|
| 询价报 `category_ids[scene=modify]` | 运营数据缺失 | 执行 seed 脚本 |
| 询价/下单报 `ModifyCrossSubProduct` (422) | 源与目标不同 SP | 本期只支持同 SP，非缺陷 |
| `checkModify` 返 600803 | goodsDetail 与 `trade_bundle_definition` 对不上 | 看 returnMessage 里的具体 sv key；通常是运营改了 SV 未同步计费接入单 |
| `checkModify` 返 600804 | ctl 判定不可变配 | 查 pass 状态、套餐升配关系、实例是否稳定态 |
| `modifyResource` 返 352014 | A 类永久不可发货，计费会退款 | 看 ctl 日志确认是状态、套餐关系还是实例未就绪 |
| `modifyResource` 返 60090x | B 类，计费会重投 | 通常是 ctl/DB 抖动，观察下一轮 |
| `trade_flow` 长期 in_progress / 订单停在 `paid_pending_provision` | ctl 父 task未收敛或完成回调失败 | reconcile worker 超过 6h 打 `modify_resource_alert`；检查 CTL 父/子 task、Sandbox operation 与 `/internal/trade/flows/{id}/complete` 重试 |
| 实例卡 `MODIFYING` | 云侧改配失败 | **没有自动回滚**：系统盘扩容不可逆，只能前向重试；stale 清理规则刻意不扫 MODIFYING |

**没有回滚路径**是这条链路和续费最本质的差别：扩盘之后回不去启航规格。因此 trade 的 reconcile 只告警不 markFailed，sandbox 的 stale 清理不碰 MODIFYING，全链路按"前向收敛"设计。

## 六、并发与幂等

- 同一笔单重投 `modifyResource`：`trade_flow` 唯一键 `(deal_name, flow_type, app_id)` 抢占，赢家受理，输家按 flow 状态回放或让计费退避。
- 另一笔单插队：ctl 用 `pass.modify_flow_id` 区分——不是本 flow 时返 4xx，trade 翻译成退款而不是抢占别人的状态机。
- 实例级：sandbox `modify_operations.idempotency_key` = ctl 子 task id，重投直接读台账续跑而不是重新停机。
- 子 task 耗尽重试窗口后，ctl 父 task 会用**新的 task id**（= 新幂等键）重派。此时 sandbox 侧账本通常还在 `running`（它的 stale 预算更长），新一轮会**认领**在跑的那份账本继续前滚，一台实例始终只有一份 `running` 账本。若目标池不同则返 409 `MODIFY_OPERATION_CONFLICT`，不并行改同一台机器。
- ctl 父 task 的完成判定只看每个实例**最新**那次派发：重派留下的历史失败子 task 不再阻塞权益提交，否则 pass 会永久停在 `modifying`。
- ctl 父 task：`pass.status = active && bundle_id = target` 时短路补回调并终态成功。

排查提示：一台实例出现多份 `running` 账本属于异常（本设计不应产生），按 `started_at` 最早的那份为准继续观察，其余需人工核对后收尾。

```sql
SELECT instance_id, COUNT(*) FROM modify_operations
WHERE status = 'running' GROUP BY instance_id HAVING COUNT(*) > 1;
```

## 七、上线前门禁与遗留事项

| 状态 | 事项 |
|---|---|
| [x] | 四个测试/预发 Modify CategoryID 已从接入单回读并固化到 seed 脚本；生产仍未发布 |
| [ ] | 完成本地全量 test/vet/race、三份 migration up/down、seed/重复 seed/rollback/重复 scene 拒绝误删、Kustomize/contract/change-impact 门禁 |
| [ ] | bj-7 升到 CTL 29 / Sandbox 9 / Trade 9，部署三服务，seed 国内通用/AI，并完成零实例、有实例真实支付闭环；仅在实际 Pass 配额与产品模型支持多实例时增加多实例用例 |
| [ ] | kr-1 升到 CTL 29 / Sandbox 9 / Trade 9，部署三服务，修正并激活 `pool-kr-4c8g-01` 容量，seed 国际通用/AI，并完成零实例与有实例真实支付闭环 |
| [ ] | 为 kr-1 补齐 Sandbox 的正式测试环境声明/部署归属；当前运行态与本仓库 GitOps catalog 不一致（见 §3.1.1） |
| [x] | 本期后端暗发，不做前端页面；保留 `/v1/passes/{pass_id}/modify/*` API，其中 `order-and-pay` 仅联调/e2e 使用 |
| [ ] | bj-7 的 ctl 实际生效的 `[adapter.trade].base_url` 需在 Pod 内回读确认（本仓库 rewrite 未写该段，common 为 SOPS 加密，见 §3.4） |
| [ ] | 常驻环境部署时把 trade 的 `trade-migrate` Job 名与镜像一并 bump，或明确记录手工执行（见 §3.4） |
| [ ] | 回读巡游 / 巡游 AI 的 `ai_gateway_plan_id` 在目标环境 newapi 侧是否 active（见 §3.4） |
| [ ] | 四个 CategoryID 的生产变更单正式发布并完成预付费财管审批；此前严禁生产 seed |
| [ ] | 国内生产先灰度并观察至少 24 小时；告警、订单/flow、Pass/实例/权益无异常后，再单独评估国际站生产发布 |
| [ ] | 联调通过后再评估是否放开降配与跨 SP（当前 `allowedModifyTargets` 只有两条升配边） |
