# 简化脚本安全提示并完善示例标识

## 目标

- 将脚本安全确认改为用户已确认的中文文案：“我已了解风险：脚本会直接在云端 Agent 环境中运行，并非独立安全沙箱；请仅运行你信任的脚本。”
- 国际站英文采用：“I understand the risks: Scripts run directly in the Agent’s cloud environment, not in an isolated sandbox. I will only run scripts I trust.”
- 为 Python 与 Bash 输入框的占位示例增加本地化首行“示例脚本：”。

## 范围

- 同步中文、繁中、英文、印尼语、西班牙语、日语和韩语资源。
- 同步聚焦组件测试、Task Pack 与 PRD。
- 不改变脚本执行权限、确认逻辑、脚本内容或运行时行为。

## 成功标准

- 国内站与国际站显示对应的新安全确认文案。
- Python/Bash 占位示例首行均显示本地化的“示例脚本：”。
- 聚焦组件测试、完整前端检查及文档校验通过。
