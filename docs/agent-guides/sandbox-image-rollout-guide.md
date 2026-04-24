# Sandbox 镜像切换指引

本文件描述 `sandbox` 测试/现网环境切换 `base_image` 的标准做法。凡是涉及：

- 新镜像 ID 生效
- pool `base_image` 切换
- bootstrap 镜像更新
- 运行态库存回填

Agent 都应先阅读本文件。

## 1. 核心原则

- 运行态真实信源是 `pools.base_image`
- 当前测试环境的 pool rollout API 已删除；不要再尝试 `GET /pools`、`PATCH /pools/{id}` 或 `sandbox/scripts/update-image.sh`
- pool 镜像切换统一走 SQL fallback
- fallback 语义必须保持为：只更新目标 pool 的 `base_image`，并只把 `CLEAN` 实例标成 `DRY`
- `ALLOCATED` 不应被强切
- `ConfigMap` 不再作为运行态 `base_image` 兜底
- `sandbox-db-init` 的 `SANDBOX_BOOTSTRAP_BASE_IMAGE` 只用于初始化建池，不是运行时真相源
- pool 名称不一定代表真实地域；例如 `shprod` 里的 `pool-bj8` 只是历史命名，是否在上海创建要看 `pools.zone`

一句话：

- 新建/重装实例看 pool 的 `base_image`
- 不再看任何历史 rollout API 或 `SANDBOX_BASE_IMAGE`

## 2. 当前代码约束

相关文件：

- [sandbox/internal/service/pool.go](../../sandbox/internal/service/pool.go)
- [sandbox/k8s/base/manifests.yaml](../../sandbox/k8s/base/manifests.yaml)
- [docs/agent-guides/sandbox-agent-guide.md](sandbox-agent-guide.md)

当前已经收敛成：

- `CreatePool` 必须显式传 `base_image`
- `UpdatePool` 把 `base_image` 改空会直接报错
- 不再回退到代码里的默认镜像
- `sandbox-runtime-config` 不应再包含 `SANDBOX_BASE_IMAGE`

## 3. 正确切换顺序

### Step 1: 确认镜像可用

腾讯云侧先确认目标镜像存在且是 `NORMAL`：

```bash
tccli cvm DescribeImages \
  --region ap-beijing \
  --ImageIds '["img-xxxx"]' \
  --output json
```

至少确认：

- `ImageId` 正确
- `ImageState = NORMAL`
- 地域与集群一致

上海 `shprod` 示例：

```bash
tccli cvm DescribeImages \
  --region ap-shanghai \
  --ImageIds '["img-xxxx"]' \
  --output json
```

### Step 2: 更新仓库里的 bootstrap 镜像

修改：

- [sandbox/k8s/base/manifests.yaml](../../sandbox/k8s/base/manifests.yaml)

把：

- `SANDBOX_BOOTSTRAP_BASE_IMAGE`

改成新镜像 ID。

注意：

- 这一步不是让现网立刻切镜像
- 它只是保证后续重建池/初始化环境时不会回到旧镜像

### Step 3: 默认切运行态 CTL 在用池（全量）

```bash
# 在仓库根目录下执行
source deploy/envs/beijing-sandbox/platform.env
KUBECONFIG="${DEPLOY_KUBECONFIG}" \
  kubectl -n sandbox run mysql-rollout --image=mysql:8.0 --rm -i --restart=Never -- \
  mysql -h 10.15.224.4 -P 3306 -u root -p'***' cvm -e "
  START TRANSACTION;
  UPDATE pools
  SET base_image='img-xxxx'
  WHERE id IN ('pool-c0','pool-c1','pool-c2','pool-c3','pool-c4','pool-c5') AND base_image <> 'img-xxxx';
  UPDATE instances
  SET state='DRY', updated_at=UTC_TIMESTAMP()
  WHERE pool_id IN ('pool-c0','pool-c1','pool-c2','pool-c3','pool-c4','pool-c5') AND state='CLEAN';
  COMMIT;
  "
```

这个 fallback 的约束必须保持一致：

- 只更新目标 pool 的 `base_image`
- 只把 `CLEAN` 改成 `DRY`
- 不修改 `ALLOCATED`

默认池集合来源：

- `ctl` 配置中的 `default_template_id + candidate_template_ids`
- 当前测试环境按 `ctl/conf/test/rewrite/server_conf_rewrite.toml` 收敛为 `pool-c0~pool-c5`
- `shprod` 也可从 `ctl/k8s/overlays/shprod/generated/rewrite/server_conf_rewrite.toml` 核对当前 bot/CTL 候选池

### Step 4: 如需扩展，覆盖非 CTL 池

如果现场确认 `pool-bj8` 也承载 CTL 流量，或用户明确要求“所有 pool 一起切”，再一次性覆盖 `pool-bj8,pool-c0,pool-c1,pool-c2,pool-c3,pool-c4,pool-c5`：

```bash
# 在仓库根目录下执行
source deploy/envs/beijing-sandbox/platform.env
KUBECONFIG="${DEPLOY_KUBECONFIG}" \
  kubectl -n sandbox run mysql-rollout-all-pools --image=mysql:8.0 --rm -i --restart=Never -- \
  mysql -h 10.15.224.4 -P 3306 -u root -p'***' cvm -e "
  START TRANSACTION;
  UPDATE pools
  SET base_image='img-xxxx'
  WHERE id IN ('pool-bj8','pool-c0','pool-c1','pool-c2','pool-c3','pool-c4','pool-c5')
    AND base_image <> 'img-xxxx';
  UPDATE instances
  SET state='DRY', updated_at=UTC_TIMESTAMP()
  WHERE pool_id IN ('pool-bj8','pool-c0','pool-c1','pool-c2','pool-c3','pool-c4','pool-c5')
    AND state='CLEAN';
  COMMIT;
  "
```

### Step 5: 校验目标 pool

至少核：

- 目标 pools 的 `base_image` 已变成新值
- `CLEAN` 会逐步转成 `DRY/RESETTING` 再回到 `CLEAN`
- `ALLOCATED` 不会被强切
- 如果本次镜像改动涉及微信登录协议，还要继续做 fresh sandbox 端到端烟测；只看到 `base_image` 已更新不算验收完成

全量核对时不要只看 `pool-c0~pool-c5`，应查所有 `pool-%`：

```sql
SELECT id, base_image, desired_capacity, instance_type, zone
FROM pools
WHERE id LIKE 'pool-%'
ORDER BY id;

SELECT base_image, COUNT(*) AS pool_count
FROM pools
WHERE id LIKE 'pool-%'
GROUP BY base_image
ORDER BY base_image;
```

## 4. 推荐命令

### 查看当前 pools

```bash
# 在仓库根目录下执行
source deploy/envs/beijing-sandbox/platform.env
KUBECONFIG="${DEPLOY_KUBECONFIG}" \
  bash .codebuddy/skills/sandbox-ops/scripts/query_pool_status.sh 'pool-%'
```

### fallback 更新 CTL 在用池（默认）

```bash
# 在仓库根目录下执行
source deploy/envs/beijing-sandbox/platform.env
KUBECONFIG="${DEPLOY_KUBECONFIG}" \
  kubectl -n sandbox run mysql-rollout --image=mysql:8.0 --rm -i --restart=Never -- \
  mysql -h 10.15.224.4 -P 3306 -u root -p'***' cvm -e "
  START TRANSACTION;
  UPDATE pools
  SET base_image='img-xxxx'
  WHERE id IN ('pool-c0','pool-c1','pool-c2','pool-c3','pool-c4','pool-c5') AND base_image <> 'img-xxxx';
  UPDATE instances
  SET state='DRY', updated_at=UTC_TIMESTAMP()
  WHERE pool_id IN ('pool-c0','pool-c1','pool-c2','pool-c3','pool-c4','pool-c5') AND state='CLEAN';
  COMMIT;
  "
```

### fallback 全量更新

```bash
# 在仓库根目录下执行
source deploy/envs/beijing-sandbox/platform.env
KUBECONFIG="${DEPLOY_KUBECONFIG}" \
  kubectl -n sandbox run mysql-rollout-all-pools --image=mysql:8.0 --rm -i --restart=Never -- \
  mysql -h 10.15.224.4 -P 3306 -u root -p'***' cvm -e "
  START TRANSACTION;
  UPDATE pools
  SET base_image='img-xxxx'
  WHERE id IN ('pool-bj8','pool-c0','pool-c1','pool-c2','pool-c3','pool-c4','pool-c5')
    AND base_image <> 'img-xxxx';
  UPDATE instances
  SET state='DRY', updated_at=UTC_TIMESTAMP()
  WHERE pool_id IN ('pool-bj8','pool-c0','pool-c1','pool-c2','pool-c3','pool-c4','pool-c5')
    AND state='CLEAN';
  COMMIT;
  "
```

### 单独重置现有 CLEAN 库存

如果镜像已经切完，但还需要让现有可分配库存重新按新镜像重装，可以单独把目标 pool 的 `CLEAN` 标成 `DRY`。仍然不要改 `ALLOCATED`：

```bash
# 在仓库根目录下执行
source deploy/envs/<env>/platform.env
KUBECONFIG="${DEPLOY_KUBECONFIG}" \
  kubectl -n sandbox run mysql-reset-clean --image=mysql:8.0 --rm -i --restart=Never -- \
  mysql -h "${SANDBOX_MYSQL_HOST}" -P "${SANDBOX_MYSQL_PORT}" -u root -p'***' cvm -e "
  START TRANSACTION;
  UPDATE instances
  SET state='DRY', updated_at=UTC_TIMESTAMP()
  WHERE pool_id LIKE 'pool-%' AND state='CLEAN';
  SELECT ROW_COUNT() AS clean_instances_marked_dry;
  COMMIT;
  "
```

执行后用 worker 日志确认 reset 已接手：

```bash
KUBECONFIG="${DEPLOY_KUBECONFIG}" \
  kubectl -n sandbox logs statefulset/sandbox-worker-sharded --since=5m --tail=200
```

### 微信协议 smoke

如果本次切镜像的目标包含：

- `openclaw-weixin-login-session`
- weixin 插件版本
- 二维码解析逻辑
- `openclaw` wrapper / heap 策略

建议在 pool 回填出足够 `CLEAN` 后继续执行：

```bash
# 在仓库根目录下执行
source deploy/envs/beijing-sandbox/platform.env
KUBECONFIG="${DEPLOY_KUBECONFIG}" kubectl port-forward -n ctl svc/ctl-api 19590:80
```

另开一个终端：

```bash
# 在仓库根目录下执行
python3 ctl/scripts/tests/smoke-openclaw-weixin-qr-testenv.py \
  --base-url http://127.0.0.1:19590
```

预期至少通过：

- `PASS: wait-weixin-qr`
- `PASS: cancel-weixin-session`
- `PASS: delete-instance`

## 5. 已知坑点

### 5.1 不要再试已删除的 rollout API

当前处理原则：

- 不要再探测 `GET /pools`
- 不要再尝试 `PATCH /pools/{id}`
- 不要再重试 `sandbox/scripts/update-image.sh`
- 直接切到 `.codebuddy/skills/sandbox-ops` 的 SQL fallback

### 5.2 不要把 `SANDBOX_BASE_IMAGE` 当现网真相源

即使某些 Pod 环境里还能看到这个变量，也不应该再依赖它判断现网镜像。

应优先看：

- `pools.base_image`

### 5.3 `SANDBOX_BOOTSTRAP_BASE_IMAGE` 不是运行态信源

它只影响：

- 初始化建池
- 环境重建后的默认种子值

不影响已经存在的 pool。

### 5.4 `pool-bj8` 不代表北京地域

不要从 pool 名称推断创建地域。以 `pools.zone`、`pools.subnet_id`、`pools.vpc_id` 为准：

```sql
SELECT id, base_image, vpc_id, subnet_id, zone, instance_type, desired_capacity
FROM pools
WHERE id='pool-bj8';
```

在 `shprod` 中，`pool-bj8` 可能实际绑定 `ap-shanghai-*` 可用区。

### 5.5 本地 kubeconfig 可能指向过期 CLB 域名

如果 `deploy/envs/shprod/platform.env` 中的 `DEPLOY_KUBECONFIG` 报 CLB 域名解析失败，可临时从 TKE 拉取最新公网 kubeconfig，再用临时文件执行运维命令。不要为了单次操作直接改 `.secret/`：

```bash
umask 077
tccli tke DescribeClusterKubeconfig \
  --region ap-shanghai \
  --ClusterId cls-a0ol7bit \
  --IsExtranet true \
  --output json | jq -r .Kubeconfig > /tmp/shprod-kubeconfig

KUBECONFIG=/tmp/shprod-kubeconfig kubectl -n sandbox get deploy sandbox-api
rm -f /tmp/shprod-kubeconfig
```

## 6. Review Checklist

- 是否修改了 [sandbox/k8s/base/manifests.yaml](../../sandbox/k8s/base/manifests.yaml) 的 bootstrap 镜像
- 是否避免继续引导人去试已删除的 rollout API
- 若走 fallback，是否严格保持了 `base_image` 更新 + `CLEAN -> DRY` 语义
- 是否确认了目标镜像在腾讯云侧 `NORMAL`
- 是否核实了目标 pool 的 `base_image` 全部更新
- 是否用 `pools.zone` 核对了真实地域，避免被历史 pool 名称误导
