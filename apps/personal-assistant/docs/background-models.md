# 后台整理模型的独立配置

用户于 2026-11-09 要求：后台整理改用混元 4，关闭思考，检查此前准备慢是否与思考有关。主聊/委托与后台整理使用独立配置；Harness 仍为 Codex。

## 范围和所有权

`harnesses.backgroundCodex` 是可选的完整 Codex 配置，用于 `memory-propose`、`memory-verify`、`context-summary` 三个结构化角色。缺省继承主助理，旧 profile 不重写。主聊由 `harnesses.codex` 选择；持久执行继续按原 Execution 的 Harness 和绑定校验，不从后台配置取值。

配置只选临时模型传输，不创建业务状态、记忆 owner 或新的调度器。原提炼提示词、独立复核、引用/CAS/墓碑/权限校验、截止和恢复语义保留。后台端点失败按原策略记录与有限重试，不偷偷换回主聊模型。

`LocalRunner` 装配后台 Harness，分别注入记忆与摘要模型；停止协调器后关闭两套临时 Harness，再 flush 遥测、关闭数据库和释放锁。用量按实际 `kind/provider/model` 记录；doctor 单独显示后台角色与推理设置，离线检查不会调用模型。

## 配置

```json
{
  "harnesses": {
    "assistant": "codex",
    "execution": "codex",
    "codex": {
      "binary": "/absolute/codex",
      "baseUrl": "https://tokenhub.tencentmaas.com/v1",
      "modelId": "deepseek-v4.1-flash-1017",
      "credentialFile": "/private/model-key"
    },
    "backgroundCodex": {
      "binary": "/absolute/codex",
      "baseUrl": "https://tokenhub.tencentmaas.com/v1",
      "modelId": "hy4",
      "credentialFile": "/private/model-key",
      "reasoningEffort": "none"
    }
  }
}
```

`reasoningEffort` 是显式可选项，适配器校验后写入原生 `model_reasoning_effort`，由 Codex 实际发出 Responses `reasoning.effort`。`none` 表示关闭；省略时保留提供方默认策略，不能把“没有显示思考文本”解释成关闭。

本轮验证了真实原生二进制在 HTTP 请求中发送 `model=hy4` 和 `reasoning.effort=none`；TokenHub 的小型真实请求返回 HTTP 200，回显 `reasoning.effort=none` 且仅有 message 输出。响应没有提供内部 reasoning token 明细，因此不声称已测得内部计算严格为零。

参考：[混元调用指南](https://cloud.tencent.com/document/product/1823/132252)、[推理控制](https://cloud.tencent.com/document/product/1823/131208)、[Responses 字段](https://cloud.tencent.com/document/product/1823/135873)。2026-11-09 官方模型列表实查存在 `hy4`；这不是 `hy4-preview`。服务默认启用思考，后台需显式覆盖。

## 组件评测

记忆组件入口支持单独的私有配置：

```bash
node evaluation/memory-system.mjs \
  --dataset evaluation/datasets/personamem-v1-32k \
  --codex-config /private/reader-codex.json \
  --background-codex-config /private/hy4-nothink-codex.json \
  --output evaluation/runs/NEW-HY4-RUN \
  --contexts 1 --seed opencraft-memory-personamem-20261109-v1 \
  --timeout-ms 900000 --control-timeout-ms 300000 --plan
```

Plan 同时固定 reader、后台模型/思考设置和二进制哈希。三路 reader 相同，只替换记忆准备的模型配置；不得将改后台模型后的结果当成 reader 模型升级。省略后台配置的旧入口沿用原来单模型行为。

评测 worker 的 IPC 实测覆盖后台模型配置的传递与角色隔离；源码/依赖变化必须新建 run，不恢复覆盖原失败。旧的 [组件实测](../evaluation/MEMORY-SCHEME-RESULTS-20261109.md) 保留其原配置与失败。

## 验证

`test/codex-harness.test.mjs` 使用真实 Codex 和 loopback Responses：验证实际 wire 上的 none、未知设置拒绝、主聊/记忆/复核/摘要分流、持久来源写入、关闭释放和独立评测 worker 的模型隔离。旧配置、原生持久执行与 Pi 路径仍按完整回归验收。替身通过只证明配置和接线，真实质量及耗时单独记录。
