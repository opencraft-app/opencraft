# 团队约定

> 团队级约定与外部系统桥接规则。方法论与流程节奏由你按需求风险自决，不在本文范围。

## commit 规范

- 项目规范优先：遵循仓库 commit-msg hook / CONTRIBUTING.md / commitlint 定义的格式，禁止用本 skill 的默认格式覆盖项目已有规范。
- 项目无明确规范时默认 Conventional Commits：`type(scope): [FE-AI] 简要描述`；type 限 feat / fix / docs / style / refactor / test / chore / perf / build / ci，描述语言跟随项目惯例。
- commit / push 只在用户明确要求后执行。

## 分支命名

- 新需求禁止直接在 `master` / `main` 上开发。
- 分支名必须匹配：`^(feat|fix|feature|hotfix|chore)/[a-z0-9-]+-(?:0[1-9]|1[0-2])[0-3][0-9]-[a-z0-9-]+$`。
- 中间四位是 MMDD 日期（如 `0714`），不是序号；禁止生成 `feat/task-0001-xxx` 这类序号分支。
- 切分支前先查 `git status --porcelain`；有未提交改动时禁止自动 stash / commit / 强切，先让用户决定。

## MR 与 CR

- MR / CR 只在用户明确要求后执行；动作细则见 `../../team-extensions/mr-auto-submit.md` 与 `../../team-extensions/cr-check.md`。
- 工蜂等外部系统动作要求配置齐全且用户意图明确；缺配置或权限时停下来说明，不得伪造完成状态。
- MR / CR 文案遵循仓库既有惯例，与 commit 规范同源。

## TAPD 与用量上报

- TAPD 需求获取见 `../../team-extensions/tapd-requirement-fetch.md`；TAPD 侧动作同样要求配置齐全、意图明确。
- 用量上下文：change 启动后在项目根运行 `feai workflow usage-context write --provider <p> --project-base <项目根绝对路径> --json`；归档时按 usage-context 窗口做需求级用量审计（读取本机工具日志）。
- provider 按当前宿主直接判定：CodeBuddy Code CLI → `codebuddycode`，VS Code CodeBuddy 插件 → `codebuddy-vscode`，CodeBuddy Web/IDE → `codebuddy`；其他已知宿主用对应 provider。
- 禁止根据 session 环境变量或 `project.local.json` 静默选择 provider；确实无法判断时才询问一次；用户明确暂不统计时才设 `USAGE_PROVIDER_SKIP=1`。
- 归档评分上报必须走标准链路：`feai report archive-pipeline --project <项目根> --change-name <name> --score <1-5> --submit [--feedback <text>]`。payload 由脚本生成（自带 `generator` 来源指纹、userId、版本与 git 上下文）；score < 3 时 `--feedback` 必填。
- **禁止 AI 手写上报 payload JSON 或手动 curl 上报**——手写 payload 会丢失 userId / version / git / 用量审计字段，污染团队统计数据。

## 终端输出与上下文预算

- 长输出优先 `tokenjuice wrap -- <command>`（deterministic reducer，不调 LLM）；test / build / lint / type-check 默认压缩。
- 精确读文件（cat / sed / jq 等）与高风险写操作保持 raw；高风险操作先确认再执行。
- 未装 tokenjuice 时，输出超 200 行或 12KB 必须摘要：命令、退出码、结论、关键错误（file:line）。
- 预算目标：单次命令输出进上下文 ≤ 2,000 tokens；单次测试 / 构建失败摘要 ≤ 3,000 tokens。
- 模型分流：低风险扫描 / 摘要优先低成本模型，常规规划与实现用默认主模型，架构 / 安全 / 发布风险或连续失败时升级高阶模型；具体 model id 以项目模型路由配置为准。

## 多 Agent 协作

- 同一工作区默认串行写入；只读调查可并行。
- 并行写文件必须使用独立 worktree，且动手前声明互不重叠的文件归属（Owner + 允许写入清单）。
- 只写归属范围内的文件；发现需要改范围外文件时先停下来报告，不自行扩大范围。
