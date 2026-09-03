# Coding Plan 七彩石模型目录设计

## 背景

LightVela 已从七彩石取得模型 Provider 配置，但当前只有腾讯云 Hy Token Plan 在模型配置页直接展示目录模型；其他 Coding Plan 仍要求用户输入 API Key 后点击“获取可用模型”。这与 `tea-sdk-lightclaw` 的交互不一致：SDK 直接展示 Provider 的 `models`，并默认选择数组首项。

## 已确认需求

- 所有 `category: "coding_plan"` 的套餐统一直接展示七彩石返回的模型列表。
- 默认选择七彩石 `models` 数组的第一个有效模型，同时允许用户切换其他模型。
- Coding Plan 不展示“获取可用模型”，也不调用模型列表发现接口。
- 保留独立“检测模型状态”按钮，使用选中模型执行真实 `model_request` 检测。
- 点击“添加模型”时直接保存，不自动触发模型状态检测。
- 七彩石成功但未返回某个 Provider 时不展示；Provider 没有有效模型时也不展示。
- 七彩石请求或整组解析失败时，继续由现有 `useModelProviders` 使用本地完整列表兜底。
- `category: "api"` 与自定义模型的发现和添加流程不变。

## 方案

适配层根据 Provider 的 `category` 声明产品行为，而不是维护 Coding Plan 白名单：

1. 所有 Coding Plan 输出 `discoveryStrategy: "catalog"` 和 `fixedModelSelection: true`。
2. Coding Plan 标准化后没有有效模型时直接过滤。
3. 面板把 `fixedModelSelection` 解释为“直接使用目录选择”，不再强制锁定第一项；第一项只作为初始值，用户选择写入本地状态。
4. 独立检测按钮只响应用户主动点击；添加操作与模型检测完全解耦。
5. 七彩石解析层校验 Provider 的分类、Base URL 和 API 模式；整组没有结构有效项时返回 `null`，触发现有本地列表兜底。模型项做运行时清洗，避免远端畸形值导致页面崩溃。

## 数据流

```text
七彩石 Provider.models ─> Provider adapter ─> 目录下拉框（默认首项，可切换）
                                │
                                ├─ 独立检测 ─> model_request
                                └─ 添加模型 ─> 直接保存（discoverModels=false）

七彩石整体失败 ─> 本地 MODEL_PROVIDER_LIST ────────────────────────────────┘
```

## 边界

- Provider 在七彩石结果中缺失时，适配层不会补回。
- 模型 ID 为空的条目继续过滤；过滤后目录为空则隐藏整个 Coding Plan。
- 结构有效但 `models: []` 的 Provider 仍被视为七彩石有效配置并在适配层隐藏，不会被本地同名 Provider 补回。
- 整组 Provider 均缺少连接必要字段时视为解析失败，由 `useModelProviders` 保持本地完整目录。
- 七彩石返回顺序是默认顺序，不额外读取 `isDefault`，与 SDK 保持一致。
- 用户切换 Provider 后重置模型选择，并选择新 Provider 的第一个有效模型。
- 独立检测失败只展示检测结果，不修改选择，也不影响后续添加操作。
- 添加操作不读取或复用独立检测结果；保存失败时保留用户输入供重试。

## 验收标准

- 任意 Coding Plan 打开后直接看到模型首项，且没有“获取可用模型”。
- 多模型 Coding Plan 可以切换模型；检测与添加均使用当前选中项。
- 独立“检测模型状态”保留。
- 添加时直接执行 `add`，不出现 `connectivityProbe`，并传 `discoverModels: false`。
- 空目录 Coding Plan 隐藏；API Provider 仍使用原有发现流程。
