# 构建与地域发布 SOP

适用于构镜、复用地域镜像、Pool/SKU rollout 和存量升级。命令从仓库根执行。
本文按 2026-10-05 master 校对；每次先读当前 `.ci/hermes-image.yml`，历史 ID 不当作默认值。

## 升级责任面

新 CVM 镜像用于新建/重装库存；Pool/SKU 发布修改地域镜像期望并将 CLEAN 库存排入 reset；
存量 TAT 则在已有用户机原地执行 backend 升级，可能影响服务。先确认需要哪几层、目标版本、
地域和用户机范围，并检查实际上游 source/release note、blueprint 内容和业务验收条件。
不从小版本号直接推断兼容性，历史 0.21.3 不是未来默认版本。

## 版本来源与验证

`images/build-manifest.json` 的 `runtime_hermes.version/src_version/git_commit` 为空时，
`images/build-image.py` 在 CI 开始读取 `cos_base/latest.json`，记录具体 version 目录、
src_version 和 git_commit，向远程构建传入固定值。“latest”是当次解析结果。

blueprint resolver 默认查询北京、精确匹配 NORMAL `hermes_agent`、排除南京候选、按创建时间
选最新；允许 `HERMES_BACKEND_BLUEPRINT_ID` 显式覆盖。COS 源码和 blueprint DisplayVersion
是两套来源，用户当时明确选择不加相等门禁，保留该决策。构镜已有 blueprint 后 source restore、
venv pin 和最终验证；存量 repair 直接消费 blueprint，不能继承构镜的 COS pin 保证。

CLI 从 `Hermes Agent vX.Y.Z` 行提取，使用 `images/lib/hermes-version.sh`。核对 CLI、
pyproject、import `hermes_cli.__version__`、distribution metadata 和 identity runtime_version。
identity 仅输出相关 runtime 键，不打印整个文件。测试 fixture `lhbp-latest` 不是云端实际 ID。

## 触发与复用

新镜像：`images/hermes-image-trigger` 追加带明确目的的记录，最后匹配 `reuse=` 必须为空：

```text
<当前时间> hermes-runtime-rebuild reuse=
```

复用已有镜像：

```text
<当前时间> hermes-rollout-recovery reuse=hermes-agent-b-<原构建ID>
```

流水线取最后匹配值，追加不含 `reuse=` 的行可能继续复用旧镜像。也支持
`HERMES_REUSE_IMAGE_NAME`，或 `HERMES_SKIP_IMAGE_BUILD=true` 配合 image name；先查询当前
startup-info，不能假定任意 env 都可在 UI 填入。复用按精确 name 解析五地域 ID，跳过构镜；
它不会包含后来源码修复。改镜像内容必须重构。merge images/** 后先查自动触发，避免重复启动。

旧 stage retry 可能固定触发 SHA，先读 checkout SDK 实际 checkout 行。2026-09 #20 的
checkout 强制固定旧 SHA，合入脚本不会被该次直接 retry 消费。

## 地域和审批

| 顺序 | 环境 / region | kubeconfig key | 发布动作 |
|---|---|---|---|
| 构镜 | 默认源 ap-seoul | build manifest/CLI | 临时构建、验证、五地域同步 |
| 1 | beijing-sandbox / ap-beijing | kubeconfig_beijing_sandbox | 预检、审批、Pool、TAT |
| 2 | sgprod / ap-singapore | kubeconfig_sgprod | 预检、审批、Pool、TAT |
| 3 | sgprod / ap-johorbahru | kubeconfig_sgprod | 预检、审批、Pool、TAT |
| 4 | shprod / ap-shanghai | kubeconfig_shprod | 审批、Pool、TAT |
| 仅镜像 | ap-tokyo | 此 rollout 不使用 | 镜像同步 |

上海目前没有独立预检 stage，审批前仍需枚举库存和核对地域 image。分别查 image NORMAL，保存
每个 region 的具体 image ID。镜像名相同不表示跨地域 ID 相同。

只读枚举：

```bash
HERMES_POOL_VM_LIST_ENVS=sgprod:ap-johorbahru:kubeconfig_sgprod \
  bash .ci/runtime/commands/list_hermes_pool_vms.sh
```

按 pool.zone 的 region 隔离 Singapore/Johor，检查 class、SKU 和 legacy 输入。高内存 SKU 的
class 可能仍为 openclaw-*，sku-hermes-* 也被选中，不能只筛 class=hermes。legacy ID 以 YAML
为准，先确认仍属于目标 region。应记录每 Pool 状态、cloud ID 数量及派发候选资格。

## Pool/SKU 冲突

CI 和 SKU controller 必须使用相同地域判定。每 SKU 的全部已知 Pool 只在目标 region 时，
先更新 SKU base/desired image；若该 SKU 横跨 Singapore/Johor，跳过全局 image，逐 Pool
保存地域 ID；仅在其他 region 的 SKU 不更新。缺失/错误 zone、可疑绑定先检查，不可判为独占。
新增规格 Pool 会改变地域集合；核对实际部署 controller 版本也支持多地域规则。

Pool patch 发送 `{base_image:<目标>,mark_clean_as_dry:true}`。服务端在 image/type 变化时把
CLEAN 标为 DRY；worker 进行重装。相同 image patch 通常不再次转换，但 controller 回写旧值
会再触发，查 `last_autoscale_action` 和 SKU desired。保留旧 stable，由 controller 验证后收敛。

选择器包含 paused Pool。刷新前后按 Pool/instance ID 核对 CLEAN/DRY/RESETTING/ALLOCATED/
PAUSED。用户机计数不变不能证明同一批 ID 不变。`verify_refresh` 仅验证 base_image，仍需等
库存 reset 收敛、查错误、新建/重装实例 runtime 验证，再推进下一地域。

## 存量 TAT 和完成判定

Command 默认 root、/tmp、600 秒。payload 定位 agentuser，修 pip/uv 和 .config/systemd/user
权限，确保 ACLI backend 后以 agentuser 执行 `--wait=true --force=true`。用户不存在时会 skip
且 exit 0，也不能算升级。payload 不自动检测已到目标版本；重复派发可能重复升级/重启。

API 每批 5 台串行派发；失败拆单台最多 3 次，AgentNotInstalled/InvalidInstance 提前停止
该台重试。API 串行不表示目标任务串行，invoke 不等待远端完成。

验收：

1. 按 region+cloud_id 去重对照 inventory，分别报 INVOKED、INVOKE_FAILED、未记录。
2. 用 invocation_id 查 TAT 执行终态、退出码和脱敏输出；INVOKED 仅证明接受。
3. 用户指定 Bot 先映射 instance_id -> sandbox_id -> cloud_id，查原任务；必要时执行只读
   `hermes --version`。Bot Running 只是控制面状态，版本正确也不等于整个 payload 成功。
4. 查 gateway/systemd 健康并做相关聊天、Profile/文件验收，再声称用户可用。

大量 AgentNotInstalled 可能是历史销毁记录，也可能是现实机器未装 Agent；逐批查 CVM 存在性
和 TAT 在线状态。不得据此自动删库、销毁资源或把全部失败标为已完成。
