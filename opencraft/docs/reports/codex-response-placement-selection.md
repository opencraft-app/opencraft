# Web 回答定位策略：显式选择与状态所有权

日期：2026-09-08。参考：r3562 `local-conversation-thread-CShhuS2f.js` 的 `oO`、`OD`、`AD`。

## 本次选择

用户明确选择 Codex 的回答定位分支。Web 主入口显式传入
`scrollPolicy="response-placement"`；`ConversationProps.scrollPolicy` 改为必填，
避免遗漏接线时悄悄退回自然模式。自然分支仍作为独立、互斥的基线实现保留，
不与回答定位分支同时取得视口控制权。此选择不声称所有 Codex 账户都启用了同一功能开关。

这取代此前 `codex-scroll-policy-boundaries.md` 中 Web 选择自然模式的产品决定，
不撤销父子组件、测量事务、滚动控制器和 Composer 高度的所有权拆分。

## 状态边界

- 本地提交的定位快照允许定位时，由回答策略定位；定位完成进入 `static`。
- `prework_watch` 只在工作过程跟随内容溢出且满足原版观测条件时取得 `prework_follow`。
- `prework_follow` 转入最终回答时继承为 `user_follow`；否则转为 `static`。
- 显式贴底取得跟随权；最终正文增长本身不能从 `static` 取得该权利。
- 用户向上滚动超过原版距离阈值时退出相应跟随状态。
- 阶段由协议 Item 的语义决定，不能用正文长度猜测：原版 `AD` 在非 commentary
  agentMessage 出现时就进入 `final_answer`，即使尚未收到首个非空 delta。

本次对照增加了逐事件的 phase/follow 状态断言，发现并删除 Vela 阶段分类中的
`text.trim().length > 0` 条件。以前只比较几何位置的测试没有暴露这一差异。

## 验证范围

- 单测涵盖空最终 Item、空 commentary、正文持续增长不接管、贴底接管、向上阅读退出。
- 浏览器对照脚本在同样的消息和行渲染下运行原版函数体与 Vela 实现：
  单消息六篇文章、直接最终回答、主动贴底后继续输出、用户脱离、工作过程溢出转最终回答。
- 同时比较阶段、跟随模式、定位快照消费次数、滚动距离、留白和阅读锚点。
- 原版函数体来自本地参考快照；这不是两套完整桌面产品的端到端逐帧一致性证明。
- 发布属于单独步骤，本次代码接线不表示已上线。

本次结果：189 项单测通过，Web 类型检查通过；原版函数对照的 141 个事件边界
phase/follow 全部一致，稳定后的几何差异为 0px。动画瞬间最大采样差异 186px，
因此不声称逐帧完全一致。滚动 smoke（含连续提交、长 Turn、恢复）通过，出现
2 次暂态 ResizeObserver 通知告警，未发现空闲循环。

后续控制组证明上述瞬间差异不能直接归因为实现偏差。统一 RAF 时钟、输入和采样后，
结果及新增动画起点修复见 [逐帧对照报告](codex-scroll-animation-parity.md)。
