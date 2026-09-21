---
id: reasoning-capability-contract
type: task
scope: 修复没有 reasoning 能力却默认发送 none 的全链路语义问题
triggers:
  - opencraft
  - reasoning
  - none-effort
owner: mingyuxiao
authority: primary
source_of_truth:
  - opencraft/design/reasoning-capability.md
status: retired
reviewed_at: 2026-09-14
review_due: 2026-10-14
revision: 1.0.0
precedence: task
derived: false
---

# Reasoning 能力契约

## requirement_ids

- reasoning-capability-contract

## requirement_refs

- 用户确认四条 reasoning 不变量，并要求参考 WorkBuddy 后实施。

## requirement_excerpt

“按理说应该是可以自洽的，而不需要 workaround”、“行，搞吧。”

## goal / non_goals

统一能力投影、恢复选择与请求编译，清除不适用的旧选择但保留合法 none。不改模型名、不关闭引擎校验、不更改真实 Key、不发付费推理、不提交发布。

## history_context

真实模型目录 reasoning=null，适配器却填 defaultReasoningEffort=none，前端选中后编译器照发，引擎正确拒绝。WB 将 thinking 与 effort 分开，其固定档位表、自动降档与未声明范围时放宽不照搬。

## context_receipt

- opencraft/AGENTS.md
- opencraft/.agents/skills/opencraft-maintenance/SKILL.md
- opencraft/docs/local-agent-custom-providers.md
- opencraft/docs/build-matrix.md
- ref/wb/packages/agent-ui/src/components/main-content-core/hooks/use-model-selector.ts
- ref/wb/packages/agent-ui/src/components/main-content-core/main-content-core.tsx
- ref/wb/packages/cb-chat-ui/src/types/chat.ts

## acceptance / validation

单测覆盖能力/默认/合法 none/残留选择，真实 Workbench→编译→DSH→本地模型请求验证无不适用参数。完整 gate 与 Mac 目录显示验证。

## checkpoint

阶段：完成。共享能力归一化、nullable 非生成协议投影、界面派生选择和提交前能力读取/编译已接入。4 项契约测试通过，含能力读取超时不得误报发送不确定；更新会话测试服务的 model/list 声明后，完整 gate 通过。

真实 Workbench 命令端口→编译器→DSH→本地 OpenAI 兼容 HTTP 服务回归通过：无 reasoning 能力返回 null 默认，旧 none 不进入模型请求；同时尝试旧客户端非法选择后，下一次正确请求仍可发送。合法 none 保留、非法默认、无默认、跨模型残留由单测覆盖。没有对真实账号模型发推理请求。

最终 Mac 产物 `opencraft/apps/workbench-electron/release/reasoning-contract-final-preview/mac-arm64/OpenCraft Preview.app` 构建、签名校验与实机验证通过；仍读取用户原 models.json，deepseek-v4-pro-202606 出现在菜单中，Reasoning 分组与档位标签均为 0。截图 `/tmp/opencraft-reasoning-contract-native.png`。未修改用户模型或凭据、未提交推送。其他实际 reasoning 模型的供应商请求未逐一实测。
