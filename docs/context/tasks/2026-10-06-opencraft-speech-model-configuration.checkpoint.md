---
id: checkpoint-opencraft-speech-model-configuration-20261006
type: task
scope: 语音模型配置实现与源码交付证据。
triggers: ["opencraft speech model configuration checkpoint", "混元语音模型配置交付", "转写模型合入证据"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - docs/context/tasks/2026-10-06-opencraft-speech-model-configuration.md
status: retired
reviewed_at: 2026-10-06
review_due: 2026-11-06
revision: 1.0.0
precedence: task
derived: true
---

# Checkpoint

- 原始脏工作区的既有混元改动保留，其他用户任务文档不修改。源码交付使用独立工作区，基于 master f1aa35cc2，仅提取语音模型增量，保留已合入的桌面功能。
- 当前预览继续使用旧已验证版本；真实密钥不读取到工具输出，不迁移、不重启。
- 只读 LobeHub 参考版本 bb413404fc79b52c175d3b59271f0b8f8bad64a2；克隆与验收产物留在仓库外。
- 已阅读模型文档、仓库、DSH 兼容桥、提供商协调器、模型设置组件、语音服务与录音客户端。
- 新代码实现完成：共用仓库/CAS/凭据，现有模型设置创建混元语音连接，语音页独立选择；录音/重试固定配置票据。
- 21 项语音测试通过；真实 DSH+模型设置+语音选择浏览器四布局/主题操作，以及既有 Composer 录音浏览器回归通过。测试替代麦克风与付费厂商请求，未调用真实计费接口。
- 原始实现与独立合入工作区的完整 npm run gate 均已退出 0，包含工作区检查、测试及 Web/Expo Web/iOS 构建；失败日志保留，回归发现的错误文案兼容性和 ASR 来源分类已修正。独立版本保留 master 已有桌面控制和 motion，29 个语音增量文件未混入并行修改。
- 文档校验、实际工作区 changed-files 影响映射及 git diff --check 通过。测试期间工作区出现其他会话的聊天资源改动，均保留且未修改、暂存或提交；门禁结果针对当时工作区，不是独立已提交版本。
- 新增浏览器 smoke:speech-model-settings，截图保存在仓库外隔离证据目录。
- 替换前必须私有备份 models 目录：旧模型文档严格校验不识别新字段，回退须恢复匹配模型/凭据快照，不能仅回退二进制。实际迁移与切换仍未授权执行。
- 用户已授权提交、推送、合入；真实配置迁移、预览替换仍不在本轮范围内。
- 独立版本真实 DSH/模型命令/凭据/CAS 与共享模型、语音设置，以及实际浏览器录音/WAV/后端/Composer 的桌面/触屏、浅深主题验证通过；只有麦克风硬件和付费厂商被替代，未调用计费接口。敏感信息扫描无凭据发现。
- 根 Context 测试 27 项中 4 项未通过，属于历史 Task Pack 格式、英文文档和既有校验问题；逐项对照未修改 master 基线，排除本次增加错误。Context Audit 测试 33 项通过；发现脚本不等于已经完成全仓成熟度评审。
