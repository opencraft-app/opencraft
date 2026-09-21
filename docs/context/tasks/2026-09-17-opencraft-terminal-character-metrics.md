## goal
修复预览终端字符超出网格，扩充 WSP-21 字符度量不变量。

## non_goals
不清空/输入用户终端，不改 shell/session/PTY 协议，不覆盖 xterm 内部行补偿，不打包发布。

## requirement_refs / context_receipt
用户确认预览问题并要求按 Codex 补不变量后实施。已读 OpenCraft AGENTS、维护/React/baseline-ui/TDD 验证原则、原 terminal-fit Task Pack、WSP-21、当前 TerminalPanel、FitAddon、CharSizeService/WidthCache/DomRenderer。Router 无 must_read；本次在 terminal plugin/styles/tests 有界定位。Codex xterm-output-panel 使用 tracking-normal 与 letterSpacing:0。

## evidence
真实预览 CDP 9497：host 1145px，screen 1123px，156 个字符的 span 1144.453125px；body/xterm 继承 -0.14px tracking，row compensation +0.136218px。Canvas CharSize 与继承 CSS 的 DOM WidthCache 不一致。旧 screen≤host 验收不足。

## acceptance
真实 TerminalPanel 满行字符/光标不越 screen；正文负/正 tracking 不影响网格；resize、字体变化、隐藏重显；聚焦测试/类型/构建。用户终端原样保留。

## stage
完成。新增边界测试先失败后通过；终端 8/8 测试、Terminal/Web typecheck、boundaries、Electron build、文档与 diff 检查通过。

## verified
- 新增可重复 `npm run smoke:terminal-geometry`：真实 TerminalPanel/xterm/app CSS，仅 PTY boundary 替身，包含旧继承负例；DPR 1/2 各 14 个案例覆盖正负 tracking、三种宽度、ASCII/宽字符、字体切换与隐藏重显。
- 旧继承负例超过 20px，修复后落入 xterm 5.5 DOM WidthCache 的可计算舍入范围：32 字符 integer offsetWidth 带来每 cell ≤0.5/32px，加 canvas/layout ≤1px。未改变 padding/cols 或覆盖内部 row 补偿。
- 当前用户预览原位仅加载相同 CSS 并触发已有字体重测；终端 DOM identity 与输入 text 均不变。screen 1123px，156 字符推进宽从 1144.453125px 变为 1124.953125px；剩余 1.953125px 是已记录的舍入差，而非声称严格零误差。

## handoff
源码与构建已更新；用户当前预览应用了临时等价 CSS 热修复，刷新后应使用新构建。未重启 shell、未输入/清空终端；先前签名分发包未重新生成。快照 /tmp/opencraft-terminal-metrics-fixed.png。
