# 建站 Skill 凭据文件兜底与 auth-only 热修

## 范围与授权

本次源码修复仅改变 `website-builder/SKILL.md` 的认证段；静态建站、能力门禁、
stateless backend、fullstack 打包/发布等其它内容不变。环境变量优先，缺失值在同一次
terminal 子 Shell 内从 `/etc/vela/website-credential.env` 兜底，显式 export 给子脚本。
两者均没有非空 Key 才停止。凭据及 API 地址不输出，不需要重启任何服务或实例。

下面的 helper **不是 credential installer，也不是 full Skill installer**。
它不读取 Key 文件，不签发/撤销 Key，不更新 credential CommandId，不调用云 API。
准备 payload 不等于创建 TAT Command，更不等于生产下发；现网操作必须另行授权。

## 离线 auth-only helper

入口：`images/helpers/website_skill_auth_patch.py`。

- 严格匹配认证段整体 SHA-256 白名单：仓库已知 env-only 段（`vik_` 与旧 `vwk_` 前缀）及
  2026-10-02 已审阅的手修段（包含添加 `set +x` 的版本）。不模糊替换陌生认证流程。
- 只改认证段，保留段外每一个字节，保留文件 mode、UID/GID；旧 `vwk_` 描述原样保留。
- 已是 byte-exact hardened canonical 时 `already-current`；精确命中已审阅生产 v1 auth hash 时
  `already-pinned-v1`，保持原文，不把它误报为 canonical 已更新。两者均不重复备份或重写。
  marker 相同但内容不在白名单时仍跳过，绝不凭 marker 信任陌生定制。
- auth 缺失、重复或定制内容不在白名单时 `skipped-unknown-auth`。
- 存在同目录 `bundle.json` 时 `skipped-managed-bundle`，**不读 manifest，也不破坏其 digest/rollback**。
- 文件不存在时 `skipped-missing`，不创建 Skill、不升级其它文件。
- 拒绝 Skill 文件/父目录符号链接；同目录 flock 串行化 helper 调用。
- 修改前保存完整原文件为 `SKILL.md.auth-backup-<原文件 SHA-256>`，备份为 `0600`；
  备份同名内容不一致/不私密时拒绝覆盖。备份可能包含用户定制内容，同样按私有文件保护。
- 同目录 staging + fsync + `os.replace` 原子替换；替换前再次核对原文件内容/元数据。
  替换失败保留原件和备份、清理临时文件。不支持绕过未遵守锁的并发写者；维护窗口内操作。
- 状态只输出固定原因、Skill digest 和备份路径，异常不输出文件内容或原始异常。

在**临时目录中的副本**上验证：

```bash
python3 images/helpers/website_skill_auth_patch.py --skill-path /absolute/test-copy/SKILL.md
```

离线生成独立 payload（文件 exclusive-create，权限 `0600`）：

```bash
python3 images/helpers/website_skill_auth_patch.py --command-output /absolute/private-dir/auth-patch.sh
bash -n /absolute/private-dir/auth-patch.sh
```

payload 内嵌 helper，只定位 `$HOME/.hermes/skills/website-builder/SKILL.md`；TAT 实际执行用户
及 `HOME` 必须由主线程核实，不可在未知 HOME 上盲发。跳过状态的退出码也是 0，
所以 **TAT SUCCESS 不代表已替换**，必须核对 `WEBSITE_AUTH_RESULT.status`。
`patched`/`already-current` 表示 hardened canonical 已满足；`already-pinned-v1` 仅表示
已审阅的生产安全版本保留，**不表示已升级 canonical**。其它状态分类处理，不能整体覆盖。
手工回退前核对原文件 digest 与备份归属，在维护窗口原子恢复，禁止恢复 credential 或重启服务。

`images/helpers/website_skill_bundle.py` 与 `.ci/runtime/support/rollout_website_skill.py`
安装完整 bundle（含 `scripts/package_fullstack.py`），**不得用于本次存量实例 auth-only 热修**。
managed bundle 及缺失 Skill 另行确定镜像/版本发布路径，不在本补丁扩大修复范围。

## 新实例 hook：已实现源码，未发布

只在 `RunCreateInstanceTask` 成功持久化 Running 后执行一次独立 Skill-only hook，
位于原 credential hook 之前。**未修改 resume、Paused/offline 追补或修复路径**；
已 Running 的 create task 再执行也不重派。特殊异常留档，用户后续反馈时再独立处理。

- `ctl/pkg/instance/website_skill.go`：`GetSandbox().Region` 精确选择新 env
  `WEBSITE_SKILL_TAT_COMMAND_IDS_BY_REGION`；仅传 CommandId、无 parameters；总超时 30 秒。
  默认/缺配/无效 JSON/重复地域或 ID/未知 Region 禁用或跳过，不跨地域 fallback。
  不触及 credential store。Skill 失败不阻断 Running 或原 credential 流程。
- `ctl/pkg/instance/{logic.go,async.go}`：初始化独立映射并挂载 hook；Skill ID 与任意已配置
  credential ID 重叠时拒绝两类调用，credential 侧在 Issue/Revoke 前就拒绝，防止参数泄露。
- `ctl/pkg/adapter/sandbox/adapter.go`：允许空参数；空 CommandId 仍拒绝。
  **parameterless Skill POST 不重试**，避免网络/502 结果不明时重派；GET metadata polling 和
  原 credential POST 的 retry policy 不变。不增加自动补偿、创建用户或 root fallback。
- `sandbox/api-gin/{config.go,handler.go,main.go,website_skill.go,tat.go}`：独立 Skill 精确地域
  allowlist，只匹配目标地域 Skill ID 且无参数才允许执行。credential 保持原参数校验，
  未知/跨地域/两种 ID 重叠均拒绝，Skill 命令带任何参数也拒绝。
- `sandbox/internal/provider/tencent.go`：parameterless Skill InvokeCommand 真正省略 Parameters，
  不发送 `"null"`、占位 Key；credential 参数编码不变。
- `ctl/k8s/base/manifests.yaml`：新 env optional 注入 **ctl-service（创建任务 worker）**。
  `sandbox/k8s/base/manifests.yaml`：空值默认禁用。其它环境不增加生产映射。
- `argocd/services/{ctl,sandbox}/{shprod,sgprod}/`：源码 env 中配置下节真实映射；Sandbox
  replacements 把 platform values 写入 runtime ConfigMap。已做两区两组件 real source render，
  仅在临时镜像中去掉 KSOPS generators，不解密 Secret、不 apply。

原 credential 单命令/地域映射及 provisional Issue → TAT 参数化安装 → Activate/失败 Revoke
流程保留；没有签发、rotate 或续费/resume 逻辑扩展。`TAT SUCCESS` 只记为命令完成，
不冒称 auth 已 UPDATED（脚本可安全跳过 skill_missing/custom/managed）。

## 2026-10-02 生产 auth-only Skill 命令映射

以下 **Skill-only** TAT 命令由主线程于 2026-10-02 创建并通过 `DescribeCommands` 核验；
本代码工作区不执行云查询/下发，因此这里记录的是主线程交接证据，不是本线程线上验收。

| 环境 | 实际 Tencent Region | Skill-only CommandId |
|---|---|---|
| shprod | ap-shanghai | `cmd-njt2oy9u` |
| sgprod | ap-singapore | `cmd-nfuezsgx` |
| sgprod | ap-johorbahru | `cmd-dgorg46u` |

命令执行用户 `agentuser`，无 parameters，不重启。它们只 patch 已知 auth 段，
保留 custom tail、幂等，跳过未知定制及 managed bundle；不整体升级 fullstack Skill。
canonical 使用相同 `vela-website-credential-fallback:v1` marker，但保留 env base 优先、
加载输出抑制和 source 失败 fail-closed 加固。精确认可生产 v1 段 hash：

```text
7ee96ef106e2853d6b3dfae389921403c5d47674aade190be2a93ba0c3f109bf
```

主线程热修 pinned payload SHA-256：

```text
451bc5a92f603ce6c790a3e9a14dcc3770c32c12bb0862c5d31dfc1977e3fb02
```

实际私有生产脚本为
`/Users/shawnmy/code/mono2/.tmp/website-skill-rollout-20261002/hotfix-command.sh`；
不复制该私有文件进仓库。该 SHA 只指主线程已创建的热修 payload，**不指本仓库 helper 生成的
payload**（两者安全语义等价，但本 helper 额外保留非空环境变量优先及 source 失败 fail closed）。
主线程交接：三地区 canary 均 UPDATED，并以 Hermes LocalEnvironment 删除 env Key 后
执行 installed snippet，均 HTTP200/PASS；首批 reported 298 UPDATED、1 skill_missing。
这些为主线程提供的时点证据，不是本线程 live 查询，也不代表整批/全量已完成。
START_FAILED ``InvalidUser: user `agentuser` not exists`` 由主线程分类为
`EXCLUDED / TAT_AGENTUSER_MISSING`，retain action，不重试、不创建用户。Paused/offline 等留档人工处理。

hook 独立 Skill 映射（已写 source env；尚未发布或在线启用）：

```text
# shprod / CTL 与 Sandbox 配对
WEBSITE_SKILL_TAT_COMMAND_IDS_BY_REGION={"ap-shanghai":"cmd-njt2oy9u"}

# sgprod / CTL 与 Sandbox 配对
WEBSITE_SKILL_TAT_COMMAND_IDS_BY_REGION={"ap-singapore":"cmd-nfuezsgx","ap-johorbahru":"cmd-dgorg46u"}
```

**绝不能**把上述命令写入 `WEBSITE_CREDENTIAL_TAT_COMMAND_ID` 或
`WEBSITE_CREDENTIAL_TAT_COMMAND_IDS_BY_REGION`。这两项仍是原参数化 credential installer
的路由/allowlist；新 hook 也不传 `website_key`/`api_base`，不签发、激活或撤销 Key。
本轮同步四份 production source env 与两份 Sandbox replacements；这只是隔离 worktree
中的待审阅变更，不执行 GitOps promotion、Argo sync、apply 或实际发布。

## 成对发布与回退说明（只提供步骤，不执行）

1. 审阅/合入授权后构建含 hook/adapter 与 allowlist/provider 修复的 CTL/Sandbox 镜像。
2. 逐环境先交付 **Sandbox 新镜像 + 同环境 Skill map**，确认 credential allowlist 未变；
   再交付 **CTL 新镜像 + 相同 Skill map**。sgprod 同时覆盖 Singapore/Johor，不能从默认地域推断。
3. 验证两端实际 env maps 相同、目标 revision/image 与 Argo Synced/Healthy；然后真实新实例
   检查独立 Skill invoke、原 credential 绑定激活与无 Key env 的文件兜底 HTTP 验收。
   source render/metadata SUCCESS 不代替这一步；现网 canary 不能证明新 hook 已发布。
4. 回退时先清空 CTL 新 Skill map 停止新调用，再清空 Sandbox Skill allowlist。
   不修改任何 credential ID、Key、用户、已暂停机器或其它 Skill 内容。其它环境默认关闭。
5. 不修复或自动追补 InvalidUser、offline、custom、managed、skill_missing；保存分类/原 action，
   用户后续反馈时另行申请定向处理。不挂 resume hook，不安排周期任务。

## 验证与发布门禁

```bash
python3 images/tests/test_website_skill_auth.py
python3 -m unittest discover -s .ci/runtime/tests/contract_tests -p 'test_website*.py'
python3 -m unittest discover -s .agents/skills/website-builder/tests
(cd ctl && GOWORK=off go test ./pkg/instance -run 'WebsiteSkill|CredentialRefusesSkill|ReplaySkill|WebsiteCredential' -count=1)
(cd ctl && GOWORK=off go test ./pkg/adapter/sandbox -count=1)
(cd sandbox && GOWORK=off go test ./api-gin ./internal/provider -count=1)
```

本次不做 commit/push/MR、生产或云写操作。代码发布仍须审阅/合入授权，镜像构建时使用修复后的
Skill；新实例 hook 源码/配置已实现，仍需配对发布、真实新实例验收。
存量 auth-only 热修由主线程单独执行并核验，不能以离线测试或源码修复替代线上结论。
