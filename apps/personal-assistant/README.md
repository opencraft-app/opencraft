# Personal assistant runtime

已按用户要求从已提交的独立 runner 合入内部发行版（来源见 [SOURCE.json](SOURCE.json)）。以下历史记录保留其当时的验证边界，当前接入以 [Bot 资源](docs/bot-resources.md) 和 [平台协议](../../docs/architecture/personal-assistant.md) 为准。

从仓库根运行 `npm ci`，然后 `npm test --workspace @opencraft/personal-assistant`；独立 CLI 为 `node apps/personal-assistant/bin/assistant.mjs`。依赖由仓库根 package-lock.json 固定。可信 Host 使用 `@opencraft/personal-assistant` 的 `startPersonalAssistant`，本机/HTTP 端口由 `@opencraft/personal-assistant/platform-port` 导出。“大家”提供显式申领、打开及停用；安装级 Host 通过 `./host` 托管已申领助理，使用原生私聊收发文本。实际运行需要安装级 Codex 配置；源码变更尚未发布，不会改动现有运行实例。

## 独立进程接口

`node apps/personal-assistant/bin/assistant.mjs serve` 提供与托管进程相同的 stdio 接口。CLI 与桌面/Headless 复用一个运行时，身份和授权仍由平台桥负责。协议、生命周期与限制见 [stdio runtime](docs/stdio-runtime.md)。

## 原实验记录

# OpenCraft Superapp：独立无界面 runner 验证

2026-11-10 新增 0.17/schema20 [长期目标与连续执行](docs/coordination-ownership.md)：有界 DAG、优先级、同要求原生会话续接、有序补充、依赖失效与显式重做，保留原业务 owner。它扩展了此前仅只读概览的范围；实际验证见[本轮记录](docs/coordination-validation.md)。仍为独立 lab，未部署 Join。

本工作副本新增了[记忆评测入口](evaluation/README.md)：LongMemEval 历史回放/问答、独立进程隔离与原有记忆机制回归。原交接包保持冻结；新增代码的来源见 EVALUATION-ORIGIN.json。

后续能力覆盖与接入计划见[评测矩阵](evaluation/MATRIX.md)，同时提供[机器可读目录](evaluation/matrix.json)。已跑成绩、已有机制验证与待接入项目分别记录。

现已支持[多 Harness 选择](docs/multi-harness.md)：主助理接待、记忆提炼/复核和摘要可选 Pi 或原生 Codex；持久委托也可选择 Pi durable 或[Codex 原生持久线程](docs/codex-durable-execution.md)，复用同一批受约束工具。配置、权限边界与评测切换见该文档。

用户当前选择：这份助理[本机运行配置](docs/local-codex-profile.md)已设置为主助理和新后台委托均由 Codex 驱动，模型使用 DeepSeek Flash。

运行与评测现在默认输出[本地 OTel 日志和 trace](docs/local-telemetry.md)，位于 profile 的 `telemetry/`，采用官方 OTLP JSON，不记录提示/答案或凭据，不向网络发送。

这是本地独立验证目录。使用真实 `pi-durable` Harness、SQLite 会话和工具任务；默认模型是明确标注的确定性 fixture，用于验证接收、执行、重启、取消和交付边界。没有接入 Join，也没有真实 IM 发送或付费模型验收。

本轮重点是可逐步扩充的目录、类和状态所有权，见 [架构与所有权](docs/architecture.md)。目标是可日常使用的本地个人工作助理，具体场景和退出原型标准见 [产品目标](docs/product.md)。当前0.17.0/schema20，development，尚未通过真实模型的产品验收。

## 主会话与资料工作演示

```bash
npm run demo:assistant
```

这条演示通过实际 CLI 完成普通聊天、资料整理委托、后台进度查询、真实本地文件读取、结果回到原聊天、关闭/重启和重复输入去重。证据保存在 `evidence/assistant-demo.json`。模型仍是 fixture；读取与产物均为真实本地 I/O。

自己运行时，init 可加 `--workspace ./examples/materials` 明确绑定只读资料目录，随后使用：

```bash
node bin/assistant.mjs say --profile ./profiles/local --text '整理项目资料，列出进展和待跟进事项' --id project-request
node bin/assistant.mjs turn --profile ./profiles/local --input project-request
node bin/assistant.mjs conversation --profile ./profiles/local
```

say 先返回持久接收回执，turn 查询接待结果，conversation 查询稳定主聊天。普通聊天不创建工作；接单与结果是不同消息。现有 profile 不会因添加 workspace 就给旧工作扩大读取权限。

## 运行

要求 Node >=24；实际验证使用 Node 26.7.0。依赖由 package-lock.json 固定。

```bash
cd <workspace>
npm ci --ignore-scripts --no-audit --no-fund
node bin/assistant.mjs init --profile ./profiles/local --owner local:me
node bin/assistant.mjs run --profile ./profiles/local
```

另一个终端发命令：

```bash
cd <workspace>
node bin/assistant.mjs memory-set --profile ./profiles/local --key city --value 上海 --id remember-city
node bin/assistant.mjs submit --profile ./profiles/local --text '整理本周项目进展' --id weekly-progress
node bin/assistant.mjs status --profile ./profiles/local
```

submit 返回 workId。后续使用实际值：

```bash
node bin/assistant.mjs work --profile ./profiles/local --work WORK_ID
node bin/assistant.mjs amend --profile ./profiles/local --work WORK_ID --text '只整理本周，列出待跟进项' --revision 1 --id change-scope
node bin/assistant.mjs cancel --profile ./profiles/local --work WORK_ID --id stop-work
node bin/assistant.mjs events --profile ./profiles/local
```

`--id` 是逻辑输入去重键。重复相同命令返回原接收事实；相同 ID 携带不同载荷会被拒绝。省略时自动生成并在输出中返回。查询当前进度使用 work/status，重复接收回执不会改写成新的进度快照。

run 在前台提供后台执行，不加载网页或 Workbench。SIGTERM/SIGINT 关闭会挂起 Pi 工作；重新 run 同一 profile 后接续。cancel 是另一条明确业务命令，会停止未来执行并撤回未交付结果。已完成工作的 cancel 如实返回 alreadyCompleted。

## 一键演示与检查

```bash
npm run check
npm test
npm run demo
```

demo 启动自己的进程，保存记忆、提交工作、修改同一工作、等待结果、关闭并重启、验证同一输入去重，再运行一条有限安排；结束后关闭进程。它保存 profile、产物与 `evidence/demo.json`，可独立检查。重复 demo 创建新的 profile。

测试包括真实子进程 SIGKILL，以及 Pi 已接收但 binding 未提交、结果已保存但尚未投递、本地信箱写入后尚未保存回执三个崩溃窗口。SIGKILL 后需等待约 10 秒状态目录锁过期；正常关闭不等待。

check 只检查 JavaScript 语法，不冒充 TypeScript 类型检查。首轮测试中的辅助查询错误保留在 test-run.log；第一轮结果保留在 test-run-final.log，第二轮最终 39 项结果保留在 [phase2-tests-final.log](evidence/phase2-tests-final.log)，第三轮结果见 VALIDATION.md。

## 当前能力

| 能力         | 实际行为                                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 明确身份     | init 显式给本地 owner label，assistantId 稳定；重开校验 DB 与 profile 身份一致。不是远端身份认证。                                             |
| 稳定工作     | 同一 workId 跨修改和重启；修改产生新 revision / Execution，保留原 Pi 会话及已有工具结果。                                                      |
| 可靠输入     | 先在领域 SQLite 保存输入和工作，再调用 Pi；executionId 作为 Pi requestId。持久会话保存后记录 delivered。                                       |
| 后台并发     | 默认最多 2 个工作，控制接口持续可查询、取消、更正；每项工作串行。                                                                              |
| 工具与产物   | work_context、publish_note、ask_user；显式绑定资料目录时另有 list_materials/read_material。没有任意文件根目录、Shell、桌面控制或外部发送工具。 |
| 主会话接待   | 普通回复、澄清、接单、修改、取消、答复问题与显式记忆的结构化决策；应用服务校验归属和 revision 后提交。真实模型语言效果未验收。                 |
| 真实 Pi 恢复 | 原生会话、提交、工具任务及 checkpoint 由 Pi 保存；重启查询相同 requestId，不另造工具执行账本。                                                 |
| 结果与交付   | Result 与本地 mailbox Delivery 在同一领域事务保存；信箱落盘后才 completed；发送失败只重试投递。                                                |
| 显式记忆     | 按 key 保存、更正、遗忘，有 revision、输入来源和全局 memory epoch；支持对话中明确要求记住、更正、遗忘；不自动从资料提炼。                      |
| 有限安排     | 固定毫秒间隔、绝对 startAt、可选 expiresAt/maxRuns；触发身份持久化、不重叠、漏跑合并一次。                                                     |
| 单机归属     | profile 独占锁和权限受限 Unix socket；同一 profile 同时只允许一个有效 runner。                                                                 |

默认 fixture 不理解任意自然语言：接待仅识别几个明确的演示分支；它读取当前委托和记忆快照，通过真实 Pi 工具流程生成一份本地 Markdown，再返回明确标注的测试结果。它验证机制，不验证真实助理推理质量。

修改沿用同一工作会话，旧 revision 通过显式 Pi abort 停止，随后提交新 revision。已经发生的真实本地产物保留；它不能保证任意模型不重复思考或不重复调用外部工具。本轮提供的工具只写自己的稳定产物路径，可查验并安全重放。

## 显式记忆与安排

```bash
node bin/assistant.mjs memory-list --profile ./profiles/local
node bin/assistant.mjs memory-forget --profile ./profiles/local --key city --id forget-city
node bin/assistant.mjs routine-add --profile ./profiles/local --text '检查项目进展' --interval-ms 60000 --start-at EPOCH_MS --max-runs 1 --id check-once
node bin/assistant.mjs routine-pause --profile ./profiles/local --routine ROUTINE_ID --id pause-check
```

startAt / expiresAt 使用 epoch 毫秒。本版没有 cron、自然语言时间解析或时区 UI。漏跑只合并为一次当前检查，保留原 scheduledAt 与实际 observedAt；适用于本原型的信息检查，不能直接套给扣款等业务。pause/expire 撤回未完成的关联工作和未发投递；maxRuns 用尽只停止后续触发，允许最后一次工作完成。

记忆变化会阻止旧 snapshot 的后续 publish_note，事项进入 blocked；用 amend 明确修订工作后加载新快照。当前是全局 epoch，任何一条记忆变化都可能阻止旧工作，尚未实现按事实依赖的细粒度失效。forget 退出当前召回并保留删除版本；已有历史、执行快照和产物不会随之抹除，不承诺全历史或语义遗忘。

## 接入真实模型

明确停止此 profile 的 runner，在 profile.json 中设定：

```json
{
  "mode": "model",
  "model": {
    "provider": "deepseek",
    "modelId": "所选 Pi 版本目录中的实际模型 ID"
  }
}
```

保留原 schema、assistantId、owner、concurrency 等字段。支持 deepseek / anthropic 两个 Pi provider；模型 ID 启动时校验。凭据由当前进程的 `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` 等 provider 支持的环境提供，不读取共享机器账户文件，不将密钥写到 profile。使用独立 profile 试真实模型，避免在 fixture 的在途工作中切换模式。

真实执行模型只得到本版受限本地工具，接待模型只返回建议和只读查询请求；它能生成本地结果，不能因此访问 OpenCraft 连接或任意本机能力。本轮没有使用任何模型凭据，也没有验证模型效果、费用或真实服务兼容性。接待模型的 model-mode 分支已通过 Pi faux provider 验证实际调用契约与 JSON 拒绝路径，这不等于真实服务验收。

## 数据与边界

```text
profile.json             稳定身份与本地配置
assistant.sqlite         输入、主会话、接待决策、事项、执行绑定、待答问题和答案、记忆、安排、结果、投递、事件
executions/<work>.sqlite  Pi 原生持久会话与工具任务（唯一执行 owner）
artifacts/<execution>.md  稳定身份的本地产物
mailbox/<delivery>.json   本地交付回执，可读结果
runner.sock              仅本机同一 OS 用户使用的控制入口
```

领域层不保存 Pi 工具 checkpoint；仅保存执行引用和业务结算。两份 SQLite 之间不假装原子，使用固定 requestId 和恢复核对衔接。产物和 mailbox 使用同步写入、fsync、原子 rename，并在重试时核对已有字节；这只覆盖本地持久目录，不外推为任何外部服务 exactly-once。

协议是一行一个 JSON 请求，响应也为单行 JSON：

```json
{ "op": "submit", "id": "input-1", "params": { "text": "整理项目进展" } }
```

采用本地 Unix socket，不对外监听 HTTP 或 WebSocket。这里的传输只服务验证，不决定未来 OpenCraft 客户端协议。关闭客户端不会取消持久工作。

本版尚未验证真实模型的连续自然语言接待质量；跨平台SourceThread/远程事件订阅、OpenCraft Tasks/Actor/连接适配、真实渠道、远端认证/OAuth、Temporal backend和平台内置装配尚未接入。本地事件、分型等待与带证据自动记忆已实现，具体以能力台账为准。目录和类已按 domain/application/ports/adapters/runtime 分层；当前独立 repository 是实验适配，未来接入前核对已有 owner，不直接作为第二套平台权威上线。

实现与设计依据见 [设计草案](<operator-local-reference>) 与 [双项目深审](<operator-local-reference>)。没有复制 Grok 恢复源码或 DSH 原型实现。

## 第三轮：问答、记忆与产品验收入口

```bash
npm run demo:personal
node bin/assistant.mjs doctor --profile ./profiles/local
node bin/assistant.mjs say --profile ./profiles/local --text '记住我在上海'
node bin/assistant.mjs say --profile ./profiles/local --text '整理项目资料，先问我范围'
node bin/assistant.mjs say --profile ./profiles/local --text '回答：只整理本周'
```

fixture 仅识别这些明确演示分支。`demo:personal` 跑完整个人工作流程：记忆、提问、释放槽、重启、回答原工作、来源产物、更正/遗忘、取消、修改和一次安排。每次生成新 profile 和 evidence.json，进程结束后关闭 runner。

问题也可经明确 CLI 操作：

```bash
node bin/assistant.mjs interaction-list --profile ./profiles/local
node bin/assistant.mjs answer --profile ./profiles/local --interaction QUESTION_ID --revision 1 --text '只整理本周' --id answer-1
node bin/assistant.mjs reject --profile ./profiles/local --interaction QUESTION_ID --revision 1 --id reject-1
```

回答保存后继续原 work/revision/Submission；等待期间释放 Harness 和工作槽。修改或取消会退役旧问题，重复输入保持原回执，第二份不同输入不能覆盖已答问题。拒绝使原工作 blocked，可通过修改目标继续。直接 submit 创建的工作没有主聊天关联，使用 interaction-list 查询；say 创建的工作会把问题送回主聊天。

真实验收入口只接受真实模式，使用**全新目录**和合成资料，运行会请求所选服务并产生费用。只使用本人提供给当前进程的凭据，示例不携带密钥：

```bash
npm run accept:real -- --directory /data/tmp/my-personal-acceptance --owner local:me --provider deepseek --model MODEL_ID
```

模型 ID 必须来自固定 Pi 目录；doctor 可离线检查已配置的 profile。验收流程最长每阶段120秒，可用 --timeout-ms 指定1000..300000。该超时不替代完整 token/费用预算，后者尚未实现。

入口拒绝 fixture；所有结果保存在指定目录的 evidence.json，包括失败。自动断言检查结构性事实，仍需看来源忠实度、问题是否必要、内容是否能用于工作及持续使用表现。当前没有执行过真实模型验收，doctor 的配置通过和凭据存在也不证明服务可用或模型质量。

## 第四轮：完成条件和可核验依据

```bash
node bin/assistant.mjs submit --profile ./profiles/local --text '整理项目资料并引用来源' --completion '{"requirements":["准确概括进展与风险"],"checks":[{"kind":"material_read","path":"project.md"},{"kind":"note_contains","text":"本周"}]}' --id checked-work
node bin/assistant.mjs work --profile ./profiles/local --work WORK_ID
```

先明确配置资料目录，将例中的project.md和原文字面条件换成实际资料。新工作默认必须发布笔记。支持检查指定文件已读取（可选sha256）及产物包含指定原文；笔记检查基于真实发布字节。不能从模型回复里的“完成了”或用户协议提交成功证明。

工作详情的completion列出当前contract、每个execution的依据和评估。失败保留评估并进入blocked，不生成成功交付；通过后仍需本地mailbox接受才能completed。semanticReview=unverified明确表示没有验证概括质量。amend省略--completion时保留条件；显式传入时替换附加条件，默认笔记要求继续保留。

旧工作升级不改变原条件或快照；明确修订后应用当前标准。继续开发顺序和未实现项见 [roadmap.md](docs/roadmap.md)。本轮实现说明见 [0004-completion-contract.md](docs/iterations/0004-completion-contract.md)。

## 第五轮：有界接待查询

```bash
node bin/assistant.mjs say --profile ./profiles/local --text '资料有哪些' --id list-materials
node bin/assistant.mjs say --profile ./profiles/local --text '查看资料 project.md' --id read-material
node bin/assistant.mjs say --profile ./profiles/local --text '查进度' --id check-progress
node bin/assistant.mjs say --profile ./profiles/local --text '查看工作 WORK_ID' --id work-detail
node bin/assistant.mjs say --profile ./profiles/local --text '待回答的问题' --id questions
```

fixture仅演示这些固定分支。已明确绑定的资料可以在主接待中轻量读取并回复，无需为每次查看创建工作或产物。复杂整理仍交给原WorkService和Pi执行。查询工作/问题只覆盖本主会话已关联的事项，直接submit的独立工作仍用work命令查询。

接待初始视图有数量和文本界限，需要更多信息时通过查询读取；查询最多6次、模型最多7轮，按页/分块并限制返回量。资料offset/limit以JavaScript文本单位计，返回nextOffset与完整源SHA256；目录adapter可能只列前100项，结果明确标记可能未穷尽。

turn返回的decision_json包含host记录的queries：读取时间、结果等级、返回量及必要来源/哈希。trace不是资料正文或模型完成证明。旧消息不会因修改workspace获得新目录，后台委托也不能间接获得；查询后提交更改仍检查当前revision。

实际职责、port和状态归属见 [0005-reception-queries.md](docs/iterations/0005-reception-queries.md)。当前没有运行真实模型服务验收，局部查询界限与0.9.0运行保护分开，均不构成金额预算。

第六轮回应策略：接待超过5秒发送一次接话，运行工作超过30秒发送一次进度，执行失败通知原关联会话；重启后按持久消息身份去重，最终交付独立。例行结果仍进本地mailbox。详见 [实现与边界](docs/iterations/0006-responses.md)。

自0.7.0起已接入六项助理能力：内容插件技能按需读取、带证据和独立复核的自动记忆、文件/本地事件触发、条件与合并通知、无人关注的例行暂停，以及分型用户等待。用法与限制见[能力验收台账](docs/superapp-capabilities.md)。仍为独立development runner，不代表已接入Join或外部IM/认证服务，真实模型质量尚未验收。

模块入口与协作边界见[分治地图](docs/module-map.md)；各实际模块目录已配置AGENTS.md。下一批开发优先级见[路线](docs/roadmap.md)。

## 主助理连续处理（0.8.0）

后台执行先保存不可变报告，再进入原主会话的系统回合。主助理可继续同一工作、整理最终回应、报告阻塞或对quiet任务保持静默；结果、交付接受与工作完成仍分别记账。用户输入支持最多4项原子命令，安排支持interval创建/暂停/恢复，委托保留原话、最新修正和有界背景。默认仍生成笔记；明确completion.output=text的工作可以只给文本。

fixture额外支持“每隔30秒提醒我检查项目”演示分支，不代表能理解任意日历/时区安排。实现与边界见[续接说明](docs/assistant-continuation.md)，验证见[本轮记录](docs/iterations/0013-continuation.md)。实际Pi、本地I/O和崩溃恢复已纳入测试，真实模型质量与外部IM未验收。

## 当前投入范围

按2026-11-03用户要求，运行保护以[对标Grokbot的范围](docs/runtime-guardrails.md)为准：局部执行/重试限制、并发与取消、上下文界限、用量可见性和关注保护。统一金额预占/扣账不作为当前完成标准；0.9.0已补实际worker上限与usage统计，真实模型质量继续单独验收。

## 运行保护与用量（0.9.0）

默认每项Execution最多128个模型步骤、每次活跃运行10分钟、单次模型请求2分钟，provider/durable各层最多重试2次。等待用户时暂停计时；恢复后步骤继续累计，活跃运行计时重新开始。超限保留已有产物与失败原因，用户明确修改工作可开新revision。

```bash
node bin/assistant.mjs init --profile ./profiles/limited --owner local:me --max-steps 64 --work-timeout-ms 300000 --model-timeout-ms 60000
node bin/assistant.mjs usage --profile ./profiles/local
node bin/assistant.mjs usage --profile ./profiles/local --work WORK_ID --limit 20
```

usage读取Pi原生累计值与接待/记忆模型回执，分开fixture/model，显示token/cache、目录价格估算、未知项与执行保护状态。重复采样不叠加，查询不调用模型。它不是账单或余额；provider未上报、内部重试与崩溃前未保存的直接调用可能不完整。实现与验证边界见[运行保护说明](docs/runtime-guardrails.md)。

## 分模块运行验收（0.10.0）

Pi执行桥和工具已改为窄接口；绑定当前work/snapshot的工具port只提供实际需要的方法。业务状态继续归原服务，checkpoint继续归Pi。具体边界见[分治地图](docs/module-map.md)。

```bash
npm run demo:personal -- --scenario work
npm run demo:personal -- --scenario memory,skills
npm run accept:real -- --directory NEW_DIR --owner local:me --provider deepseek --model deepseek-flash --scenario work
```

不指定--scenario时依次运行memory、work、automations、skills；每项也可用全新目录独立运行。报告逐项记录断言、passed/failed/not_run/not_selected及待复查质量。失败后保留现场并关闭runner，尚未运行的后续场景不算通过。自动化场景使用显式本地协议创建事件；技能场景为明确请求加载。真实模型需显式配置自己的进程凭据，本轮没有调用服务或验证质量。

无人关注长周期、敏感介入、语义通知、日历理解和远程连接仍列为未运行或未验证；不能将四项场景通过当成完整产品验收。

## 持续安排与长期上下文（0.11.0）

新增显式时区的工作日/小时/分钟日历、一次性截止任务、保留原ID和历史的安排更新，以及有期限/次数的stopWhen盯办。主助理可依据合格报告停止对应条件安排，当前交付继续结算；条件判断记录为model-reported。

记忆区分个人/当前授权项目、长期profile/近期log；默认有界召回并支持文字搜索。主助理和新worker可查更早的原会话消息，不需要把完整历史放进每次上下文。旧快照和显式更正/遗忘保护保留。

配置、CLI示例、所有权、Grokbot参考与实际限制见[持续助理说明](docs/long-running-assistant.md)。当前没有完整cron、语义检索或真实模型质量结论，也未部署Join。

## Grokbot记忆整理（0.12.0）

记忆已补内容去重/跨key同文遗忘保护、create/update/remove与独立复核、15秒/12轮证据合并、每日日期复查，以及实际profile/recent注入。配置、所有权、来源可信范围与未复刻部分见[对照](docs/grok-memory-parity.md)。仍是SQLite单助理/当前授权项目；未实现Grokbot的agent shard/多项目汇聚和Markdown文件权威，真实模型质量未验收。

## 文件权威与共享记忆（0.13.0）

事实现在以profile.md/月度log为准，SQLite负责可重建记忆索引和原业务作业；手改文件会更新下一次读取。每个助理各写自己的agent/user/project shard，跨助理共享条目带来源；项目有显式create/join/leave、原grant校验、最多3项目注入，加入不授予资料/Shell权限。

新profile默认agent私有，旧profile继续user。可用init --memory-root ABSOLUTE_DIR显式启用同owner共享；project-create/join/leave/list、memory-file和memory-locations通过本地socket操作。完整命令、目录、恢复/升级与已知限制见[实现说明](docs/memory-files-and-shards.md)。模型/外部服务质量仍unverified。

## 0.14主会话长期工作上下文

接待前自动整理旧历史，持续带入目标、约束、决定和未完事项；摘要带真实消息引用，新委托固定当前背景。原文保留，长消息分段处理，未覆盖部分明示gap。生成失败不阻塞接待，三次耗尽后可显式重试。

```bash
node bin/assistant.mjs context --profile ./profiles/local
node bin/assistant.mjs context-retry --profile ./profiles/local
```

当前0.14.0/schema16；设计、默认界限、Grokbot参考与真实质量边界见[工作上下文](docs/conversation-working-context.md)。fixture是原文抽取探针，真实模型摘要质量仍未验收。独立lab未接入或部署Join。

## 0.15用户消息出口

主助理回复、进度、问题、结果与通知共用持久消息出口，支持文字/附件引用/原消息引用。选择卡继续复用工作Interaction；发送失败只重投同一消息，五次后保留failed并让后续消息继续。当前只配置本地local:main，accepted表示outgoing文件落盘，用户已读状态未知。

```bash
node bin/assistant.mjs attachment-import --profile ./profiles/local --file ./report.pdf
node bin/assistant.mjs message-send --profile ./profiles/local --message '{"type":"text","content":"你好"}'
node bin/assistant.mjs messages --profile ./profiles/local
node bin/assistant.mjs message-respond --profile ./profiles/local --message-id MESSAGE_ID --revision 1 --value week
node bin/assistant.mjs message-retry --profile ./profiles/local --message-id MESSAGE_ID
```

附件发送使用导入返回的attachmentId；真实publish_note也注册附件。消息/回执、原工作完成和外部渠道分别验证。当前0.17.0/schema20，详见[设计](docs/user-messages.md)。本轮没有新增UI或远程账号连接。
