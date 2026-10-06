---
id: opencraft-preview-master-delivery
type: task
scope: 提交已归并的OpenCraft桌面控制、动效和混元听写源码并合入远端master。
triggers: ["opencraft master delivery", "预览源码合入master", "desktop speech commit"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/docs/cloud-desktop-plugin.md", "opencraft/docs/cloud-dictation.md", "scripts/scan_secrets.py"]
status: active
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
根/OpenCraft AGENTS、maintenance Skill与verification、pre-commit配置及scan_secrets全文；Router query opencraft source integration commit merge master 无匹配后有界检索交付入口和当前差异。frontend-runtime-openspec-i18n邻接及前序读取的build-release-artifacts测试邻居。默认凭据不可用，使用用户先前指定的本机credential store，不输出值。

## evidence / decisions
集成基线7d946；本轮fetch更新远端master到f3046979d，新增站点文档/Bot状态和共享翻译，不能直接推旧基线覆盖。采用普通合并保留历史与并发保护，不使用force。

## checkpoint
stage：准备提交，尚未push或合入master。
verified：前序集成VALIDATION已通过；最新远端master已获取。
unverified：最新master合并后完整gate、敏感信息检查和远端合入。
restore：不修改其他工作树和正在运行的服务，提交/合并仅在统一集成分支完成。
next_action：清理任务记录中的临时机器路径，限定暂存并扫描，提交后合并最新master并验证。
