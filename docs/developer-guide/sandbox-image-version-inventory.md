# Sandbox Image Version Inventory

本文档记录 `sandbox` 已构建镜像的版本台账，以及测试环境 pool 当前实际绑定的镜像。  
更新原则：

- 产出新镜像后，补充到“已构建镜像”表
- rollout pool 后，更新“当前 pool 绑定镜像”表
- 所有“当前”状态都必须带查询日期

<!-- AUTO-LATEST-START -->
## 0. 当前最新镜像 ID

> 本段由 `images/build-image.py` 在成功制镜后自动维护。

- 当前稳定 `base`（ap-seoul）：`img-id352nof`
- 当前最新已构建 app（ap-seoul）：`img-gy7rrhst`
- 当前最新已构建 app（ap-beijing）：`img-qyjes9jb`
- 当前默认构建版本：`openclaw 2026.3.24` + `qqbot 1.6.6` + `weixin 2.1.1`
- 当前主力池生效镜像请看本文第 2 节，不由构镜脚本自动改写。
- 最近自动更新时间：`2026-04-02T17:44:55+08:00`
<!-- AUTO-LATEST-END -->

## 1. 已构建镜像

说明：

- 本节只记录当前仍保留、且后续排障或 rollout 还可能用到的镜像
- `2026-03-27` 已做过一次首尔/北京 `lightclaw*` 历史镜像清理，旧的中间产物已删除

### 基础镜像

| 日期 | 地域 | 镜像 ID | 镜像名 | 说明 |
|------|------|---------|--------|------|
| 2026-03-25 | ap-seoul | `img-id352nof` | `lightclaw-base-20260325-220553` | 当前稳定 `base` 镜像；Ubuntu 24.04 基座，包含 envd、Node、Python、Playwright，不含 OpenClaw |

### 应用镜像

| 日期 | 地域 | 镜像 ID | 镜像名 | OpenClaw | 默认插件 | 说明 |
|------|------|---------|--------|----------|----------|------|
| 2026-04-02 | ap-beijing | `img-qyjes9jb` | `lightclaw-2026.3.24-20260402-174106` | `2026.3.24` | `qqbot@1.6.6`, `weixin@2.1.1` | 自动记录：由 `build-image.py` 同步到 ap-beijing；source=`img-gy7rrhst` |
| 2026-04-02 | ap-seoul | `img-gy7rrhst` | `lightclaw-2026.3.24-20260402-174106` | `2026.3.24` | `qqbot@1.6.6`, `weixin@2.1.1` | 自动记录：由 `build-image.py` 成功构建；verify=none |
| 2026-03-30 | ap-beijing | `img-8rbe0qqz` | `lightclaw-2026.3.24-20260330-230538` | `2026.3.24` | `qqbot@1.6.6`, `weixin@2.1.1` | 自动记录：由 `build-image.py` 同步到 ap-beijing；source=`img-rtlfc29d` |
| 2026-03-30 | ap-seoul | `img-rtlfc29d` | `lightclaw-2026.3.24-20260330-230538` | `2026.3.24` | `qqbot@1.6.6`, `weixin@2.1.1` | 自动记录：由 `build-image.py` 成功构建；verify=runtime,weixin-login |
| 2026-03-30 | ap-beijing | `img-l54ntw81` | `lightclaw-2026.3.24-20260330-165115` | `2026.3.24` | `qqbot@1.6.6`, `weixin@2.1.1` | 自动记录：由 `build-image.py` 同步到 ap-beijing；source=`img-5vppx4t5` |
| 2026-03-30 | ap-seoul | `img-5vppx4t5` | `lightclaw-2026.3.24-20260330-165115` | `2026.3.24` | `qqbot@1.6.6`, `weixin@2.1.1` | 自动记录：由 `build-image.py` 成功构建；verify=runtime |
| 2026-03-30 | ap-beijing | `img-f2x4sqlp` | `lightclaw-2026.3.24-20260330-162958` | `2026.3.24` | `qqbot@1.6.6`, `weixin@2.1.1` | 自动记录：由 `build-image.py` 同步到 ap-beijing；source=`img-5d4jgn1z` |
| 2026-03-30 | ap-seoul | `img-5d4jgn1z` | `lightclaw-2026.3.24-20260330-162958` | `2026.3.24` | `qqbot@1.6.6`, `weixin@2.1.1` | 自动记录：由 `build-image.py` 成功构建；verify=runtime |
| 2026-03-26 | ap-seoul | `img-l46uq8u5` | `lightclaw-2026.3.11-20260326-001105` | `2026.3.11` | `qqbot@1.5.7` | 首轮稳定 app 镜像；已验证 gateway 冷启动修复 |
| 2026-03-26 | ap-beijing | `img-fn65zi17` | `lightclaw-2026.3.11-20260326-001105` | `2026.3.11` | `qqbot@1.5.7` | 上述首尔镜像同步到北京后的结果；当前仍作为兜底/旧基线保留 |
| 2026-03-26 | ap-seoul | `img-p75ydx8d` | `lightclaw-2026.3.24-20260326-214830` | `2026.3.24` | `qqbot@1.6.6`, `weixin@2.0.1` | 已完成冷启动验证；尚未 rollout 到测试环境 pool |
| 2026-03-26 | ap-beijing | `img-298f5mcp` | `lightclaw-2026.3.24-20260326-214830` | `2026.3.24` | `qqbot@1.6.6`, `weixin@2.0.1` | 上述首尔镜像同步到北京后的结果；`2026-03-28` 已 rollout 到主力池 `pool-c2~pool-c5` |
| 2026-03-28 | ap-seoul | `img-jm7sxlmf` | `lightclaw-2026.3.24-20260328-192322` | `2026.3.24` | `qqbot@1.6.6`, `weixin@2.0.1` | 基于 `img-id352nof` 重做 app-only；把 Node heap 策略收敛到 `openclaw` CLI wrapper，`envd,runtime` verify 通过 |
| 2026-03-28 | ap-beijing | `img-6km11yr3` | `lightclaw-2026.3.24-20260328-192322` | `2026.3.24` | `qqbot@1.6.6`, `weixin@2.0.1` | 上述首尔镜像同步到北京后的结果；`2026-03-28` 已 rollout 到主力池 `pool-c2~pool-c5`，作为统一 `openclaw` CLI heap 策略的首轮运行镜像 |
| 2026-03-28 | ap-seoul | `img-mmzexy7x` | `lightclaw-2026.3.24-20260328-214922` | `2026.3.24` | `qqbot@1.6.6`, `weixin@2.1.1` | 基于 `img-id352nof` 重做 app-only；默认 weixin 版本升级到 `2.1.1`，`runtime` verify 与冷启动 runtime 验收通过 |
| 2026-03-28 | ap-beijing | `img-q1c0q5s1` | `lightclaw-2026.3.24-20260328-214922` | `2026.3.24` | `qqbot@1.6.6`, `weixin@2.1.1` | 上述首尔镜像同步到北京后的结果；尚未 rollout 到 pool |

补充说明：

- `img-p75ydx8d` / `img-298f5mcp` 的冷启动验收已完成：`openclaw-gateway` 为 `enabled + active`，`18789` 已监听，`qqbot` / `weixin` 均可见。
- `img-jm7sxlmf` / `img-6km11yr3` 在上述基础上把 heap 策略从“只兜底 weixin login”收敛成“统一作用于 `openclaw` CLI”；`2026-03-28` 的 TAT 实测中，同一台 `2C2G` fresh sandbox 在继承该策略后，不再报 `JavaScript heap out of memory`，并能推进到“正在启动微信扫码登录...”。
- `img-mmzexy7x` / `img-q1c0q5s1` 继续把默认 weixin 版本从 `2.0.1` 升到 `2.1.1`；这次构镜使用 `runtime` 门禁和冷启动 runtime 复验。`envd` 套件仍受独立 follow-up 问题影响，未作为此次发布 blocker。
- `img-fn65zi17` 不再是所有 pool 的统一镜像；`2026-03-28` 起主力池先切到 `img-298f5mcp`，随后又进一步切到 `img-6km11yr3`，它保留为兜底/旧基线镜像。
- 历史 `lightclaw*` 中间镜像已在 `2026-03-27` 清理，清理规则见 [sandbox-image-cleanup-guide.md](sandbox-image-cleanup-guide.md)。

## 2. 当前 Pool 绑定镜像

查询时间：`2026-03-30`  
查询来源：

- MySQL fallback：`pools.base_image`
- K8s bootstrap 缺省值：[`sandbox/k8s/base/manifests.yaml`](../../sandbox/k8s/base/manifests.yaml)

### Pool 配置

| Pool | 当前 base_image | 对应镜像版本 | desired_capacity |
|------|------------------|--------------|------------------|
| `pool-c0` | `img-l54ntw81` | `lightclaw-2026.3.24-20260330-165115` | `24` |
| `pool-c1` | `img-l54ntw81` | `lightclaw-2026.3.24-20260330-165115` | `24` |
| `pool-c2` | `img-l54ntw81` | `lightclaw-2026.3.24-20260330-165115` | `24` |
| `pool-c3` | `img-l54ntw81` | `lightclaw-2026.3.24-20260330-165115` | `24` |
| `pool-c4` | `img-l54ntw81` | `lightclaw-2026.3.24-20260330-165115` | `24` |
| `pool-c5` | `img-l54ntw81` | `lightclaw-2026.3.24-20260330-165115` | `24` |
| `pool-bj8` | `img-l54ntw81` | `lightclaw-2026.3.24-20260330-165115` | `24` |

结论：

- 截至 `2026-03-30`，测试环境所有 pool 已统一 rollout 到 `img-l54ntw81`
- 本轮不再保留 `pool-bj8` 或 `pool-c0~pool-c1` 的旧镜像兜底；运行态镜像已全量收敛
- bootstrap 默认镜像也已同步更新到 `img-l54ntw81`，后续 seed / 重建不会回落到旧值

### 当前实例状态快照

| Pool | 状态分布 |
|------|----------|
| `pool-bj8` | `DRY=16`, `RESETTING=8` |
| `pool-c2` | `DRY=24` |
| `pool-c3` | `ALLOCATED=1`, `DRY=24` |
| `pool-c4` | `ALLOCATED=1`, `DRY=24` |
| `pool-c5` | `DRY=24` |

说明：

- 这是查询时数据库里的即时快照，不是目标容量视图
- `ALLOCATED` 实例按约定未被强改，待业务释放后会按新镜像回收重装
- 未出现在结果中的 pool，表示当时没有实例记录或没有该状态分布返回

## 3. 推荐后续动作

当前目标北京镜像已统一为：

- `img-l54ntw81`

rollout 后重点确认：

1. `DRY` / `RESETTING` 是否最终归零并恢复到稳定 `CLEAN` 库存
2. 当前测试环境不再依赖任何 pool rollout API，后续继续切新镜像时直接沿用 MySQL fallback
3. fallback 仍只更新目标 pool 的 `base_image`，并只把 `CLEAN` 改成 `DRY`

## 4. 参考命令

查询 pool 当前绑定镜像：

```bash
# 在仓库根目录下执行
source deploy/envs/beijing-sandbox/platform.env
KUBECONFIG="${DEPLOY_KUBECONFIG}" \
  bash .codebuddy/skills/sandbox-ops/scripts/query_pool_status.sh 'pool-c%'

KUBECONFIG="${DEPLOY_KUBECONFIG}" \
  bash .codebuddy/skills/sandbox-ops/scripts/query_pool_status.sh 'pool-bj8'
```

反查镜像元信息：

```bash
tccli cvm DescribeImages --region ap-beijing --ImageIds '["img-l54ntw81","img-6km11yr3","img-fn65zi17"]'
tccli cvm DescribeImages --region ap-seoul --ImageIds '["img-id352nof","img-5vppx4t5","img-jm7sxlmf"]'
```
