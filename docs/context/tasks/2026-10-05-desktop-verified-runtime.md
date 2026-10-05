---
id: desktop-verified-runtime
type: task
scope: 将后端固定 TAT 观看通道接到可核验的原生只读桌面进程。
triggers: ["desktop verified runtime", "桌面进程核验", "observer incarnation"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["ctl/docs/cloud-desktop-resource.md", "sandbox/docs/desktop-viewer-broker.md"]
status: retired
reviewed_at: 2026-10-05
review_due: 2027-01-03
revision: 1.0.0
precedence: task
derived: false
---

## goal
依用户“搞啊”，推进真实后端观看闭环，先补远端进程身份与原生只读策略核验。

## non_goals
不重启预览、发布、执行云/TAT 操作或开启控制；不将页面绑定当会话授权，不将 CTL 准备代次当物理身份。

## requirement_ids / requirement_refs / requirement_excerpt
本会话“下一步是？”后“搞啊”；编号 unknown。先真实授权与观看，再实现控制。

## history_context
current_design_refs：ctl/docs/cloud-desktop-resource.md、sandbox/docs/desktop-viewer-broker.md、opencraft/docs/cloud-desktop-plugin.md。
relevant_evolution：独立只读 5901 与 broker/wire 已实现但未组合；必须核验实际连接进程而非固定端口或页面声明。
superseded_refs：旧 desktop/session 不是授权源。

## interface_refs / data_structure_refs
Authority.Resolve/OpenVerified；CTL loadDesktopInstance、desktopSession；TencentCloudProvider.OpenDesktopObserver；native x11vnc argv、Linux process/socket 身份。

## context_receipt
根/CTL/Sandbox/OpenCraft AGENTS、维护技能与 verification、agent-gateway-runtime 和 ctl-service-detail；adjacency 索引及 frontend-runtime-openspec-i18n（核对 desktop provider test）；Task/Checkpoint 模板；三个正式 desktop 文档和 platform-architecture 云桌面段落。

## acceptance / validation
真实进程与连接匹配，非只读进程拒绝；重启/替换关闭旧 stream，取消/关闭只回收自身连接。原生隔离正负对照、Go 单测/race/vet、文档/影响检查；云上结果仍需另行授权。

## affected_paths / scan_scope
ctl/pkg/instance、sandbox/internal/provider、桌面正式设计；不修改生产路由或部署。

## decisions / risks
首次 route query 无匹配，随后精确搜索并用 agent-gateway-runtime/ctl/sandbox 命中路由。真实 CTL DAO 只有 principal→Instance→Sandbox；当前 OpenCraft Server 是 legacy Host 的客户端投影，没有可消费的后端 Conversation→Server 授权目录。本轮不得补一个信任 client DTO 的默认 Authority。
本轮转向可安全完成的物理观看链路，继续保持 capability 隐藏；授权组合缺口不以空端口掩盖。

## checkpoint / handoff
stage：物理只读观看链路源码完成，最终门禁收尾；完整产品入口未接通，不宣称云桌面已可用。
verified：native root verifier + 非 root Xvfb/x11vnc 核验；PID/start/argv/UID、X11 peer、已接受 TCP inode、挑战 MAC、原始 RFB 双向透传及进程变化回收。源脚本编译嵌入，资源准备独立启动观察服务；先准备后发布，失败/归属变化不接纳迟到结果。Go 打开与观看寿命分离，取消不滞留，也不误关完成的观看。67 个 TS tests、CTL/Sandbox 全包 tests、两端相关 vet、provider/broker race 三次、native CTL race 三次、native Go↔Python/TAT wire race 三次及 observer transport race 十次通过。
unverified：生产会话授权目录、实际 TAT/systemd hardening、云上安装、控制执行器、弱网恢复和多副本。没有 commit/push/部署/重启；维护技能促使使用真实原生与跨语言验收，而非只检查字符串或注入 grant。
discard：不存在的 ctl/pkg/store（已改读 model/instance）；首次无匹配 route 不作为授权来源。首轮原生握手接受前 inode=0 被误判为失败，已改为有界等候 accept，实际 UID/PID 匹配不放宽。文档补丁首轮锚点不匹配，没有部分写入，按实际行修复。audit 指定 output 后 stdout 为空造成 JSON pipe 失败，jq 在机器未安装；改为读取隔离 JSON 的状态字段，不打印完整报告。
restore：既有 viewer/session 协议保持，控制仍禁用。初始预览记忆已过期：当前 port 80 为 opencraft-ssh-connect-menu-20261005-preview.service、PID 1048792，active；本轮未动它。
next_action：落实 OpenCraft 会话→执行 Server→实例的后端授权绑定，并与本轮 verified observer、broker/产品 viewer 组合；在缺少权威记录前不发布能力。有界检查 collaboration 的 Server/Computer：Server 是产品空间，不是执行 Server；Computer 有持久 TAT/实例关联和成员权限，但不能未经显式映射直接当当前 OpenCraft Conversation 目录。本轮只读其 AGENTS、schema 和 Repository，未改该服务或借用其身份。

## evidence
正式 documentation errors/warnings 空、显式 docs-impact passed；staged impact 空集合不作为覆盖证据。新 TaskPack 初次漏 requirement_ids，补齐后 root context 回到历史 5025 errors，本文件 errors 空。root Context 26 tests 仍有既有四项失败，context-audit 33 tests passed。audit discovery 完整报告 /data/opencraft-desktop-runtime-audit-UWL6Kn/report.json：needs_agent_review / not_assessed / Unknown，无 assessment errors，未有 Owner assessment，不能称审计 gate passed。
