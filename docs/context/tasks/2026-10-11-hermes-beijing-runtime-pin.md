# 北京 Hermes 存量运行时版本修复

用户已确认北京严格验证、走 CI，并鼓励 Git 修改触发。范围为 beijing-sandbox / ap-beijing；
不批准生产地域、不恢复 PAUSED VM、不重置已分配 VM 或覆盖其配置/会话。

Hermes #33 构建 0.21.5，!5192 合入自动触发 #34（WEB_HOOK、ci.branch=master）。
#34 北京发布把 8 个 Pool 和 2 个 SKU 收敛到 img-64bzjwpv。现有 TAT 命令实际执行
`acli backend upgrade-start`；两台返回 SUCCESS 的旧 VM 实测 CLI、Python 包和 identity
仍为 0.21.3，不能据此宣称 Hermes 升级完成。#34 的 171 次 TAT 任务最终 143 成功、28
TASK_TIMEOUT；28 个超时目标属于同时进入库存重置的 VM。另 1 台 PAUSED 下发失败并保持暂停。

正式契约：[release-gitops](../../engineering/domains/release-gitops.md)。新增北京专用流水线，
审批后等待库存重置完成，固定 #33 对应 COS 归档及 SHA256。先运行一台 ALLOCATED canary，
通过后处理其余在线 VM；版本已正确只验证。存量替换保留用户配置/会话和旧 runtime 树，
失败恢复源码、identity 和原先活跃的 gateway。逐台 TAT 终态及 CLI/import/distribution/identity
版本必须匹配，暂停机器标记为暂缓。任务回执按 build ID 持久化并避免重复已接受任务。

Context receipt：根/.ci AGENTS、devops-pipeline skill、release-gitops、CI 服务、环境路由、
CTL 服务已读；源码邻居 images/build.sh 的 COS final pin 和 test-hermes-runtime.sh 版本检查。
本机回归覆盖错误归档/链接、project 版本选择、幂等、安装失败恢复和用户配置保留；CI 结果待验收。
原始渠道聊天记录还需要 CTL/网关和真实账号验收，本任务的版本检查不能代替该验收。
