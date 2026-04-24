# Sandbox Pool 镜像切换

本文档只保留当前推荐流程。当前测试环境的 pool rollout API 已删除，因此不再保留任何基于 `sandbox-api` 或 `update-image.sh` 的运维路径。

权威入口：

- 发布与 rollout： [docs/deploy-guides/sandbox-deploy-guide.md](../deploy-guides/sandbox-deploy-guide.md)
- `sandbox` 运维规则： [docs/agent-guides/sandbox-agent-guide.md](../agent-guides/sandbox-agent-guide.md)

## 1. 标准入口

当前唯一标准入口：

- `.codebuddy/skills/sandbox-ops` 的 MySQL fallback

处理原则：

- 直接更新 `pools.base_image`
- 只把当前 `CLEAN` 库存标成 `DRY`
- 已被业务占用的 `ALLOCATED` 实例不强改

查看当前 pool：

```bash
# 在仓库根目录下执行
source deploy/envs/beijing-sandbox/platform.env
KUBECONFIG="${DEPLOY_KUBECONFIG}" \
  bash .codebuddy/skills/sandbox-ops/scripts/query_pool_status.sh 'pool-%'
```

默认滚动 CTL 在用池（全量）：

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

当前测试环境默认池集合取自 `ctl/conf/test/rewrite/server_conf_rewrite.toml` 的 `default_template_id + candidate_template_ids`，即 `pool-c0~pool-c5`。

扩展切换所有 pool（含 `pool-bj8`）：

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

## 2. 最低检查项

执行 rollout 前后，至少确认：

- 目标 pool 的 `base_image` 已变更
- `DRY` / `RESETTING` 最终归零
- `CLEAN` 库存恢复
- `ALLOCATED` 旧实例未被强改

## 3. 明确禁止

- 不要再试 `GET /pools`
- 不要再试 `PATCH /pools/{poolID}`
- 不要再试 `sandbox/scripts/update-image.sh`
- 不要把 `ALLOCATED`、`RESETTING` 等其他状态手改成 `DRY`
- 不要把一次性的现场命令沉淀成与当前入口冲突的长期文档
