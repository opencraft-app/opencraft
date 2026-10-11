# 北京 Hermes 存量运行时版本修复

用户已确认北京严格验证、走 CI，并鼓励 Git 修改触发。范围为 beijing-sandbox / ap-beijing；
不批准生产地域、不恢复 PAUSED VM、不重置已分配 VM 或覆盖其配置/会话。

Hermes #33 构建 0.21.5，!5192 合入自动触发 #34（WEB_HOOK、ci.branch=master）。
#34 北京发布把 8 个 Pool 和 2 个 SKU 收敛到 img-64bzjwpv。现有 TAT 命令实际执行
`acli backend upgrade-start`；两台返回 SUCCESS 的旧 VM 实测 CLI、Python 包和 identity
仍为 0.21.3，不能据此宣称 Hermes 升级完成。#34 的 171 次 TAT 任务最终 143 成功、28
TASK_TIMEOUT；28 个超时目标属于同时进入库存重置的 VM。另 1 台 PAUSED 下发失败并保持暂停。

根因更新：实机 ins-041xed59 的 ACLI bundle 为 2026.09.22-1/specs 1.1.28，映射没有
新蓝图 lhbp-7wrz1nyu，回退默认旧 COS 目录（hermes-agent-branch-main-0d6e4079…）。
升级日志证明已下载解压该旧包，最终仍 0.21.3；并非没下载、TAT 不会升级源码。
当前发布的 ACLI bundle 2026.09.30-4/specs 1.1.64 已正确映射新版蓝图到 hermes-agent-v20260928。
现有 ensure_acli_backend 在命令已可用时提前返回，是旧映射未刷新直接进入升级的缺口。

正式契约：[release-gitops](../../engineering/domains/release-gitops.md)。修正现有存量升级
脚本，使 bundle-update 在 backend 命令已可用时也执行，刷新失败即停止。北京专用 CI
审批后等待库存重置完成，固定 #33 COS 归档 SHA256、蓝图和目标版本，先运行一台
ALLOCATED canary，再处理其余在线 VM。直接使用官方 backend upgrade-start，显式
传 cos-version/display-version，沿用官方用户数据备份和服务恢复。版本已正确只验证；
逐台 TAT 终态、CLI/import/distribution/identity 和原先活跃 gateway 均须核对；暂停暂缓。

Context receipt：根/.ci AGENTS、devops-pipeline skill、release-gitops、CI 服务、环境路由、
CTL 服务已读；源码邻居 images/build.sh 的 COS final pin 和 test-hermes-runtime.sh 版本检查。
本机 8 项回归覆盖归档边界、幂等、刷新先于升级、固定官方目标、刷新失败停止、旧版本拒绝；另 4 项终态门禁回归通过。CI 结果待验收。
原始渠道聊天记录还需要 CTL/网关和真实账号验收，本任务的版本检查不能代替该验收。
