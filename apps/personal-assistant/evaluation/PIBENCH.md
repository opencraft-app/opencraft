# π-Bench：公开管家评测接线

2026-11-10 用户选择优先接入长期目标与主动服务基准。参考
[官方仓库](https://github.com/Simplified-Reasoning/Pi-Bench)，固定源码
`4f545be5d289b28ff022d2904d455007358ed3b7`，而不是随 main 漂移。
这是独立公开 benchmark，与本产品早期使用的 Pi Harness 没有关联。

## 为什么选它

上游包含五种 persona、100 项任务、跨任务依赖、用户隐藏需求和持续工作区，
提供用户模拟器、完整性和主动性评分。它比单次问答更贴近管家，但不能替代
我们自己的取消/重启/幂等/授权等系统契约测试。

## 当前真实接线及限制

`pibench/pilot.py` 直接导入固定上游的 UserAgent、BenchmarkRunner 和
TraceEvaluationRunner，替换的只有被测助理 channel。消息经
`pibench/channel.mjs` → 产品公开 socket → LocalRunner 的主助理、委托执行、
记忆模块。没有改成裸模型调用、注入 planner 替身或使用上游 NanoBot。

首轮是 **capability-limited dialogue pilot**，选择 researcher 原序前 3 题。
原始题目和模拟器生成的追问不改写，hidden intent/persona/判卷资料不传入产品。
同一 episode 使用一个全新 profile，自动记忆学习保持启用。进度消息不作为最终答复；
等待当前接待和工作进入静止/待答状态后，把真实可见回复合并交给用户模拟器。
终止条件由上游模拟器决定；其 `COMPLETED` 只表示对话结束，绝不是成功得分。

以下偏差必须跟随每份结果，不称完整或榜单成绩：

- 缺少 AppWorld、Brave 搜索、通用工作区文件写入。不能把本地 publish_note 当成模拟应用里的发信/下单。
- 每次官方 `/new` 通过产品 `conversation.create` 创建独立即时上下文；身份、记忆和后台工作保留在同一 profile。
- 模拟用户和评分使用显式授权的 DeepSeek Flash Chat Completions，替代上游默认 GPT-5.4；有同模型评价偏差。
- 产品主聊/委托仍使用 Codex + DeepSeek Flash，后台记忆/摘要沿配置 hy4/none。
- 每题最多 6 轮，产品回复 180 秒，整 episode 900 秒，评分 300 秒；模拟器网络重试和意图解析均最多 2 次。
- 上游 checklist 评分保持其 5 次解析上限；总评分截止仍生效。所有失败和未跑项保留。
- 评分 trace 只含真实可见对话，尚未转换原生工具轨迹或展开附件。后续需要完整 trace adapter，不能凭模型说“完成”补造工具证据。
- 3 题无跨任务依赖，不能检验长期目标管理或完整 100 题能力。未测长期能力不记零，也不记通过。

上游固定版本 PROC 取推断/匹配到的隐藏意图覆盖集合比例，并包含依赖聚合逻辑。
代码还保留早期轮数/消息长度计算，不能误把 legacy 值当当前主分数。
COMP 使用上游 checklist 判定；均须结合原文与实际工具证据解读。

## 复现

使用隔离 Python 3.11 环境，安装固定上游的 Python 包；不要启动自带 NanoBot。
本轮安装了 Python 3.11.14 / uv 0.9.8，uv 发布资产经其 SHA256 文件校验。
依赖快照另存 run 目录 `python-dependencies.txt`。准备显式私有模型 profile 后：

```bash
python evaluation/pibench/pilot.py \
  --upstream /absolute/pinned/Pi-Bench \
  --model-profile /absolute/private/all-codex-profile \
  --node /absolute/node \
  --output evaluation/runs/pibench-dialogue-NEW
```

默认仅检查接入条件，不读模型凭据、不发模型请求。`--dialogue-probe` 显式执行能力受限的诊断。
首轮在任务结束的 `/new` 处失败，原始记录保留。当前已接入公开会话创建接口；
第二轮三题均进入执行，其中一题超时、后两题正常结束。仍无正式分数。
见 [首轮记录](PIBENCH-RESULTS-20261110.md)和[会话修复复测](PIBENCH-SESSION-RESULTS-20261110.md)。

输出必须为新目录，保留 plan、产品输入/可见输出、官方模拟器日志、判卷和
产品 profile。manifest 包含实际源码指纹；源码 dirty 时不能声称为纯提交测试。
开发接线测试：`node --test evaluation/pibench/channel.test.mjs`。

## 完整接入的所有权

| 部分 | 所有者及边界 |
| --- | --- |
| 用户原话/追问、隐藏要求、停止、评测 | 官方 benchmark；隐藏数据只在 evaluator 进程 |
| 目标、工作、等待、记忆、交付 | 现有产品 owner；评测器不代写数据库/改计划/选择答案 |
| 原生线程与执行 checkpoint | Codex；不增加另一套执行状态 |
| 模拟邮件/日历/购物等状态 | AppWorld；产品只经受控工具端口调用 |
| 工具授权/版本与未知结果处理 | 原业务边界校验；不能将新外部写工具标为可安全重放 |
| 任务资料和生成文件 | 限定 episode 工作区；不能暴露 task.yaml、评分脚本或宿主私有文件 |

下一阶段先补受控只读搜索/资料桥及真实工具轨迹转换，再接 AppWorld 的副作用回执，
明确超时后未知结果如何对账。不同任务会话现已共享记忆并隔离即时上下文；后续
跑包含依赖的完整 persona 20 题，最后扩至五 persona。不能仅在 Codex 配置里挂 MCP
绕过产品的工具授权和执行收据，再把成绩归给完整管家。

## Conversation boundary update

The product now exposes `conversation.create`; every upstream `/new` creates a
new explicit conversation ID in the same profile. The channel keeps per-session
history and waits only for that conversation's work. All conversations are saved
in product evidence. The v1 reset failure remains unchanged in its original run.
This removes the lifecycle blocker, not the missing AppWorld/search/workspace
or tool/attachment trace adapters. Default invocation remains a no-call readiness
check; `--dialogue-probe` explicitly runs the limited pilot.
