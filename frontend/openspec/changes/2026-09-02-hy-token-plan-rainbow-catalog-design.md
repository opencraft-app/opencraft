# Hy Token Plan 七彩石模型目录设计

## 背景

LightVela 已通过本地 `useModelProviders` 从七彩石获取 Provider 列表，并在请求或解析整体失败时使用 `MODEL_PROVIDER_LIST` 兜底。现有 `product-provider-adapter.ts` 又对 `tencent_hy_token_plan` 做了第二次本地覆盖，导致七彩石成功返回的新模型和说明仍会被强制替换成单一 `hy4-preview`。

本设计取消这层成功态覆盖，使 Hy Token Plan（个人版）的目录权威与 SDK 保持一致，同时保留 LightVela 已有的固定目录交互。

本设计在“七彩石成功时的数据来源”上取代 `2026-09-02-hy-token-plan-rainbow-override-implementation-plan.md`；此前已经实现的固定选择、连接检测和添加协议继续保留。

## 已确认需求

- 七彩石成功时，`tencent_hy_token_plan` 的存在性、说明和模型列表完全由远端返回决定。
- 七彩石成功但未返回该 Provider 时，LightVela 不补回、不展示。
- 七彩石返回该 Provider 但 `models: []` 时，LightVela 隐藏该 Provider，避免空模型选择器。
- 七彩石请求或整组解析失败时，继续使用 LightVela 本地 `MODEL_PROVIDER_LIST`；本地兜底仍包含 `hy4-preview`。
- 保留 Hy Token Plan 的固定目录交互：不展示“获取可用模型”，不调用 `/models` 发现接口；连接检测继续使用 `model_request`，添加继续传 `discoverModels: false`。
- 七彩石更新后无需重新发布 LightVela；用户刷新或重新打开页面后重新拉取。本次不增加实时推送、TTL 或后台轮询。
- 已保存的用户模型配置不自动迁移；本次只更新可选择目录。

## 方案

保留现有三层职责：

1. `useModelProviders` 负责七彩石请求、解析、会话内缓存和整体失败兜底，不修改其调用协议。
2. `model-providers.ts` 继续保存完整本地兜底列表；Hy4 文案和模型只在整体失败时生效，不再导出可覆盖远端的固定目录常量。
3. `product-provider-adapter.ts` 只保存产品行为规则。对 `tencent_hy_token_plan` 标记 `fixedModelSelection: true` 和 `discoveryStrategy: "catalog"`，但 `description` 与 `catalogModels` 均取当前输入 Provider。若标准化后的模型目录为空，则过滤该 Provider。

数据流如下：

```text
七彩石成功列表 ───────────────┐
                              ├─> Provider adapter ─> 模型配置面板
七彩石整体失败 ─> 本地兜底列表 ┘      │
                                     ├─ Hy 固定选择交互
                                     └─ Hy 空模型时隐藏
```

## 方案取舍

### 采用：远端目录 + 本地行为约束

远端负责目录内容，LightVela 负责固定选择和空目录安全过滤。该方案与 SDK 的远端权威语义一致，也保留当前产品交互。

### 不采用：继续本地覆盖 Hy4

这会让七彩石模型更新无法生效，并在远端删除 Provider 时仍可能错误展示，违背本次需求。

### 不采用：直接复用 SDK ModelPanel

SDK 面板没有 LightVela 的 `fixedModelSelection`、连接检测和保存约束，替换会扩大改动面，并重新耦合宿主 UI。本次继续使用本地 Hook 和适配层。

### 不采用：为七彩石增加轮询或 TTL

当前 SDK 和 LightVela 都采用模块级会话缓存。用户已接受刷新或重新打开页面后同步，因此不引入额外网络请求和缓存失效机制。

## 边界与错误处理

- Provider 缺失：自然不生成对应 `ModelProviderOption`。
- Provider 模型为空或模型 ID 清洗后为空：不生成该 Hy Provider。
- Provider 中部分模型 ID 为空：继续使用现有清洗逻辑过滤无效模型；只要仍有有效模型就展示。
- 七彩石整体失败：由 `useModelProviders` 保持本地兜底，不在适配层再次判断网络状态。
- 其他 Provider：目录、发现策略、HTML 文本清洗和过滤规则保持不变。

## 验收标准

- 远端 Hy 返回两个有效模型时，面板目录严格保留两个模型及远端说明。
- 远端成功列表没有 Hy 时，适配结果不出现 Hy。
- 远端 Hy 的模型列表为空时，适配结果不出现 Hy。
- 本地 `MODEL_PROVIDER_LIST` 仍有 `hy4-preview`，保障七彩石整体失败兜底。
- Hy 仍标记为固定选择，不展示模型发现入口；连接检测和添加协议不变。
- 其他 Provider 回归通过，类型检查与差异检查通过。
