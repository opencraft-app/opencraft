# 北京新后端测试环境创建记录（`beijing-sandbox-2`）

这份文档沉淀的是一次**真实跑通**的“在北京新增一套后端测试环境”的过程。

目标不是写一份理想化方案，而是保留：

- 这次到底做了什么
- 为什么这么做
- 实际踩了哪些坑
- 哪些结论后续可以直接复用

本文默认读者是：

- 需要继续新增北京测试环境的工程 agent / 同学
- 需要理解 `infra_pulumi` 能力边界的人
- 需要在 GitOps / Argo 之前先把基础设施起出来的人

---

## 1. 本次目标

本次创建目标是：

- 新环境名：`beijing-sandbox-2`
- 类型：北京第二套后端测试环境
- 优先级：**先把基础设施起出来**
- 明确取舍：**先接受公网 TKE endpoint**，暂不要求香港控制面的私网接入

这次刻意没有追求“一次性把所有外围链路都做满”。

原因：

- 私网控制面接入依赖 `connectivity` / `PrivateLink`
- 当前更关键的是先验证 `infra_pulumi` 是否能独立再起一套北京环境
- 对测试环境而言，公网 TKE endpoint 足够支撑第一阶段接入和后续 GitOps 补齐

---

## 2. 这次实际改了什么

核心新增文件：

- `infra_pulumi/Pulumi.beijing-sandbox-2.yaml`
- `infra_pulumi/envs/tencentcloud/beijing-sandbox-2/inventory.yaml`
- `deploy/envs/beijing-sandbox-2/README.md`
- `deploy/envs/beijing-sandbox-2/secrets.example.env`

为了让这次创建真正跑通，还补了一处通用能力：

- `infra_pulumi/pkg/config/inventory.go`
- `infra_pulumi/pkg/components/storage/storage.go`

新增的能力是：

- 允许在 inventory 中设置 `stacks.storage.manage_cam_access=false`
- 当当前凭据**不具备创建 CAM user 的权限**时，仍然可以：
  - 创建 COS bucket
  - 输出 bucket 名称
  - 跳过 CAM user / policy attachment / access key

这不是“北京二号环境专属 hack”，而是一次真实的权限边界收敛：

- 某些临时或受限云凭据可以建基础设施
- 但不一定允许新建 CAM 用户
- 这时不应该让整个环境创建流程被 COS 辅助账号卡死

---

## 3. 本次配置上的关键取舍

### 3.1 先不开 `connectivity`

本次 `beijing-sandbox-2` 的 inventory **没有开启** `stacks.connectivity`。

原因：

- 这次目标是“先把环境起出来”
- 私网控制面接入不是第一阶段阻塞项
- 现有 `connectivity` 路径更适合后续专项补齐，而不是一开始就绑定到新环境创建成功与否

实际效果：

- 新环境依赖公网 TKE endpoint
- `infractl sync` 能正常回写 kubeconfig
- 后续仍可在需要时再补私网接入

### 3.2 节点池规模先按测试环境收小

这次没有沿用现有北京环境的大节点池规模。

本次先用了：

- `node_pool_min_size: 1`
- `node_pool_desired_capacity: 3`
- `node_pool_max_size: 10`

原因：

- 这是一套测试环境
- 初始目标是验证环境骨架，而不是立即承载高并发
- 先用小规模更省配额，也更容易发现真正的环境创建阻塞点

### 3.3 EIP 数量不要默认照搬老环境

第一次尝试时，primary EIP 配了 10 个，随后触发了：

- `AddressQuotaLimitExceeded`

中间先把 `primary_eips` 收到 9 个让环境继续推进，后续又进一步收到了 **1 个 primary EIP** 作为测试环境默认值。

这次的经验结论是：

- **测试环境不要默认照抄老环境的 EIP 数量**
- 如果只是后端联调或低并发验证，1 个 primary EIP 通常都够，而且应优先把它当成默认值
- 后续真的需要更高并发或更复杂的 NAT 出口策略，再增配

---

## 4. 本次实际遇到的问题

### 4.1 CAM User 创建被权限拒绝

首次 `up` 时报错：

- `FailedOperation.ForbidAdd`
- `operation deny | add user failed`

实际触发点：

- `storage` 组件在创建 COS bucket 的同时，还会创建 CAM user
- 本次使用的临时腾讯云凭据不足以新增 CAM user

处理方式：

1. 给 inventory 增加 `stacks.storage.manage_cam_access: false`
2. 在 `infra_pulumi` 中补充通用开关
3. 让这类环境在权限不足时只创建 bucket，不阻断主流程

经验结论：

- “能建云资源”和“能建 CAM 用户”在权限上不是一回事
- 新环境流程不应默认把二者绑定成一个原子动作

### 4.2 EIP 配额不足

第二个明显问题是：

- `AddressQuotaLimitExceeded`

含义很直接：

- 当前账号没有足够的 EIP 配额继续按原计划创建第 10 个 primary EIP

处理方式：

- 将 `primary_eips` 从 10 收到 9

经验结论：

- 新环境第一次创建时，优先按“最小可运行”而不是“历史最大值”去配额
- 尤其是 EIP、节点池规模这类会直接碰配额上限的资源

### 4.3 TKE Addon 第一次 `up` 停在 `Upgrading`

在大部分核心资源都创建成功后，`tke-log-agent` 和 `tcr` 这两个 addon 首次 apply 没有立即进入终态，而是报：

- `create kubernetes addon status is Upgrading`

这里的关键经验不是“它坏了”，而是：

- **这更像云侧收敛慢，而不是配置错误**

处理方式：

1. 先执行 `sync`
2. 确认核心环境输出已经可用
3. 再执行一轮小的 `preview / up`

结果：

- 第二轮 apply 中两个 addon 都正常收敛

经验结论：

- TKE 新集群刚建完时，addon 进入 `Upgrading` 并不罕见
- 不要第一时间把它当成“整套环境失败”
- 先区分：
  - 核心基础设施是否已可用
  - addon 是否只是还在云侧收敛

---

## 5. 本次已验证完成的结果

以下内容已经真实跑通：

- `infra_pulumi` 成功创建 `beijing-sandbox-2`
- VPC / 子网 / NAT / SNAT / EIP 已落地
- TKE cluster / node pool / scale worker 已落地
- CynosDB / 两套 Redis / TCR / CLS / jumpserver 已落地
- TKE 公网 endpoint 最终创建成功
- `deploy/envs/beijing-sandbox-2/platform.env` 已回写
- `.secret/cls-ftjhqdjt-config` 已生成

本次环境的关键结果：

- 环境名：`beijing-sandbox-2`
- `env_short`: `bj82`
- TKE Cluster ID：`cls-ftjhqdjt`
- TKE Cluster Name：`tke-bj82`
- VPC ID：`vpc-b94qlrqe`

说明：

- 上面这些 ID 允许记录在仓库文档中
- 但不要把 `platform.env` 或 kubeconfig 明文提交到 Git

---

## 6. 本次未闭环的部分

下面这些这次**没有**一起做完：

- 业务域名仍是占位值：
  - `https://api-bj82.lightclaw.tech`
  - `https://admin-bj82.lightclaw.tech`
  - `https://bj82.lightclaw.pages.dev`
- `argocd/apps/beijing-sandbox-2/` 还没补
- 各服务 `argocd/services/*/beijing-sandbox-2/` 还没补
- 由于设置了 `manage_cam_access=false`：
  - 这套环境当前没有由 infra 自动创建的专用 CAM user / access key

这几项必须明确标记为“未闭环”，不要误以为“环境创建完成”等于“整套发布链路已完成”。

---

## 7. 可直接复用的执行顺序

如果后续再新建一套北京测试环境，建议沿用这个顺序：

1. 在 `infra_pulumi` 新增 stack 配置和 inventory
2. 默认先不开 `connectivity`
3. 节点池和 EIP 先按测试规模收小
4. 先跑：
   - `GOWORK=off go build ./...`
   - `GOWORK=off go run ./cmd/infractl preview --stack <env>`
5. 如果遇到权限边界：
   - 判断是否需要 `stacks.storage.manage_cam_access=false`
6. 如果遇到 EIP / 机器 / NAT 配额问题：
   - 先缩规模，不要先扩配额
7. `up` 成功后立刻执行：
   - `GOWORK=off go run ./cmd/infractl sync --stack <env>`
8. 把 `platform.env` 和 kubeconfig 路径确认清楚
9. 再进入 Argo / GitOps 清单补齐阶段

---

## 8. 这次最值得保留的经验

一句话总结：

> 新建后台测试环境时，先把目标收敛到“最小可运行后端环境”，不要一开始就把私网控制面、CAM 辅助账号、超额 EIP、完整 GitOps 链路全部绑成同一次成功条件。

具体到这次：

- 先接受公网 TKE endpoint
- 遇到 CAM 权限不足，就让 COS 辅助账号创建变成可选项
- 遇到 EIP 配额不足，就先缩到测试环境真正需要的数量
- 遇到 addon `Upgrading`，先分辨是“环境没起来”还是“云侧还在收敛”

这套思路让 `beijing-sandbox-2` 最终能真正落地，而不是停在“方案看起来很完整，但一次都没跑通”。
