# π-Bench 会话接口补齐与复测

本次补齐了产品公开的会话创建/寻址接口，官方 `/new` 不再阻断后续题目。
这仍是能力受限接线试跑，没有正式 benchmark 总分。

| 原序题目 | 官方 runner 状态 | 返回的交互轮数 | 观察 |
| --- | --- | --- | --- |
| researcher_task_001 | ERROR | 0 | 第一条答复超过 180 秒；迟到结果保留在原会话 |
| researcher_task_002 | SUCCESS | 4 | 正常终止对话，随后成功创建下一会话 |
| researcher_task_003 | SUCCESS | 6 | 正常终止对话，最后的 reset 也成功 |

`SUCCESS` 是模拟器的会话终止状态，不是任务内容通过评分；不能换算成 2/3 正确率。
三题均尝试执行，notRun=[]。共创建4个新会话（最后一个为空），返回10轮回复，
11项工作最终完成；结果审计没有发现工作消息跨会话，phaseErrors={}。
自动学习保持开启，最终 memoryEpoch=11；这证明学习状态持续存在，不证明记忆语义正确。

第一题具体路径：首次与第二次 execution 都报告 `model-timeout exceeded 60000 ms`，
主助理各继续一次，第三次成功并产生真实笔记。最终 delivery 在输入后 **187587 ms** 接受，
超过固定180000 ms等待上限。没有提高截止时间掩盖失败，没有把迟到结果补回原评分轨迹。
这是单次模型/执行截止、自动续接和整体用户等待预算之间的剩余问题。

全题评分因第一题没有成功交互 trace 而失败，原 scoringError 保留。
另用固定版官方 ProactivenessEvaluator 离线诊断第二、三题：各3项隐藏意图覆盖均为0，
但两题 include_in_overall=false、scored_task_count=0，overall=null；不能报为总分0。
附件正文仍未展开，工具执行没有转换到官方轨迹，现阶段无法把诊断数字直接解释为记忆质量。

真实执行沿产品公开 socket → Reception/Work/Execution/Memory 原 owner，
主助理和委托为 Codex + deepseek-v4.1-flash-1017，后台沿显式 hy4/none 配置。
官方 repo 固定为 4f545be5d289b28ff022d2904d455007358ed3b7；任务/模拟器提示未重写。
模拟用户与judge采用同一DeepSeek模型，区别上游默认GPT-5.4，存在同模型偏差。
缺少AppWorld/搜索/通用工作区工具、工具轨迹和附件正文桥接；尚未跑依赖任务链或完整100题。

产物在 [v2 run](runs/pibench-dialogue-20261110-v2/result.json)：
plan、product-evidence、原官方日志、timeout-audit、diagnostic-recovery、audit、Python依赖快照。
152份运行源码已存 source-snapshot 并逐份匹配启动指纹。运行时有其他工作流的stdio未提交文件，
不称纯提交测试；最终版本随后修正了旧 History.view({limit}) 调用兼容性，未重复调用模型。
扫描运行产物和隔离profile共1118文件，密钥命中0、跳过0；没有修改生产部署。

实现契约见 [conversation lifecycle](../docs/conversation-lifecycle.md)。
原v1失败记录保持原样。

验证记录见 [verification](../evidence/conversation-lifecycle-20261110/verification.json)。
首次全量412项中411通过，发现并修正旧 History.view options 兼容性。
随后并行全量410通过、2失败：文件监听测试清理时仍有写入（已修正测试关闭顺序），
以及1秒执行预算在并行负载下超时（串行保护用例复跑通过，未放宽预算）。
最终会话及事件专项14/14、评测桥3/3通过，170模块语法检查与修改文件格式检查通过。
所有失败日志保留；不宣称有一次最终全量全绿结果。
