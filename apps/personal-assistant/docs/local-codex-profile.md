# 本机双 Codex 配置

按用户要求已建立本机独立助理 profile：

`/home/opencraft-demo/.opencraft/hands/.local/share/opencraft-superapp/codex`

主助理接待、记忆提炼/复核、摘要和新后台委托均使用 Codex Harness，底层模型为明确授权的 `deepseek-v4.1-flash-1017`。`mode=model`，记忆学习开启，凭据只引用原私有文件，不复制密钥内容。Codex 是执行框架；这不意味着把模型换成 OpenAI 模型。

在独立实验目录中运行：

```bash
node bin/assistant.mjs run --profile /home/opencraft-demo/.opencraft/hands/.local/share/opencraft-superapp/codex
```

另一个终端可发起聊天：

```bash
node bin/assistant.mjs say --profile /home/opencraft-demo/.opencraft/hands/.local/share/opencraft-superapp/codex --text '你好'
```

此目录为独立数据目录，采用较短路径以满足 Unix socket 长度限制。不是 Join 主服务配置，也不修改历史评测 profile。旧 Pi 工作不会自动迁移。本轮设置的是这份助理的运行配置；未配置模型的通用实验和旧 fixture 测试仍保留原默认，避免无意发起付费请求。

可复现完整双 Codex 真实烟测：

```bash
node evaluation/codex-execution-probe.mjs --all-codex \
  --codex-config /absolute/private/codex.json --output NEW_DIRECTORY
```

模型必须真实创建委托、原工作等待时重开、消费回答、发布含答案的笔记，再由原主助理交付到原聊天。保留每次失败记录，不把配置检查当作完整模型验收。

当前配置检查和本轮 40 项相关回归通过，未运行常驻服务。完整真实烟测尚未通过：主助理曾返回 clarify、用 reply 声称已创建委托，或选择了不适用的操作。记录保存在 `evidence/codex-all-20261107*`。已补主助理规划提示、按用户/报告回合限制线协议分支，并关闭原生 plugins 后台同步；这些修正通过机制回归，不代表 DeepSeek 规划质量已验收。此前后台 Codex 等待/重开/回答/笔记的成功烟测保持原归属。

2026-11-09 用户进一步要求后台整理切换 `hy4` 并显式 `reasoningEffort=none`；配置与真实验证边界见 [后台模型](background-models.md)。主聊和持久委托继续原模型配置。旧轮次记录中的“所有角色同 DeepSeek”是当时状态，不代表该覆盖生效后的配置。
