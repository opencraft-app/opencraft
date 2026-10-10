---
id: desktop-interaction-remediation
type: task
scope: 修复本机桌面观看续期与控制反馈，明确隐藏和关闭，保留授权和输入撤销不变量。
triggers: ["desktop interaction remediation", "云桌面交互整改", "desktop viewing renewal"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: ["opencraft/plugins/cloud-desktop/src/controller.ts", "opencraft/plugins/cloud-desktop/src/session-wire.ts", "opencraft/apps/local-agent-host/src/desktop/local-desktop-service.ts"]
status: retired
reviewed_at: 2026-10-06
review_due: 2027-01-04
revision: 1.0.0
precedence: task
derived: false
---

## goal
按上一轮诊断整改桌面的完整观看与控制交互，而非仅调整加载动画。

## non_goals
不替换或重启在线预览、不提交推送、不执行真实桌面输入、不修改 Vela/TAT 授权、不移植私有 WebRTC 服务；本机剪贴板仍需独立原生 capability，不能用图标冒充接通。

## requirement_ids / requirement_refs / requirement_excerpt
unknown；用户“整改”授权上述分析范围的实现，不授权部署。

## interface_refs / data_structure_refs
DesktopViewController 拥有意图和输入绑定；Host attachment 的短期观看授权由后端续期；独立桌面 socket 承载 capability-gated renewal，不借 Chat 消息维持观看。
Panel registry 可显式声明 inactive residency，Renderer 接收 active 投影；隐藏撤销输入，关闭销毁连接，不能全局保活所有插件。

## history_context
current_design_refs：cloud-desktop-plugin、platform-architecture 桌面及 Panel ownership、design/invariants WSP-36；正式域映射 agent-gateway-runtime。
relevant_evolution：desktop-interaction-diagnosis 隔离证明客户端五分钟退休不会恢复；固定 Codex 26.930.31428/build 12913 原始 panel 拆分 intent 与 acknowledged input。
superseded_refs：申请中的 Cancel 呈现与单纯五分钟 viewer 销毁；不将安全撤权归类为可重试网络问题。

## acceptance / validation
五分钟后同一授权观看可继续，服务端重验 Thread/物理身份；续期失败/超时/旧回复/关闭不能复活观看或输入。接管立即投影停止意图但授权前没有输入；停止与失焦保持立即撤销；窄屏文案稳定。
相关模型/协议/Host/renderer 单测、两端 typecheck/boundaries、Web 构建与真实组件浅深主题/触控验证；只隔离外部授权媒体边界，不能称作 Mac/iPhone 实机完全一致。

## affected_paths / scan_scope
桌面插件、Host 本机桌面、协议 capability、Workbench Panel renderer/presentation、相邻测试/smoke、正式桌面设计/不变量/域文档。保留既有 dirty catalog 与交付回执。

## required_context / context_receipt
根/OpenCraft AGENTS、maintenance Skill 及 verification、Task 模板、design/README、cloud-desktop-plugin 全文；platform-architecture 1-220 桌面边界；frontend-runtime-openspec-i18n 邻接及 host-desktop-backend/session-wire/local-desktop-service 测试。
Router 因 renewal 命中 subscription-entitlements；已读该 must_read，确认计费续费与本任务无关，不触及其 deferred 或行为。

## decisions / risks
独立观看 socket 的服务端确认更新期限；没有 capability 的旧端不发未知续期消息。续期不能替代输入授权或扩大信任边界。只桌面显式选择 inactive residency，其他工具不改变卸载策略。
参考 token/motion 维持已有来源；触控仍保留44px命中区。不通过复制默认底层手势声称输入完全等同。

## evidence
- 最终 `npm run test:cloud-desktop`：107项通过；额外Panel/Shell/workspace相关70项通过（包含与桌面套件重复的用例，不累计成独立总数）。
- Web、local-agent-host、cloud-desktop、workbench-panels-react、appserver-protocol typecheck通过；boundaries、i18n、diff whitespace通过。
- 最终 `build:web:release`通过，保留原有chunk大小及静态资源告警，不作为部署。
- 最终浏览器真实plugin/controller/Shell/当前release CSS验证通过：浅、深、扩展主题，中英文，720/320按钮与1280/390 Shell；重复隐藏/重开、工具切换、控制释放、正常工具卸载、关闭恰好释放一次。桌面重开实际位于可视viewport内，不以已挂载/有面积冒充可见。
- 隔离截图产物 `/tmp/opencraft-desktop-ui-dxGK3u`；390px重开截图已人工查看。Chromium与原生库使用已确认工具缓存，未安装或修改系统；fixture UI prefs使用真实runtime与隔离Memory store。
- 文档校验与工作树显式change-impact映射通过；staged检查通过但staged集合为空，不以它代替工作树检查。Context audit 33项及audit命令通过。全局Context catalog/校验仍有历史错误，27项测试中的4项仍失败；本Task定向校验没有新增错误，不改无关历史文件。

## handoff
本Task实现与隔离验收结束，退出默认路由；长期规则已回写cloud-desktop-plugin、platform-architecture、WSP-36及agent-gateway-runtime正式文档。
源码未提交/推送，在线服务和Web仍为先前版本。下一次用户明确要求替换时需按self-hosted-preview技能同时处理Host/backend与Web，不能仅交换静态文件声称观看续期上线。
没有执行真实桌面输入、调用TAT或公开多租户授权。noVNC与Codex的滚轮/捏合手势及本机原生剪贴板仍有独立差距，本Task不声称100%复刻、Mac/iPhone实机或弱网验收。

## checkpoint
stage：源码实现和隔离验收完成，未部署。
verified：上述测试、构建与真实Shell浏览器回执；多期限单观看、确认前阻断输入、隐藏撤权及迟到结果不复活。隐藏桌面不改变普通工具滚动/卸载策略。
unverified：在线新版本、原生输入/剪贴板及Mac/iPhone实机、弱网、生产授权。
discard：早期smoke资源loader、Cancel定位、缺UI preference provider及未等待Shell可见几何的失败/中间回执；最终使用当前CSS的完整序列通过，不保留错误预期。
restore：没有在线服务变更，现有预览不动。
next_action：等待明确部署指令；保留当前已验证源码，按后端与Web共同变更交付。
