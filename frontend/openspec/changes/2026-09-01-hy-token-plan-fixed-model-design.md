# Hy Token Plan 个人版固定模型设计

## 目标

当用户在“模型 Coding Plan”中选择“腾讯云 Hy Token Plan（个人版）”时，不再通过“获取可用模型”初始化模型列表，直接使用固定模型 `hy4-preview`。保留 API Key、模型状态检测、添加模型及主模型/备用模型/仅添加用途选择的现有能力。

## 范围

- 仅调整 `tencent_hy_token_plan`；其他 Coding Plan、模型 API 与自定义模型继续使用当前模型发现流程。
- 将 Hy Token Plan 个人版目录模型从 `hy3-preview` 更新为 `hy4-preview`，显示名称固定为 `hy4-preview`。
- 将套餐介绍中的 Hy3 更新为 Hy4 Preview，并同步生成 i18n 资源。
- 不修改 Hermes 配置文件格式、凭据加密、主备模型规则、保存命令或连接检测结果展示。

## 方案

在产品 Provider 适配层为 Hy Token Plan 个人版输出显式的固定目录模型能力。固定目录模型仍以 `model-providers.ts` 的 `models` 为唯一数据源，面板不重复写死模型 ID。

模型配置面板根据该能力采用以下行为：

1. 选择 Hy Token Plan 个人版后，直接把目录中的唯一模型作为当前模型选项和选中值。
2. API Key 控件不渲染“获取可用模型”按钮，输入框使用完整可用宽度。
3. “检测模型状态”继续保留；用户填写 API Key 后，使用固定的 `hy4-preview` 发起直接模型请求检测，不依赖 `/models` 列表接口。
4. “添加模型”继续调用原有添加与用途生效流程，但传入 `discoverModels: false`，避免保存阶段再次请求模型列表。
5. API Key、Provider 或分类变化时继续清除旧检测结果和旧凭据状态，固定模型本身由目录派生，不会被通用重置逻辑清空。

固定模型能力不复用现有 MiniMax 的普通目录发现语义。MiniMax 仍保留“获取可用模型”按钮和当前点击后载入目录模型的交互，避免扩大行为变化。

## 状态与数据流

`MODEL_PROVIDER_LIST` 提供 `hy4-preview` → `product-provider-adapter.ts` 将 Hy 个人版标记为固定目录模型 → `AgentModelConfigPanel` 立即展示并选中目录模型 → 用户填写 API Key → 可执行“检测模型状态”或“添加模型”。

连接检测继续走现有 `controller.testConnection`，策略使用直接模型请求；添加继续走现有 `controller.add`，模型身份、用途选择、凭据加密、保存后刷新和成功提示均保持不变。

## 错误处理

- API Key 为空时，“检测模型状态”和“添加模型”继续禁用。
- 连接检测失败时继续显示现有失败弹窗和具体错误信息。
- 添加失败时继续保留 API Key，显示现有就近错误，方便用户修正后重试。
- 若固定目录意外为空，模型和后续操作保持不可用，不回退到远端模型发现，也不伪造可用模型。

## 验证

- Provider 目录测试：Hy 个人版目录只有 `hy4-preview`，介绍文案为 Hy4 Preview。
- Provider 适配测试：Hy 个人版被标记为固定目录模型；普通目录 Provider 和实时发现 Provider 的策略不变。
- 面板 RED/GREEN 测试：选择 Hy 个人版后无“获取可用模型”按钮，模型立即显示 `hy4-preview`，且没有发起 `probe` 模型发现动作。
- 连接检测回归：填写 API Key 后“检测模型状态”可用，提交的检测模型为 `hy4-preview`，检测策略为直接模型请求，成功与失败展示保持原行为。
- 添加模型回归：提交模型为 `hy4-preview`、`discoverModels: false`，主模型/备用模型/仅添加用途继续生效，成功后刷新与清理凭据保持原行为。
- 非目标回归：其他 Coding Plan 仍显示并使用“获取可用模型”。
- 运行模型配置专项测试、`pnpm i18n:extract`、所有已开放 locale 检查、`pnpm check` 与 `git diff --check`；页面交互完成后补充国内站浏览器 smoke。
