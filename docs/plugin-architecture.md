# OpenCraft Extension Platform 与插件内核架构

本页是插件内核架构入口。当前实现账本、正式契约、目标设计与验收限制按职责保留在下列专题正文；开发入口见 [Extension development](extension-development.md)，修改行为时维护对应专题。

| 专题 | 范围 |
| --- | --- |
| [Architecture and lifecycle](architecture/extensions/architecture-and-lifecycle.md) | 扩展边界、状态所有权、拓扑、Cordis 与跨端职责 |
| [Manifest and contributions](architecture/extensions/manifest-and-contributions.md) | 公共 Manifest/API、Artifact、贡献登记与 View 恢复 |
| [Identity and execution](architecture/extensions/identity-and-execution.md) | 服务端身份、Relay 装配、执行信任与可选访问策略 |
| [Product composition](architecture/extensions/product-composition.md) | 产品装配、主体元数据、品牌与 Provider 扩展 |
| [Implementation and acceptance](architecture/extensions/implementation-and-acceptance.md) | 当前实现账本、设计差距、实施阶段与质量不变量 |

## 章节索引

下列旧章节锚点继续有效，并链接到对应正文。

### Architecture and lifecycle

- <a id="1-结论"></a>[1. 结论](architecture/extensions/architecture-and-lifecycle.md#1-结论)
- <a id="2-客户端扩展边界"></a>[2. 客户端扩展边界](architecture/extensions/architecture-and-lifecycle.md#2-客户端扩展边界)
- <a id="3-先区分两种插件"></a>[3. 先区分两种“插件”](architecture/extensions/architecture-and-lifecycle.md#3-先区分两种插件)
- <a id="4-第一性原理"></a>[4. 第一性原理](architecture/extensions/architecture-and-lifecycle.md#4-第一性原理)
- <a id="41-安装启用解析与激活不是一件事"></a>[4.1 安装、启用、解析与激活不是一件事](architecture/extensions/architecture-and-lifecycle.md#41-安装启用解析与激活不是一件事)
- <a id="42-插件activationcontribution-与-view-必须分离"></a>[4.2 插件、Activation、Contribution 与 View 必须分离](architecture/extensions/architecture-and-lifecycle.md#42-插件activationcontribution-与-view-必须分离)
- <a id="43-执行位置权限和呈现位置是三条正交轴"></a>[4.3 执行位置、权限和呈现位置是三条正交轴](architecture/extensions/architecture-and-lifecycle.md#43-执行位置权限和呈现位置是三条正交轴)
- <a id="44-所有状态必须有权威方"></a>[4.4 所有状态必须有权威方](architecture/extensions/architecture-and-lifecycle.md#44-所有状态必须有权威方)
- <a id="5-目标拓扑"></a>[5. 目标拓扑](architecture/extensions/architecture-and-lifecycle.md#5-目标拓扑)
- <a id="51-连接类型不是-host-类型"></a>[5.1 连接类型不是 Host 类型](architecture/extensions/architecture-and-lifecycle.md#51-连接类型不是-host-类型)
- <a id="6-cordis-的准确位置"></a>[6. Cordis 的准确位置](architecture/extensions/architecture-and-lifecycle.md#6-cordis-的准确位置)
- <a id="61-cordis-负责什么"></a>[6.1 Cordis 负责什么](architecture/extensions/architecture-and-lifecycle.md#61-cordis-负责什么)
- <a id="62-cordis-不负责什么"></a>[6.2 Cordis 不负责什么](architecture/extensions/architecture-and-lifecycle.md#62-cordis-不负责什么)
- <a id="63-不合并成一个巨大-context"></a>[6.3 不合并成一个巨大 Context](architecture/extensions/architecture-and-lifecycle.md#63-不合并成一个巨大-context)
- <a id="64-view入口与布局不得合并"></a>[6.4 View、入口与布局不得合并](architecture/extensions/architecture-and-lifecycle.md#64-view入口与布局不得合并)
- <a id="11-跨平台策略"></a>[11. 跨平台策略](architecture/extensions/architecture-and-lifecycle.md#11-跨平台策略)
- <a id="12-与-appserver--multi-host-的关系"></a>[12. 与 AppServer / Multi-Host 的关系](architecture/extensions/architecture-and-lifecycle.md#12-与-appserver--multi-host-的关系)
- <a id="13-包与模块边界"></a>[13. 包与模块边界](architecture/extensions/architecture-and-lifecycle.md#13-包与模块边界)

### Manifest and contributions

- <a id="7-公共-manifest-与-api"></a>[7. 公共 Manifest 与 API](architecture/extensions/manifest-and-contributions.md#7-公共-manifest-与-api)
- <a id="71-当前-manifest-v1"></a>[7.1 当前 Manifest V1](architecture/extensions/manifest-and-contributions.md#71-当前-manifest-v1)
- <a id="72-当前公共-api"></a>[7.2 当前公共 API](architecture/extensions/manifest-and-contributions.md#72-当前公共-api)
- <a id="721-稳定性契约与后续目标"></a>[7.2.1 稳定性契约与后续目标](architecture/extensions/manifest-and-contributions.md#721-稳定性契约与后续目标)
- <a id="73-发行解析与-artifact"></a>[7.3 发行、解析与 Artifact](architecture/extensions/manifest-and-contributions.md#73-发行解析与-artifact)
- <a id="10-contribution-模型"></a>[10. Contribution 模型](architecture/extensions/manifest-and-contributions.md#10-contribution-模型)
- <a id="101-所有登记都必须带-owner"></a>[10.1 所有登记都必须带 Owner](architecture/extensions/manifest-and-contributions.md#101-所有登记都必须带-owner)
- <a id="102-公开贡献面"></a>[10.2 公开贡献面](architecture/extensions/manifest-and-contributions.md#102-公开贡献面)
- <a id="103-view-恢复"></a>[10.3 View 恢复](architecture/extensions/manifest-and-contributions.md#103-view-恢复)

### Identity and execution

- <a id="服务端请求身份端口"></a>[服务端请求身份端口](architecture/extensions/identity-and-execution.md#服务端请求身份端口)
- <a id="relay-启动装配"></a>[Relay 启动装配](architecture/extensions/identity-and-execution.md#relay-启动装配)
- <a id="8-三种执行策略"></a>[8. 三种执行策略](architecture/extensions/identity-and-execution.md#8-三种执行策略)
- <a id="internal"></a>[Internal](architecture/extensions/identity-and-execution.md#internal)
- <a id="trusted"></a>[Trusted](architecture/extensions/identity-and-execution.md#trusted)
- <a id="restricted可选"></a>[Restricted（可选）](architecture/extensions/identity-and-execution.md#restricted可选)
- <a id="9-可选访问策略"></a>[9. 可选访问策略](architecture/extensions/identity-and-execution.md#9-可选访问策略)

### Product composition

- <a id="trusted-product-thread-metadata-and-badges"></a>[Trusted product Thread metadata and badges](architecture/extensions/product-composition.md#trusted-product-thread-metadata-and-badges)
- <a id="application-branding"></a>[Application branding](architecture/extensions/product-composition.md#application-branding)
- <a id="startup-registration-and-demand-presentation"></a>[Startup registration and demand presentation](architecture/extensions/product-composition.md#startup-registration-and-demand-presentation)
- <a id="provider-owned-composer-commands"></a>[Provider-owned Composer commands](architecture/extensions/product-composition.md#provider-owned-composer-commands)
- <a id="removed-product-built-ins"></a>[Removed product built-ins](architecture/extensions/product-composition.md#removed-product-built-ins)

### Implementation and acceptance

- <a id="当前实现账本2026-09-04"></a>[当前实现账本（2026-09-04）](architecture/extensions/implementation-and-acceptance.md#当前实现账本2026-09-04)
- <a id="插件平台补齐进度2026-09-22"></a>[插件平台补齐进度（2026-09-22）](architecture/extensions/implementation-and-acceptance.md#插件平台补齐进度2026-09-22)
- <a id="14-当前设计差距"></a>[14. 当前设计差距](architecture/extensions/implementation-and-acceptance.md#14-当前设计差距)
- <a id="141-已经正确"></a>[14.1 已经正确](architecture/extensions/implementation-and-acceptance.md#141-已经正确)
- <a id="142-尚未完成的生态边界"></a>[14.2 尚未完成的生态边界](architecture/extensions/implementation-and-acceptance.md#142-尚未完成的生态边界)
- <a id="143-extension-workshopvibe-coding-的产品入口"></a>[14.3 Extension Workshop：Vibe coding 的产品入口](architecture/extensions/implementation-and-acceptance.md#143-extension-workshopvibe-coding-的产品入口)
- <a id="15-实施顺序"></a>[15. 实施顺序](architecture/extensions/implementation-and-acceptance.md#15-实施顺序)
- <a id="phase-0冻结术语与边界"></a>[Phase 0：冻结术语与边界](architecture/extensions/implementation-and-acceptance.md#phase-0冻结术语与边界)
- <a id="phase-1可信内建扩展内核"></a>[Phase 1：可信内建扩展内核](architecture/extensions/implementation-and-acceptance.md#phase-1可信内建扩展内核)
- <a id="phase-2惰性激活与恢复"></a>[Phase 2：惰性激活与恢复](architecture/extensions/implementation-and-acceptance.md#phase-2惰性激活与恢复)
- <a id="phase-3extension-workshop"></a>[Phase 3：Extension Workshop](architecture/extensions/implementation-and-acceptance.md#phase-3extension-workshop)
- <a id="phase-4远端-host-与-agent-contribution"></a>[Phase 4：远端 Host 与 Agent Contribution](architecture/extensions/implementation-and-acceptance.md#phase-4远端-host-与-agent-contribution)
- <a id="phase-5restricted-channel按商业需求选做"></a>[Phase 5：Restricted Channel（按商业需求选做）](architecture/extensions/implementation-and-acceptance.md#phase-5restricted-channel按商业需求选做)
- <a id="16-质量门与不变量"></a>[16. 质量门与不变量](architecture/extensions/implementation-and-acceptance.md#16-质量门与不变量)
- <a id="生命周期"></a>[生命周期](architecture/extensions/implementation-and-acceptance.md#生命周期)
- <a id="稳定-api"></a>[稳定 API](architecture/extensions/implementation-and-acceptance.md#稳定-api)
- <a id="restricted-channel-安全门启用时"></a>[Restricted Channel 安全门（启用时）](architecture/extensions/implementation-and-acceptance.md#restricted-channel-安全门启用时)
- <a id="一致性"></a>[一致性](architecture/extensions/implementation-and-acceptance.md#一致性)
- <a id="跨平台"></a>[跨平台](architecture/extensions/implementation-and-acceptance.md#跨平台)
- <a id="17-复审结论"></a>[17. 复审结论](architecture/extensions/implementation-and-acceptance.md#17-复审结论)
