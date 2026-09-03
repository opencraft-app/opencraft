# Hy Token Plan 添加前自动验证设计

> 状态：已由《Coding Plan 七彩石模型目录设计》的后续产品决定废弃。当前交互保留独立手动检测，点击“添加模型”直接保存，不再自动触发检测。

## 背景

`tencent_hy_token_plan` 的模型目录改由七彩石提供后，不再需要通过“获取可用模型”发现模型。但是七彩石只证明模型属于产品目录，不能证明当前用户填写的 API Key 已开通套餐、能够访问所选模型或能够连通目标接口。

当前模型配置面板把这两个动作分开：

- “检测模型状态”通过 `connectivityProbe` 发起真实模型请求。
- “添加模型”保存凭据和 Hermes 配置。对 Hy Token Plan 使用 `discoverModels: false`，不会发起真实模型请求。

因此不能直接删除底层可用性验证；本设计删除独立检测入口，并把同一验证前置到添加操作中。

## 已确认需求

- 仅调整 `tencent_hy_token_plan`；其他 Provider 的模型发现、独立状态检测和添加流程保持不变。
- Hy Token Plan 不再展示独立的“检测模型状态”按钮。
- 用户点击“添加模型”时，必须先针对当前 API Key 和所选模型执行真实模型请求。
- 验证成功后直接继续添加，不额外弹出“检测成功”确认框。
- 验证失败时不得执行添加、不得写入配置或凭据；保留 API Key、模型和用途选择，方便用户修改后重试。
- 七彩石目录、远端缺失/空模型隐藏、本地 Hy4 整体失败兜底以及刷新后同步逻辑保持不变。

## 方案

### Provider 能力

在 `ModelProviderOption` 增加可选能力 `validateBeforeAdd?: boolean`。产品 Provider 适配层仅为 `tencent_hy_token_plan` 输出该能力。

不直接用 `fixedModelSelection` 推断添加前验证，因为“目录固定选择”和“保存前必须真实请求”是不同职责；未来增加其他固定目录 Provider 时，不应被意外改变添加协议。

### 面板交互

模型配置面板根据 `activeProvider.validateBeforeAdd` 处理：

1. 不渲染模型行右侧的独立“检测模型状态”按钮，Select 使用现有复合控件的完整可用宽度。
2. 点击“添加模型”时，先调用 `controller.testConnection`：
   - 模型为当前用户选择的七彩石目录模型；
   - 策略固定为 `model_request`；
   - API Key 使用当前输入值。
3. 验证结果成功时，不写入 `connectionResult`，直接调用现有 `controller.add`，继续传 `discoverModels: false`。
4. 验证结果失败时，只把失败结果写入 `connectionResult` 以复用现有失败弹窗，并立即结束添加流程。
5. 验证发生异常并返回 `null` 时，立即结束添加流程，复用现有操作错误展示。
6. 只有 `controller.add` 成功后才清空 API Key、模型临时状态并提示“模型已添加”。

### 数据流

```text
选择七彩石模型 + 输入 API Key + 选择用途
                    │
                    ▼
              点击“添加模型”
                    │
                    ▼
        connectivityProbe(model_request)
               │              │
            失败/异常          成功
               │              │
      保留表单，不执行 add      ▼
                       add(discoverModels=false)
                              │
                           保存成功
```

## 备选方案与取舍

### 采用：验证成功后再保存

不会把无效凭据或不可用模型写入配置，失败恢复成本最低，并能复用现有探测实现。

### 不采用：先保存再验证并回滚

会短暂写入凭据和配置，需要额外保证回滚完整性，并可能在失败窗口内留下错误运行态。

### 不采用：输入 API Key 后后台自动验证

会随着输入、Provider 切换和模型切换产生额外请求，容易出现竞态和不明确的 loading 状态。

## 状态与并发

- 验证期间沿用 `controller.operation === "connectivity-probe"` 的 busy 状态，禁用 Provider、模型、API Key 和添加操作，避免重复提交。
- 验证成功切换到添加操作时继续保持表单不可重复提交；不额外保存“已验证”缓存。
- 用户修改 API Key、Provider 或模型后，下一次点击添加必须重新验证。
- 不复用此前手动检测的成功结果，避免凭据或模型变化后使用过期状态。

## 错误处理

- API Key 为空、模型为空或 Provider 不匹配时，添加按钮继续禁用。
- 真实模型请求返回不可用时，展示现有失败弹窗及错误信息，不调用 `controller.add`。
- 探测命令异常时，展示现有操作错误，不调用 `controller.add`。
- 探测成功但添加失败时，保留 API Key 和当前选择，展示现有添加错误。
- 不在失败路径中清理用户输入，也不提前写入凭据或 Hermes 配置。

## 验证

- Hy Token Plan 不展示独立“检测模型状态”按钮，其他 Provider 继续展示。
- 点击 Hy 的“添加模型”时，动作顺序严格为 `connectivityProbe` 后 `add`。
- 探测使用 `strategy: "model_request"`、当前所选模型和当前 API Key。
- 探测成功后不展示成功检测弹窗，只显示最终“模型已添加”。
- 探测失败或异常时没有 `add` 动作，API Key、模型和用途保持不变。
- 添加继续使用 `discoverModels: false`，主模型、备用模型和仅添加用途保持原行为。
- 运行模型面板、controller、client 聚焦测试，随后运行 `pnpm check` 和 `git diff --check`。

## 不在范围内

- 不删除 `connectivityProbe`、`testConnection` 或相关 Hermes 脚本能力，因为其他 Provider 仍使用独立检测。
- 不改变其他 Provider 的按钮、模型发现或保存协议。
- 不改变七彩石请求、缓存、模型目录适配或整体失败兜底。
- 不增加验证结果缓存、后台轮询、自动重试、超时配置或新接口。
- 不迁移或重新验证用户已经保存的模型配置。
