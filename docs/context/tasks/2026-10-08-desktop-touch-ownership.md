---
id: desktop-touch-ownership
type: task
scope: 桌面内部焦点交接与触摸几何事务整改。
triggers: ["desktop touch ownership refactor"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/docs/cloud-desktop-plugin.md"]
status: retired
reviewed_at: 2026-10-08
review_due: 2027-01-06
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_refs
用户本会话授权“好的 重构整改吧”：内部触控、软键盘焦点交接不得误撤销接管；尺寸变化不能误映射旧手势。

## non_goals
不提交、推送、替换预览、重启或操作真实桌面；不修改后端授权与界面视觉。

## history_context / interface_refs
现有 Panel 将 null focusout 直接撤销授权；指针 adapter 在移动时使用新几何映射旧起点。
控制授权仍归 backend/controller；DOM interaction owner 只判定离开；pointer adapter 拥有物理手势与几何失效。
current_design_refs：cloud-desktop-plugin.md；design/invariants.md WSP-36。

## context_receipt / scan_scope
已读根与 OpenCraft AGENTS、maintenance Skill 全文及 verification 全文、Task 模板、design/README、platform-architecture 入口与桌面专题相关段落。
Router query `opencraft desktop touch ownership refactor` 无匹配；有界搜索 cloud-desktop/src、对应 tests 与 smoke，未扩大参考仓库扫描。

## affected_paths / acceptance
cloud-desktop Panel、interaction-owner、pointer-input、聚焦测试、真实 noVNC 浏览器验收与正式专题文档。
内部 null 焦点交接保留既有授权；明确外部点击/焦点、窗口失焦/隐藏继续撤销；释放后不自动接管。
几何改变取消旧 tap/drag/pair，不撤销 grant，新手势需等待旧指针释放。

## validation / evidence / risks / handoff
源码整改与浏览器验证完成。第一轮47项测试46过，旧 Panel 测试将 null blur 当作撤销依据失败；按新产品不变量调整，保留停止意图与迟到授权检查。
实际 noVNC 链路进一步复现观看时原生触摸无兼容click，无法申请接管；媒体原生单指tap释放消费固定命令一次，不伪造click，拖动/双指/取消/捕获丢失退休命令。普通按钮保持click激活。
最终142/142桌面测试通过，插件与Web类型检查、平台边界及diff whitespace检查通过。docs-impact按本轮显式变更集合通过，文档校验无断链/未分类文档。
真实Chromium+noVNC+合成媒体/授权对端通过，证据 `/tmp/opencraft-desktop-input-3Qkk2L`：观看原生tap申请、取消与迟到grant、内部null焦点后打开键盘、IME原目标提交、单指/双指输入、停止/隐藏/撤权、光标生命周期。不是iPhone系统键盘、真实授权或用户桌面验收。
浏览器验收初次缺playwright解析与libgbm/libasound，复用已有隔离工具与明确LD_LIBRARY_PATH，未改系统；旧脚本等待已被新版视觉隐藏的Loading文案与inert按钮，改为真实phase/stage与DOM禁用断言。未以删除业务断言通过验收。
当前运行预览未变，未提交/推送/替换/重启。下一步用户批准后，仅将本轮改动合入现有预览基线并手机实测。
