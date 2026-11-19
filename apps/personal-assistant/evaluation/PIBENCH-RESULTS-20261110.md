# π-Bench 首轮公开任务接线实测

**跑了真实产品，但没有得到完整公开 benchmark 分数。** 原计划 researcher 前三题；
第一题完成 4 轮真实对话，后两题因会话重置契约不匹配未运行。失败记录不覆盖，不用
已跑一题替换三题分母。没有部署 Join，没有修改生产领域代码。

## 版本与证据

- 官方仓库：[Pi-Bench](https://github.com/Simplified-Reasoning/Pi-Bench/tree/4f545be5d289b28ff022d2904d455007358ed3b7)。上游题目、用户模拟器和判卷逻辑未修改。
- run：[pibench-dialogue-20261110-v1](runs/pibench-dialogue-20261110-v1/plan.json)。原始 [result](runs/pibench-dialogue-20261110-v1/result.json)、[产品记录](runs/pibench-dialogue-20261110-v1/product-evidence.json)、[复核](runs/pibench-dialogue-20261110-v1/audit.json)。
- 运行时基线 `66aa2d4` 加未提交 adapter；adapter 随后提交为 `e96700a`。
  原有四项 stdio 工作树改动也在运行指纹中，未改动/提交它们。147 项产品与依赖文件运行前后哈希一致。
- 主聊、委托：Codex + `deepseek-v4.1-flash-1017`；后台记忆/摘要：`hy4` / none；自动记忆学习开启。
- 用户模拟器与意图评价：同一个 DeepSeek Flash，经 Chat Completions；这不同于上游默认 GPT-5.4。
- 范围、预算和不兼容项见 [接线协议](PIBENCH.md)。没有调用上游 NanoBot 替代我们的产品。

## 实际结果

| 项目 | 观察 |
| --- | --- |
| 计划 | researcher_task_001、002、003，原序 |
| 实际对话 | 001，4 轮，348,162 ms（约 5 分 48 秒，上游任务计时） |
| 上游单题状态 | `SUCCESS`：模拟用户满足其停止条件，不等于 checklist 全通过 |
| 后续题 | 002、003 `not_run`，没有发给模型 |
| 产品委托 | 4 项均 completed；业务阶段错误为空 |
| 单轮产品答复墙钟 | 61.6、136.4、51.8、77.7 秒 |
| 任务切换 | `Mid-episode reset is not supported` |
| 正式总分 | null；未取得 |

首轮题目是查找近期多模态工具使用论文。后续三次模拟用户输入分别要求技术要点、
开源/GitHub 状态、研究价值与跟进路线。它们来自上游模拟器，未由评测器补写。
产品明确说没有实时搜索工具，清单来自背景知识、链接未经验证；不能据此确认文献事实准确。

每次追问都触发新委托并生成一份本地笔记。结果正文有时只有“笔记包含这些内容”的摘要，
接线还没有展开附件；因此本轮可见对话不等于完整已交付内容。这是评测投影缺口，
不能把判卷看不到附件里的细节全部归咎为产品没有完成。

## 会话边界暴露的实际缺口

上游 `BenchmarkRunner._finish_task` 在每题结束也调用 `_reset_channel`，不仅启动时调用。
首版 adapter 对首次 `/new` 以新 profile 应答；随后明确拒绝重置。此前没有核对到这个
结束路径，导致原始 runner 结果在返回前抛错，批量评分又因为 002 没有 trace 抛错。

现在接线默认只做 **零模型调用的 readiness 检查**，明确报告不可完整运行，
防止重复消耗模型。修订 adapter 提前保存上游单题结果，再进入 reset；这些改动未重跑模型。
第一版失败仍原样保留。

产品 History 当前只有固定 `main` 会话，公开 socket 没有“开启新对话并保留记忆”的操作。
不能简单把 `/new` 改成空操作；那会让即时历史泄漏到后续题，混淆长期记忆与上下文直读。
也不能只换一个 profile；那会丢掉原目标、工作账本和异步回报归属。

正确接入需要由现有会话/历史 owner 创建新会话与当前选择，保留同一身份的记忆和工作。
历史、接待、交互、执行及消息仍携带各自原会话 ID，旧委托的回报不能因为切换而被改投。
评测器只调用这个公开操作，不直接改库。该产品能力本轮尚未实现。

## 评分复核

没有重新调用模型；[diagnose.py](pibench/diagnose.py) 对已经存在的第一题日志调用原版
ProactivenessEvaluator，输出另存 [diagnostic-recovery.json](runs/pibench-dialogue-20261110-v1/diagnostic-recovery.json)，保留原始错误。

- 第一题原数据没有 checklist / 工具评分项，原版 scorer 将其排除在 overall 外。
  它还作为后续 006 等任务的前置上下文；不能把第一题孤立成绩冒充长期任务成绩。
- 三个隐含需求在追问前均未被模拟器标记为 inferred/matched，单题内部覆盖诊断为 0/3。
  这不是“任务 0 分”：上游 overall 为 null，完整性也无独立分数，且附件投影和评价模型存在限制。
- 不用旧版轮数/长度公式计算的 legacy 值替换当前 PROC；不把 `SUCCESS` 当成 100%。

固定数据盘点：100 题中 30 题声明前置依赖，27 题带工具评分脚本、54 题带非空文字 checklist，
38 题没有 objectives。这些集合有重叠，不能相加。它说明正式评价须遵循整个依赖分组，
也须具备模拟环境，不能只抽几个开头的对话题宣称测完管家。

## 下一步

1. 补上述公开会话边界，验证旧工作回报与跨会话记忆归属。
2. 接受控网页搜索、任务资料和 AppWorld；副作用经过原授权/执行收据，未知结果不盲目重放。
3. 对齐工具轨迹和附件的真实评分投影，恢复官方任务资料入口。
4. 跑完整 researcher 20 题及依赖链，再扩到其余 persona；上游默认与替代 judge 分轨报告。

本轮验证：2 项 channel 测试通过、Python 语法检查通过、零调用 readiness 实跑通过。
真实失败没有重试成绿色，没有产生正式榜单分数，也没有重复跑既有 18 项自建场景来替代公开基准。
