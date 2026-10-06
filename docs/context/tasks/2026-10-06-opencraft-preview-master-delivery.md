---
id: opencraft-preview-master-delivery
type: task
scope: 提交已归并的OpenCraft桌面控制、动效和混元听写源码并合入远端master。
triggers: ["opencraft master delivery", "预览源码合入master", "desktop speech commit"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/docs/cloud-desktop-plugin.md", "opencraft/docs/cloud-dictation.md", "scripts/scan_secrets.py"]
status: retired
reviewed_at: 2026-10-06
review_due: 2027-01-04
revision: 1.0.0
precedence: task
derived: false
---

## goal
用户明确授权“提 合入master”，提交统一源码并完成远端master交付。

## non_goals
不更新/重启预览，不发布生产、GitOps或公共镜像，不读取/输出凭据值，不强推或覆盖其他人的master提交。

## requirement_ids / requirement_refs / requirement_excerpt
unknown；用户本轮明确要求提交并合入master。前序集成已保留侧栏、SSH、桌面及语音。

## interface_refs / data_structure_refs
桌面viewer/controller/native executor的输入授权独立于动画；浏览器录音/云转写/Composer写入分别有owner。已部署SOURCE清单仅用于确认本次源码范围，不将服务凭据或临时部署包加入Git。

## history_context
current_design_refs：cloud-desktop-plugin、cloud-dictation、platform-architecture和design/invariants。
relevant_evolution：58文件在线源码已归并，25文件motion快照全部一致；全workspace类型、287项聚焦测试及两类浏览器验证已通过。
superseded_refs：旧b2a分支和旧预览PID只作历史；源码合入不等于服务升级。

## acceptance / validation
提交范围限定归并源码和正式文档；秘密扫描、设计影响检查、diff检查通过。同步最新master，保留所有后续改动，解决冲突后验证完整OpenCraft gate及真实桌面/语音UI。用新命令确认远端master包含本提交。

## affected_paths / scan_scope
前序统一源码清单、相关正式文档和本任务记录；不纳入依赖、构建产物、私有服务配置或临时机器路径。

## required_context / context_receipt
根/OpenCraft AGENTS、maintenance Skill与verification、pre-commit配置及scan_secrets全文；Router query opencraft source integration commit merge master 无匹配后有界检索交付入口和当前差异。frontend-runtime-openspec-i18n邻接及前序读取的build-release-artifacts测试邻居。工蜂Skill及DEPENDENCIES要求优先发现已有连接，MCP仅通过mcporter-internal；当前无已有MCP配置，Git认证可用。默认凭据不可用，使用用户先前指定的本机credential store，不输出值。

## evidence / decisions
集成基线7d946；本轮fetch更新远端master到f3046979d，新增站点文档/Bot状态和共享翻译，不能直接推旧基线覆盖。采用普通合并保留历史与并发保护，不使用force。

## checkpoint
stage：源码与合并结果已推送，远端master交付完成。
verified：前序集成VALIDATION已通过；70文件限定暂存、敏感扫描0命中、设计影响检查及diff通过；源码提交47d7720d8。已合并远端f3046979d，无冲突，保留站点/Bot状态/翻译更新。完整gate分两段执行：全部阶段通过，2183项测试中2182通过/1跳过/0失败；听写额外14项通过，Web/Expo Web/iOS bundle构建通过。桌面UI6组（浅/深/扩展主题、桌面/触控）及听写UI4组（浅/深、桌面/触控）通过，真实组件与当前CSS，外部输入/供应商为合成边界，不宣称手机真机/付费接口验收。文档0错误/0断链。最初普通验证进程被终止，后以独立验证服务运行，不修改预览；DSH首次4项失败均为独立运行时模块未安装，按当前锁文件npm ci完成后从失败阶段续跑成功。
remote_receipt：普通push通过远端permission/watch-path/push检查；集成分支与master均收到9eeaef47c，再次fetch后master仍为该提交，merge-base确认包含源码47d7720d8。没有force、MR绕过、GitOps或镜像写入。
unverified：仓库级Context检查仍有6174个既有错误，本次70个受影响文件及新增任务无相关诊断，不宣称全仓Context门禁通过；Mac/iPhone实机权限、外部ASR质量/计费不在本次Git交付范围。
restore：不修改其他工作树和正在运行的服务，提交/合并仅在统一集成分支完成。
next_action：仅提交本归档回执与派生目录更新并普通推送，最终核对远端包含源码与合并提交；不重新构建或替换预览。
