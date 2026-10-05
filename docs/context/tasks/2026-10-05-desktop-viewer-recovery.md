---
id: desktop-viewer-recovery
type: task
scope: 本机桌面观看的有限自动恢复，不重放资源准备或聊天执行。
triggers: ["desktop viewer recovery", "桌面断线恢复", "本机观看重连"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/docs/cloud-desktop-plugin.md"]
status: retired
reviewed_at: 2026-10-05
review_due: 2027-01-03
revision: 1.0.0
precedence: task
derived: false
---

## goal
对已成功观看后发生的传输中断，退役旧观看并重新授权建立新连接；有限退避，失败仍可手动恢复。

## non_goals
不更新或重启预览，不开放公网，不实现 TAT/控制权；不自动重试 Vela 资源准备或未知提交结果；不宣称手机弱网已验收。

## requirement_ids / requirement_refs / requirement_excerpt
unknown；用户“继续开发”，延续本机云桌面实现。当前明确缺口是观看断线只支持手动重连。

## history_context
current_design_refs：opencraft/docs/cloud-desktop-plugin.md、opencraft/docs/platform-architecture.md。
relevant_evolution：desktop-instance-authority 已验收本机只读实链，未部署；观看与执行生命周期分离。
superseded_refs：既有手动重连保留，不能把所有失败归为可自动重试。

## interface_refs / data_structure_refs
DesktopBackend、DesktopConnectionSnapshot、DesktopRfbSession、DesktopViewController、HostDesktopBackend；只有实际 adapter 声明可安全重复获取观看 attachment，才可启用恢复。

## acceptance / validation
观察成功后的异常传输中断可获取新授权，旧票据/控制 lease 不继承；协议/安全/准备失败保持手动恢复。连续闪断退避有上限；切身份、关闭、取消和迟到结果不复活旧观看。聚焦测试、两端类型检查、边界/i18n 与真实浏览器中断恢复验收。

## affected_paths / scan_scope
opencraft/plugins/cloud-desktop、workbench-web/runtime/host-desktop-backend.ts、相关 tests/scripts/docs。

## context_receipt
根/OpenCraft AGENTS；维护技能及 verification；Task 模板；platform-architecture 的桌面与恢复边界；cloud-desktop-plugin；design/README 与 invariants；frontend-runtime-openspec-i18n 邻接卡及桌面测试/i18n 生成入口邻居；agent-gateway-runtime 正式设计的稳定不变量（impact 映射要求）。
Router 查询 `OpenCraft local desktop viewer weak network recovery attachment ownership reconnect` 无匹配；随后在 cloud-desktop 与对应测试执行 reconnect/retry/disconnected 的有界精确检索。

## decisions / risks
本机 prepare 只分配短期观看，不执行远端资源创建；Vela prepare 可能产生未知 POST 结果，不能自动重放。重试预算属于观看 controller，错误分类属于 wire/media，授权属于后端。当前只处理已建立观看的异常传输中断，不对未知错误字符串分类。

## checkpoint
stage：本轮分层恢复、实链/可见画面验收及文档沉淀完成；源码和构建产物未替换当前预览。
verified：桌面测试 85 项通过，neutral plugin、Web 与 Vela adapter 类型检查、边界/排版、i18n 与 Web 构建通过。本轮真实 Codex/native/browser 观看中断恢复通过：第二条授权观看流、新 canvas、1440×900/RGBA [32,128,224,255]，实际可见 691.1875×432 且包含于面板内，截图已检查，仍只读；一个 engine、一次本地合成模型请求，关闭观看保留 Thread。
unverified：手机真实弱网/休眠、页面可见性探测、公网授权、真实 TAT、控制权；Web 构建有既有大包/动态导入警告，不能称全仓门禁通过。
next_action：用户决定接入预览前不发布；手机恢复/公网授权/控制权属于后续范围。
gate_receipt：文档检查 errors/warnings/断链均为零；显式 changed-file impact 通过，需维护者合入审阅；staged 空集合只证明无 staged 变更。根 context 单测 26 项有 4 个既有失败，catalog/validator 仍报告 5026 个全仓错误，本 Task 无错误；context-audit 33 个测试通过，discovery 为 needs_agent_review/not_assessed，不是完整评审。没有宣称全仓 gate 通过。
failure_receipt：第一次 patch 的文档锚点未匹配，未产生部分写入；修正后应用。首次 changed-file impact 缺少映射正式 Domain，补充真实恢复不变量后通过。第一次恢复烟测像素/连接通过，但截图暴露未加载正式样式，不能作为可见画面证据；脚本现消费当前 checkout 的 Web 构建 CSS，并增加真实显示尺寸/容器包含断言，第二次通过。

## runtime_receipt
最终隔离证据目录 `/tmp/opencraft-local-desktop-smoke-LHfGDh`；截图 `desktop-acceptance.png`。旧目录 `/tmp/opencraft-local-desktop-smoke-BIGd71` 仅保留失败视觉证据。仅临时启动既有 disabled 的 xvfb/observer/proxy；本轮只断开验收创建的第一条观看流，不动 Chat。服务已停止并保持 inactive/disabled。observer 在收到 SIGTERM 后自身返回 2，被 systemd 记为 failed（journal 确认，不是画面故障）；已清除此失败标记，不改 unit。当前预览 MainPID1048792 未变。没有安装新包、借用真实凭据、真实账户请求、TAT 或收费推理。
