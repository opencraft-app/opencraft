# 已配置模型 Provider 分组切换设计

## 背景

当前 LightVela 模型配置页已经能读取全部已配置模型，并允许通过单个模型右侧的“设为主模型”切换主模型。但列表按模型平铺，Provider 边界不够直观，用户容易回到“添加模型”区域重新选择 Provider、填写 API Key，再次执行添加流程。

SDK 现有模型面板采用“按 Provider 分组、组内选择模型、切换默认模型”的结构。LightVela 本地模型面板应复用这一交互思路，但继续使用本地 `AgentModelConfigPanel`、Hermes 配置客户端和 `debug/exec` 链路，不重新引入 SDK 面板。

## 目标

- 将“已配置模型”按 Provider 分组展示。
- 用户可以在任意已配置 Provider 下选择一个已配置模型，并直接将其设为主模型。
- 切换复用已经保存的 Provider 配置和凭据，不重新添加 Provider、不重新输入 API Key、不执行模型探测。
- 操作按钮文案统一为“设为主模型”。

## 产品规则

### Provider 分组

1. “已配置模型”继续位于模型配置页顶部。
2. 模型按实际运行身份分组；分组键由 `providerKey` 与规范化后的 `routeBaseUrl`（缺失时使用 `baseUrl`）共同构成，避免同名 Provider 的不同接入地址被错误合并。
3. Provider 标题显示 Provider 名称；包含当前主模型的 Provider 显示“当前生效”状态。
4. Provider 分组支持展开和收起；默认展开当前生效的 Provider。没有当前主模型时默认展开第一个分组。

### 模型选择与切换

1. 展开 Provider 后，以单选列表展示该 Provider 下已配置的全部模型。
2. 当前主模型所在分组默认选中当前主模型；其他分组默认选中该分组的第一个已配置模型，用户可以改选。
3. 分组操作区使用“设为主模型”按钮。
4. 未选中模型、模型配置不完整、正在执行其他模型配置操作，或所选模型已经是当前主模型时，按钮禁用。
5. 点击“设为主模型”后直接调用现有 `controller.assign(selectedModel, "primary")`。该动作同时写入目标 `providerKey` 与 `modelId`，因此选择其他 Provider 下的模型时会同时切换 Provider 和主模型。
6. 切换过程不调用 `controller.add`、`controller.probe` 或 `controller.testConnection`，也不读取或重新提交 API Key。

### 既有能力保留

- 模型的“主模型 / 备用模型 / 未启用”状态继续展示。
- “设为备用模型 / 取消备用”和“删除”能力继续保留在对应模型行内。
- 主模型仍不可直接删除，必须先将其他模型设为主模型。
- 添加模型、自定义 Provider、模型探测、模型连接检测及用途选择保持现状。

## 状态与数据流

`controller.snapshot.configuredModels` → 按 Provider 运行身份分组 → 为每个分组维护当前单选模型 → 用户点击“设为主模型” → `controller.assign(model, "primary")` → 现有 Hermes 模型配置客户端更新 `config.model.provider` 与 `config.model.default` → 返回并渲染最新 snapshot。

本次不新增服务端状态。分组展开状态和单选状态仅存在于当前页面会话中；重新加载页面后由最新 snapshot 重新初始化。

## 错误与加载状态

- 切换期间沿用现有模型配置忙碌态，禁止并发添加、切换、删除或备用模型操作。
- 切换失败时继续在“已配置模型”区域展示现有就近错误，不清除用户当前选择，便于重试。
- 配置不完整的模型不进入可操作列表，沿用当前 `requiresSetup` 过滤规则。
- 没有已配置模型时继续展示现有空态与“添加第一个模型”入口。

## 实现范围

- 修改 `frontend/src/pages/marketing/agent-model-config/agent-model-config-panel.tsx`：增加 Provider 分组派生和分组式渲染，复用现有 controller 动作。
- 修改 `frontend/src/pages/marketing/agent-model-config/__tests__/model-config-panel.test.tsx`：覆盖分组、默认选择、跨 Provider 切换和既有操作回归。
- 如分组身份逻辑需要独立测试，可在 `use-model-config.ts` 或同目录小型纯函数中补充最小 helper；不为单次使用建立新的通用抽象。

## 验收标准

1. 已配置 Provider A 和 Provider B 时，“已配置模型”显示两个可展开分组。
2. 当前主模型所在 Provider 显示“当前生效”，并默认展开、选中当前主模型。
3. 展开 Provider B、选择其已配置模型并点击“设为主模型”后，提交一次 `assign`，参数同时包含 Provider B 的 `providerKey` 和目标 `modelId`。
4. 切换过程中不触发 `add`、`probe`、`testConnection`，不出现 API Key 输入要求。
5. 切换完成后 Provider B 显示“当前生效”，目标模型显示“主模型”。
6. 所选模型已经是主模型时，“设为主模型”禁用。
7. 备用模型设置/取消、删除限制、空态与错误态保持可用。
8. 国内站和国际站使用同一交互，所有用户可见文案通过现有 i18n 体系；操作文案固定为“设为主模型”。

## 非目标

- 不修改 SDK 源码或重新接入 SDK 模型面板。
- 不修改 Hermes 配置文件结构、凭据存储、加密或迁移逻辑。
- 不修改 Provider/模型目录，包括 Hy Token Plan 当前模型列表。
- 不新增后端接口，不改变 `debug/exec` 协议。
- 不自动切换主模型，不改变备用模型顺序或路由策略。

## 验证计划

- 先补面板测试并确认新分组交互在实现前失败。
- 最小实现后运行模型配置专项 Vitest，覆盖两个 Provider 间反复切换且无重新添加动作。
- 运行现有模型配置完整专项测试，确认添加、备用模型、删除、探测和错误展示无回归。
- 运行 `pnpm check`、`pnpm i18n:check` 和 `git diff --check`。
- 分别以国内站和国际站环境完成模型页浏览器 smoke，核对桌面端与移动端分组、单选按钮和“设为主模型”状态。
