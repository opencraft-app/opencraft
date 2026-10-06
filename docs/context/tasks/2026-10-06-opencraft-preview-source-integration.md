---
id: opencraft-preview-source-integration
type: task
scope: 将当前在线预览的桌面动效、原生控制与混元语音归并为同一集成源码，保留已合入侧栏和SSH功能。
triggers: ["preview source integration", "预览源码归并", "desktop speech merge"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/docs/cloud-desktop-plugin.md", "opencraft/docs/cloud-dictation.md"]
status: retired
reviewed_at: 2026-10-06
review_due: 2027-01-04
revision: 1.0.0
precedence: task
derived: false
---

## goal
用户确认预览是否被替换，并要求“合并一下”；统一开发源码，不再次回切或重启当前预览。

## non_goals
不提交/push/master合入，不更改凭据、服务数据、付费调用或正在运行的服务；不复制构建输出或其他工作树依赖。

## requirement_ids / requirement_refs / requirement_excerpt
unknown；用户“是不是预览被替换了？你得合并一下？”授权本轮源码归并。

## interface_refs / data_structure_refs
SOURCE.json 的路径/摘要是已部署 dirty overlay 的依据，不能仅凭相同 Git revision 认定源码一致。设计系统拥有动效，桌面controller拥有固定单次操作；voice-input与应用语音服务保持独立，不共用桌面授权。

## history_context
current_design_refs：cloud-desktop-plugin、cloud-dictation、platform-architecture、design/invariants。
relevant_evolution：昨晚 desktop-motion-634fcdab5 已重启验收；今早 hunyuan-desktop-634fcdab5 以其25文件快照为输入，添加原生后端与语音。已有master侧栏/SSH功能来自634基线；7d946仅补交付记录，产品源码完全相同。
superseded_refs：旧preview unit已停止，不能把昨晚的PID/build当作当前；旧b2a主工作树不能整体覆盖新预览。

## acceptance / validation
按在线 SOURCE 验证全部源码文件，昨晚25文件动效快照全部保持一致；新集成worktree保留当前原生控制、语音与基础功能。独立依赖安装、聚焦桌面/语音/SSH/侧栏回归、受影响类型检查、边界、headless构建与真实组件UI验证；不把隔离验收当真机/付费语音验收。

## affected_paths / scan_scope
限定在线SOURCE的opencraft源码清单及两方正式文档。用合入634的最新7d946作为基线；只归并两个任务各自的未提交文档和部署源码，不扫其他会话/凭据。

## required_context / context_receipt
根/OpenCraft AGENTS、maintenance Skill与verification、Task模板、frontend-runtime-openspec-i18n邻接和frontend/scripts/build-release-artifacts.test.ts；Router query opencraft current preview source merge desktop motion hunyuan 无匹配后读取已知两份SOURCE、prepare与speech任务/正式文档。精确检查实际80端口与新unit；不执行私有配置生成脚本。

## evidence / decisions
在线 build 20261006-hunyuan-desktop-634fcdab5，监听PID534254；原unit inactive。今早prepare明确读取昨晚motion SOURCE并校验全部哈希，已融合不是单独覆盖。为保护既有dirty工作树和预览来源记录，新建integrate/opencraft-preview-unified-20261006，源码路径 隔离集成工作树。

## checkpoint
stage：统一源码和集成验证完成，未再次替换预览。
verified：今早SOURCE保留motion和desktop overlay，再添加speech；基线7d946与634产品源码一致。25个motion文件全部字节相同，58个在线源码文件全部复制后重验SHA一致；没有locale/lock例外。新工作树有自己的1369项依赖，未借用旧node_modules/profile。正式文档同时保留master的SSH准入、原生桌面授权、固定激活动作、motion primitive与云听写/Draft写入边界。
validation_receipt：隔离交付记录中的 VALIDATION.json 为verified；全workspace typecheck、i18n、边界、headless release构建通过；288项聚焦测试287通过/1条件跳过/0失败。六组桌面motion和四组语音界面通过，语音仅物理麦克风与供应商为替身，无付费调用。文档0错误/断链，完整变更集的设计影响检查通过，保留Owner审阅提示；全仓Context有既有错误，本任务和两份新增motion Task诊断为0，不宣称全仓门禁全绿。
unverified：用户iPhone权限/识别质量、真实语音供应商、逐帧像素等同；本轮没有源码commit/push/master合入或预览发布。
restore：现有开发/候选/在线包保持原样；本轮仅创建独立集成工作树。
next_action：后续开发以integrate/opencraft-preview-unified-20261006工作树为归并入口，勿直接部署落后b2a工作树整包。需要Git提交/master合入时另取授权；当前服务仍opencraft-hunyuan-20261006-preview.service、PID534254、hunyuan-desktop-634fcdab5，源码归并无需重启。

failure_receipt：初次清单比较误预期locale/lock因语音变化，实际两文件同样完全一致，前置断言拒绝后改为要求全部25个motion文件一致，再创建工作树。初次设计影响命令只看提交差异得到空集合，已用完整dirty/新文件清单重跑，真实命中agent-gateway-runtime并通过。
