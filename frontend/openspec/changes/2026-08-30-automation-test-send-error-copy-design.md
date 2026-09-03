# 自动任务测试消息错误提示精简 Design

**Status:** 已实现并通过自动化验证。

**Size:** S。仅调整自动任务“发送测试消息”失败 Toast 的错误详情展示，不改变 Hermes 命令、通道判断或日志。

## Goal

失败 Toast 只展示用户可理解、可操作的本地化提示，不再把未识别的 Hermes 原始英文错误拼接在文案后方。

## Behavior

- 保留当前按通道生成的失败提示，例如微信仍提示先向 Hermes Agent 发送任意消息。
- 已识别并已本地化的错误详情继续展示，例如“命令执行超时”“未知通知通道”。
- 未识别的原始错误（例如 `hermes send: Weixin ...`）不进入 Toast。
- 原始错误继续保留在命令执行链路和网关日志中；本次不修改错误抛出方式。
- 国内站与国际站采用相同过滤规则，国际站继续展示已有英文 fallback 和已翻译详情。

## Implementation

在 `formatKnownTestSendError` 的兜底分支返回空字符串，使 `formatTestSendError` 对未知错误退回既有 fallback。保留现有超时、未知通道、权限不足和命令缺失分支。

## Verification

- 用截图对应的 Hermes 原始英文错误补失败测试并确认 RED。
- 最小修改后确认该用例只返回 fallback。
- 回归国内/国际自动任务面板测试、类型检查与差异检查。
