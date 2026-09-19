---
id: opencraft-native-speech-20260915
type: task
scope: Mac Electron 原生语音输入与客户端设备选择。
triggers: ["opencraft", "native speech", "voice input", "microphone"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/docs/platform-architecture.md
  - opencraft/design/native-speech/task_plan.md
status: active
reviewed_at: 2026-09-15
review_due: 2026-12-14
revision: 1.0.0
precedence: task
derived: false
---

## goal
Mac原生Speech输入，共用Composer事务且无模型/Codex依赖。

## non_goals
不自动录音/读取认证/调用私有转写、不承诺全语言离线、不提交发布。

## requirement_ids / requirement_refs / requirement_excerpt
用户指定Mac Electron原生Speech adapter，保留取消、草稿归属与迟到保护，检查supportsOnDeviceRecognition。

## interface_refs / data_structure_refs
SpeechInputProvider、ComposerTransientTextInput、可信desktop preload、SpeechRecognition/CoreAudio设备UID。

## history_context
current_design_refs：opencraft/docs/platform-architecture.md。
relevant_evolution：Web Speech constructor存在但Electron识别服务不可靠；BB默认转写依赖其他认证，不采用。
superseded_refs：Mac默认BrowserSpeechRecognition路径。

## acceptance
Mac使用native bridge；无需模型即能启动输入事务；不授权probe；取消/换草稿/卸载隔离late事件；设备偏好持久化；系统报告离线能力；签名bundle可运行helper。

## affected_paths
Electron Main/preload/native helper、voice-input extension、桌面设置/打包、测试与设计。

## required_context
路由误匹配CTL adapter词汇，未触及控制面。

## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| opencraft/AGENTS.md | 服务边界 | 独立workspace/门禁 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | 所有权 | 资源/取消 |
| opencraft/.agents/skills/opencraft-maintenance/references/verification.md | QA | 原生与模拟证据 |
| opencraft/docs/platform-architecture.md | 平台port | Main/Composer边界 |
| docs/context/project/services/ctl.md | must_read误匹配 | 不扩范围 |

## evidence
现有voice事务已定位，官方SDK支持SpeechRequest/CoreAudio与端侧能力检查。
实际SDK/helper/preload probe通过，无录音无权限请求；20项聚焦测试、完整gate、签名bundle/helper严格校验及隔离合成桌面验收通过。

## risks
系统权限与语言服务可用性必须实测；probe不能冒充真实识别成功。真实麦克风验收需用户授权。

## validation
TDD、类型/边界/完整gate、native probe、隔离签名桌面；真录音单独说明。
documentation、设计影响检查与33项context-audit测试通过。catalog和context测试4项受既有Task Pack schema/中英文摘要/指令预算/历史hex扫描影响，未拓展清理。

## decisions
native helper隔离机器资源，客户端设备偏好，不把音频作为LLM附件，不回退不可靠Electron Web Speech。

## scan_scope
opencraft Electron/voice-input/Composer/设置与Xcode官方SDK。

## scan_output
opencraft/design/native-speech/findings.md。

## handoff
实现与无录音验收已完成；未变更用户认证、模型数据和旧预览，未提交推送。真实系统授权和麦克风识别等待用户确认，不宣称已验收。

## checkpoint
stage：交接；verified：层次/SDK、输入事务、取消/迟到保护、偏好重启、构建与签名；unverified：真实麦克风、系统权限决定及实际识别。
