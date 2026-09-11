# Multi-Bot Plan Quota Verification

## 验证结论

通过。本次改动已把每 Agent Bot 上限作为独立 Bundle/Pass 权益下发，并在 CTL 的目标 Agent 运行时内串行执行“Profile 计数 + 创建”。启航 Launch/Launch AI 为 5，巡游 Cruise/Cruise AI 为 10，主 Bot 计入数量；前端消费同一权益做提前提示，后端保留最终权威拦截。

## 已执行验证

- CTL Bundle 校验、实例 Bot 权益解析、Hermes Profile 并发锁、API 错误码、migration 种子和相关包编译检查均通过。
- 旧版 Bundle 导入兼容测试通过：四个现有套餐省略新字段时仍得到 5/10，其它套餐保守回退为 1，避免重新导入覆盖 migration 权益。
- 前端聚焦 Vitest：3 个文件、27 个测试通过；本机 localhost 解析异常时使用 127.0.0.1 启动测试 API。
- pnpm check 通过：i18n 结构错误 0，TypeScript diagnostics 为 175 current / 276 baseline / 0 new。
- pnpm build:cn 通过：Next.js 编译、TypeScript 检查和 96 个静态页面生成完成。
- 文档校验通过，无 broken first-party link；临时 Git index 下的 change-impact 校验通过；完整变更集 git diff --check 通过。
- PRD 相对 origin/master 的差异已复核，只增加 5/10 数量决策、实现边界、升级/降级规则和验收标准，并保留入口默认隐藏、Profile 真源与删除语义。

## 已知非阻断项

- 全仓 validate_context --build-catalog 及 context 单测仍被当前分支已有的旧 Task Pack schema、历史疑似明文项和英文段落阻断；本次 Task Pack 与 checkpoint 已补齐 schema，聚焦文档校验及 change-impact 均通过。
- CTL 全仓 CGO 测试受本机 Go 1.26/macOS Security framework 链接问题影响；CGO_DISABLED 的相关包测试和编译检查通过，未发现本次代码失败。
- 未在真实已部署 Agent 上验证套餐切换和公网创建行为；本次没有发布授权，源码验证不等于已发布。
- 本机没有全局 feai 命令，因此未写 usage-context；Native engine 可正常执行，未手写统计 payload。

## 交付边界

- 已归档上一项 multi-bot-hermes-source change。
- 当前 multi-bot-plan-quota change 进入待归档阶段后仍需用户明确要求才能归档。
- 未执行 Git commit、push、MR、GitOps、发布或生产变更。
