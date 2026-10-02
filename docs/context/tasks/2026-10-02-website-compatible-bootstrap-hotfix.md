# 建站 credential-compatible bootstrap 配置热修

## 目标与授权
用户要求不走正式镜像发布，线上现有 CTL/Sandbox Pod 配置热修 CommandId，同时固化代码并自主提交、审批、合入 MR。此前存量 auth-only 下发 13,070 UPDATED，89 异常跳过；不补发异常或恢复暂停机器。

## Non-goals
不轮换存量 Key，不重启用户 gateway，不创建生产测试用户/实例，不审批 production promote，不改 DSH/COS/镜像/pool，不 Full Sync sandbox-sgprod。

## Context receipt
已读根 AGENTS.md、本机用户覆盖、CTL/Sandbox/.ci AGENTS.md、control-plane-ops 路由 docs/context/project/services/ctl.md；生产授权连接遵循本机 lightclaw-credentials。

## 实现
- 从真实原 credential CommandId 回读 placeholder-only Content，三地 SHA 一致；直接 clone 完整 Content，不能替换为有 gateway-discovery 差异的当前源码 installer。
- credential 成功后降权 agentuser 执行 canonical auth-only helper，清除 WEBSITE_KEY/API_BASE。失败 best-effort，不影响 credential 生命周期。
- 新命令 cmd-czxw3gau / cmd-qdb9wde1 / cmd-at6wymyk。两区 CTL/Sandbox scalar 与 region maps 配对热修和源码固定，清空独立 Skill map，镜像不换。
- 地域 map 是精确替换，保留旧 scalar 不代表同时接受旧 ID；Sandbox/CTL 切换期间不能宣称零窗口。原命令保留作为回退依据。
- 模块拒绝嵌入 Key/NUL/heredoc collision，输出 0600 exclusive-create。补齐此前遗漏的 pinned-v1 测试 fixture。

## 验证与最新状态
- 线上四个 Deployment 配置回读匹配，Sandbox 各10/10、CTL各1/1 Ready，镜像 digest 未变，未重启用户机器。
- bootstrap mock 30 PASS；auth helper 32 PASS；两区两组件 source render 3 PASS。
- 原凭据 installer shell suite 68 PASS；focused website release contract 4 PASS；diff-check PASS。
- 上海自然新机 ins-0xc7yflb 自动调用 bootstrap inv-u9d76607f6：SUCCESS/exit0、credential成功、Skill patched；只读验收 inv-u9d79hgapg 用 Hermes LocalEnvironment 清空 env Key 后执行安装的 snippet，HTTP200/OK/PASS。国际两地域尚未观察到新机自动调用，未创建生产测试实例。
- 固化 MR !4932 已创建、自审批；CI首次因command wrapper/materialize登记约束失败，已拆为commands wrapper与support模块并补登记。本机CI runtime全门禁通过（655 tests + materialized smoke）；继续推送修正、等待真实MR CI。
- 柔佛自然新机 ins-ayo48pld 自动 bootstrap inv-d9d7a7gxn6 成功，Skill patched；只读验收 inv-c9d7fig0tt：无env Key的Hermes LocalEnvironment文件兜底HTTP200/OK/PASS。新加坡仍没有自然新机调用记录。
- 不声称正式发布、Argo/GitOps闭环或真实新机验收已完成。

## 私有证据
主 checkout .tmp/website-skill-rollout-20261002，目录0700、文件0600，bootstrap-config-apply.json、bootstrap-commands.json、原始cloud metadata及fleet SQLite ledger。不提交生产secret、真实Key或用户明细。
