# LLMGateway OpenSpec

这个目录记录 LLMGateway 托管多 Set new-api 的控制面与流量面设计规格。

## 入口

- `config.yaml`: 给 AI Agent 和工程协作者看的项目上下文。
- `current_state.md`: 当前已经实现、已经确认和还缺的能力。
- `spec.md`: 当前稳定技术规格。
- `proposal.md`: 当前阶段为什么要维护这套 OpenSpec。
- `plan.md`: 后续推进清单。
- `specs/llmgateway-dropin.md`: 长期能力规格和场景。
- `changes/2026-07-05-llmgateway-newapi-dropin/`: 本轮 drop-in 方案的 proposal、design、tasks。

## 使用方式

1. 新需求先看 `current_state.md` 和 `spec.md`，避免重复设计。
2. 涉及契约变化时，先在 `changes/<date>-<name>/` 写 proposal/design/tasks。
3. 工程实现完成后，同步更新 `specs/` 下的长期规格。
4. 对外 API 仍以 `docs-site/openapi/llmgateway.json` 为机器可读契约。
