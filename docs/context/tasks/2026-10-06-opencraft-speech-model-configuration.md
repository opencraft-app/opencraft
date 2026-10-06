---
id: task-opencraft-speech-model-configuration-20261006
type: task
scope: OpenCraft 云听写复用模型服务与独立语音选择的实现、验证和合入。
triggers: ["opencraft speech model configuration", "混元语音模型设置", "独立转写模型选择"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/apps/local-agent-host/src/model-config/speech.ts
  - opencraft/design/model-configuration.md
status: retired
reviewed_at: 2026-10-06
review_due: 2026-11-06
revision: 1.0.0
precedence: task
derived: false
---

# 语音输入复用模型配置

## 请求与边界

用户批准复用模型设置中的提供商、密钥能力，参考 lorehub（按 LobeHub 理解）。只实现和验证；本轮不提交、不重启、不替换当前预览，也不调用计费转写接口。

后续用户明确授权提交、推送、合入 master。交付使用独立工作区，在最新 master 上只接收语音模型配置增量，保留既有桌面功能，不混入并行中的文件卡片改动；仍不迁移真实配置、不替换预览。

参考：只读 LobeHub bb413404fc79b52c175d3b59271f0b8f8bad64a2，模型类型 chat/asr 与专用 transcribe(provider, model) 调用。采用其用途分离，不搬入其数据库或认证实现。

## 所有权与不变量

- ModelConfigurationRepository/ModelCredentialRepository 是唯一配置与密钥真源，沿用锁、CAS、私有权限和写入式密钥管理。
- 语音模型独立选择；转写模型不得进入聊天目录、聊天默认、DSH 执行配置或聊天凭据投影。
- 语音服务绑定安装级模型目录，不依赖当前 Thread、Bot 或 SSH Server。
- 录音开始捕获配置绑定；配置变化时旧录音拒绝转写，不静默转投新配置。重试不改变绑定。
- 禁用、删除所选模型保留失效选择，明确显示不可用，不隐式切换其他模型。
- 旧环境配置只允许显式一次性导入，运行时不保留环境变量回退。公网准入仍是部署策略。

## 修改与验证

产品模型文档及兼容桥、现有模型设置、后端语音服务和选择接口、浏览器语音设置与录音绑定；补仓库/投影/凭据/迁移/配置竞态测试、类型与边界检查、真实浏览器验证。自动化只写隔离目录和合成密钥。

正式文档：opencraft/design/model-configuration.md、opencraft/design/invariants.md、opencraft/docs/platform-architecture.md、opencraft/docs/cloud-dictation.md。

## context_receipt

- 根 AGENTS.md、opencraft/AGENTS.md；路由命中 docs/context/domains/agent-gateway-runtime.md。
- opencraft/.agents/skills/opencraft-maintenance/SKILL.md、references/verification.md。
- docs/context/project/adjacency/frontend-runtime-openspec-i18n.md；邻居检查 model-configuration-store、runtime-provider-service、model-services 测试。
- opencraft/design/model-configuration.md、docs/local-agent-custom-providers.md、docs/platform-architecture.md（语音/模型边界）。
- 映射正式文档 docs/engineering/domains/agent-gateway-runtime.md、docs/engineering/journeys/agent-request-streaming.md（相关责任边界）。
- 现有混元任务包用于当前部署事实，LobeHub 固定提交源码用于参考，均不取代当前实现/测试。
