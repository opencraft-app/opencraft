# Website Skill：存量下发与新机器内置

日期：2026-09-29。状态：源码和本地/Linux 验证；未创建生产 TAT Command、未下发。

## 同一份制品，两条交付链路

唯一源码是 `.agents/skills/website-builder/`，完整制品包括 `SKILL.md` 和
`scripts/package_fullstack.py`。`images/helpers/website_skill_bundle.py` 对固定文件集合
生成确定性 SHA-256 版本，拒绝缺失文件和符号链接。版本与 Git commit 不等同。

- 新建机器：`images/deploy-build.sh` 上传 Markdown、脚本和公共安装器；
  `images/build.sh` 用该安装器安装完整包，归属 runtime user。两边最终镜像正常新机验收已完成，详见下文2026-10-01更新。
- 存量机器：`.ci/runtime/commands/rollout_website_skill.py` 生成自包含 TAT 命令，
  同一安装器、同一源文件得到同一版本。不下载可变 URL，不调用 CTL、不签发/吊销凭据，
  不读写 `.env` 或凭据文件，不重启 Agent。
- 只更新 Skill 不会开启后端功能：仍必须通过 capability 判断；未入白名单/没有 runtime
  配置时保留静态路径。持久化数据库能力尚未提供。

## 安装与回滚边界

安装器锁定 `.hermes/.lightvela/website-builder-releases/.lock`，校验完整包，先写版本目录，
再暂存完整新目录和回滚 receipt，最后原子交换真实 `website-builder` 目录。
Linux 需要 `renameat2(RENAME_EXCHANGE)`；不支持原子交换时失败，不退化为半更新。
不是活动目录符号链接，兼容 Hermes 的递归 Skill 发现和镜像 Skill 裁剪。
旧版只有 Markdown 的目录及其额外文件完整保留；备份在 Skill 扫描树之外。
安装器不会自动删备份，磁盘和保留策略由发布前审核决定。

回滚命令绑定“本次版本仍在活动”的前置条件，恢复该机器自己的上一完整目录；
首次安装而无旧版时拒绝回滚。安装成功但回执丢失可安全重跑安装；回滚回执丢失须先
对账，不能盲目再次回滚。磁盘损坏/被手改的版本拒绝验收，不掩盖为成功。

## 存量清单与覆盖率

由只读 CTL→Sandbox→CVM 联表生成权限 0600 的完整 CSV：

```text
user_id,business_instance_id,sandbox_id,cvm_instance_id,environment,region,status,sandbox_instance_state,eligible
```

生成方须排除已删除业务实例，验证映射和实际地域，不以用户 ID 代替 CVM ID。
执行器要求 24 小时内刷新的 CSV；Running + ALLOCATED + eligible=true 才可立即投递；
按环境和实际地域独立执行：shprod/ap-shanghai、sgprod/ap-singapore、
sgprod/ap-johorbahru。后者必须显式 `--region ap-johorbahru`，独立 CommandId/state，
不把新加坡 CommandId 发给新山。重复 CVM 或重复业务映射的
**所有成员**都排除，包括一个 eligible、另一个不 eligible 的情况。

“全量完成”不能只统计本次 Running：Paused、未 ALLOCATED、缺失映射、地域错误、
重复映射必须保留为待处理清单；恢复后重新生成清单、单独 state 并再走 canary。
需要核对 Agent 类型、Python3、TAT agent、目标用户和目录、磁盘，以及是否有多 gateway
布局；当前命令仅支持 `/home/agentuser/.hermes`，其它布局不得算作已覆盖。

## 本地准备（无云调用）

从本工作树根目录执行；下面相对路径均为仓库路径：

```bash
python3 .ci/runtime/commands/rollout_website_skill.py \
  --prepare-command /secure/path/website-skill-install.json
python3 .ci/runtime/commands/rollout_website_skill.py \
  --csv /secure/path/inventory.csv --environment shprod
```

默认 dry-run 不调用云 API，也不创建 state。准备文件以 O_EXCL/0600 创建。
记录输出 version、源码 revision、文件 digest、环境、清单 digest；冻结这组输入。

## 获得独立发布授权后

1. 每个环境独立审核后，用 tccli TAT CreateCommand 上传准备好的 JSON。创建 Command
   本身就是云写操作，不在本次本地准备范围内。调用格式：
   `tccli tat CreateCommand --region "$REGION" --cli-input-json file:///secure/path/website-skill-install.json`。
   命令必须以 agentuser、工作目录
   `/home/agentuser`、SHELL、Timeout=300、EnableParameter=false 创建。
2. 指定 CommandId 和唯一 CVM canary：

```bash
python3 .ci/runtime/commands/rollout_website_skill.py \
  --csv /secure/path/inventory.csv --environment shprod \
  --state-file /secure/path/shprod-install.json \
  --command-id "$SKILL_COMMAND_ID" --execute --canary "$CANARY_CVM_ID"
```

3. 执行器在投递前 DescribeCommands，逐字验证远端脚本与本地完整包、运行身份和参数
   配置。TAT 退出码 0 **不够**：必须读取任务终态且提取匹配版本的安装后校验 receipt。
   canary 还需人工验证真实 Agent Skill 发现/脚本调用、静态建站不回归、凭据未变。
4. 验收后复制输出的非 secret `canary_ack`，使用同一输入和 state：

```bash
python3 .ci/runtime/commands/rollout_website_skill.py \
  --csv /secure/path/inventory.csv --environment shprod \
  --state-file /secure/path/shprod-install.json \
  --command-id "$SKILL_COMMAND_ID" --execute --resume-after-canary "$CANARY_ACK"
```

每次最多 100 台，默认每批 10 台，失败即停。逐批审核，不自动无限循环。
state 绑定 inventory、环境、完整命令 digest、Skill version、CommandId、安装/回滚动作；
并发进程互斥；成功机器跳过；已知 invocation 先轮询，不重新发送。
InvokeCommand 响应丢失会保持 INVOKING，必须在 TAT 对账后显式
`--reconcile ins-xxx=inv-xxx` 绑定匹配任务；没有 invocation 不能自动重试。
明确失败需排查后显式 `--retry-failed`。命令内容与任务正文不输出到共享日志。

5. 回滚：对**同一冻结源码版本**用 `--action rollback --prepare-command ...` 生成独立
   rollback command；新建独立 state、同样先 canary，再 bounded rollout。不能复用
   install state，也不能用当前工作目录的新版本代替待回滚版本。

## 验证记录与未完成门禁

- macOS：23 项 website Skill/打包/交付测试通过；镜像构建脚本 fixture 通过。
- 独立 Linux VM：16 项交付测试通过，覆盖真实目录原子交换、旧目录回滚、完整内嵌
  shell/Python 命令执行、发现路径、凭据字节不变、丢回执对账与 canary 门禁。
- TAT SDK 本地模型核对：Command、InvocationTask、TaskResult 输出契约。
- 2026-10-01：北京/韩国测试地域真实Command内容核对、最终内置Skill镜像、新机器自动凭据
  和真实Hermes发现/打包/实例发布已验收。生产Command创建和全量覆盖率对账尚未执行，
  按用户要求属于上线后用户执行的存量下发，不是本次提前执行项。

## 2026-10-01 用户交付顺序澄清

发布前准备并验证新机器内置最终 Skill，以及同一版本的存量 Skill-only TAT 安装与回滚包；
生产上线后由用户执行存量批量下发。本任务不提前执行生产全量下发，不修改已有实例凭据，
不重做凭据交付体系。地域命令匹配、失败留账、可续跑和版本校验仍保留，避免批量覆盖错误实例。

## 2026-10-01 双区域最终版本新机实测更新

最终 Skill 版本 `f99e32a7d2a4a61cac5066f5a619d7f76e4b2ed0a3f116c676707b5cf795e6ba`
已内置于北京 `img-7ynvqc9z` / 韩国 `img-fuk1k47z`。两边均走正常公共建机链路，
验证镜像内置完整 Skill、真实 Hermes 发现/查看/打包器执行、自动实例凭据及最终源码
服务上的发布/真实浏览器 API；没有手工补装 Skill 或凭据。旧机器最终 Skill 的 TAT
安装功能验收已有地域证据；旧 canary CVM 已由测试清理替换，原清单不得作为现时投递输入。
生产地域 Command 创建、生产清单和上线后全量投递仍未执行，按用户要求留给上线后的
独立动作，不把这些生产写操作混入当前 Ready 前测试。实时门禁见 Task Pack。
