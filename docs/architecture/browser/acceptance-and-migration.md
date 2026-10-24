# Browser: Acceptance and migration

[Architecture index](../../browser-workbench-architecture.md) · [Documentation index](../../README.md)

## 19. 测试不变量

### 19.1 身份与 Runtime

- 同一 Thread ID 在不同 Host 不碰撞；
- BrowserSessionId 不因 Authority replacement、Panel 切换、Renderer 重载而改变；
- `profileId` 可稳定持久化，`runtimeId/engineInstanceId/generation` 不从 checkpoint 复用；
- Conversation host 与 Browser Authority 可以不同；
- Supervisor 逆序销毁全部子 Runtime；
- 多个 Cordis Context 允许存在，但同一物理 connection/instance 只有一个 owner；
- Strict Mode/HMR 不创建重复连接。

### 19.2 Browser Domain

- resource/connectivity/navigation 三条状态轴不互相覆盖；
- 错误 runtimeId/engineInstanceId、旧 AuthorityGeneration、重复 eventSeq 和迟到
  navigationId 被拒绝；
- unsupported capability 不修改 snapshot；
- URL 只能由 policy 构造；
- 不伪造完整 native history；
- closing tombstone 阻止资源复活。

### 19.3 View 与 Presentation

- ViewHandle dispose 幂等；
- collapse/switch 只 background，不释放 ViewHandle；
- React unmount 只释放 View，不能 close Session 或 terminate Authority；
- close logical Session 与 terminate Authority 是两条独立命令；
- agent-use 在 UI unmount 后仍能保持 Backing；UI 在 agent-use 结束后仍可凭 logical-tab
  owner 保持 Backing；
- owner set 清空只触发驻留 policy，不伪造远端 terminate；
- 同 Renderer 一个 Session 最多 reveal 一个前台 Presentation；
- 快速 A → B → A 无白闪、串页和迟到 reveal；
- 高频 bounds 不触发 React snapshot storm；
- hidden Presentation 同时关闭 pointer 与 accessibility exposure。

### 19.4 平台 capability contract

测试按 capability 运行，不要求每个平台假装支持相同功能：

| 能力 | Vite iframe | Electron | Expo Native | Remote |
| --- | --- | --- | --- | --- |
| arbitrary origin | 有条件 | 是 | 是 | 是 |
| survives detach | 否 | 是 | 通常否 | 是 |
| multiple viewers | 否 | 否 | 否 | 是 |
| native history projection | 有限 | 是 | 是 | 是 |
| cross-device same instance | 否 | 否 | 否 | 是 |

### 19.5 Remote 与安全

- observer 不能获得控制权限或发送输入；
- stale generation/controlEpoch/inputSeq/viewportRevision 全部拒绝；
- controller 断线后必须重新 acquire；
- frameSeq 可丢旧帧，慢客户端不阻塞 Authority；
- 实时帧不进入 Replica/Journal；
- 原始 URL secret、Cookie 和 restore candidate 不进入普通 storage；
- iframe origin/source/nonce/requestId 重放测试全覆盖。

### 19.6 AppShell

- `left + main + right == shell`；
- Browser Presentation 不溢出 slot/clip；
- full-width header actions 不重叠；
- 折叠后 reopen action 仍可见；
- 639px 与 iPad split 无页面横向溢出；
- Panel 拖拽不改变聊天时间线宽度权威。

## 20. 实施顺序

### Phase -1：修正现有横切边界

- 引入 `ApplicationSupervisor`，把 Runtime 创建移到 React bootstrap；
- 保留多个 lifecycle Context，建立唯一物理资源 owner 测试；
- 引入应用级 `HostRuntimeRegistry`；每个 HostRuntime 直接拥有一个 AppServerClient；
- 将 `createAppServerWorkbenchRuntime()` 的单项 client registry 降为兼容 factory/test
  utility，避免两层 registry 竞争生命周期；
- Panel key 升级为 `ConversationKey`；
- 将桌面 layout state 从共享 Resource registry 分离；
- 删除 mock panel resource 与真实资源的混用。

完成门：多 Host ID 不碰撞，Strict Mode/HMR 不复制连接，Web 现有功能不回归。

### Phase 0：Vite 单标签纵切

- 最小 browser-core/runtime；
- same-origin iframe Engine；
- Web Presentation Root；
- navigate/back/forward/reload、collapse/reopen；
- URL/Bridge/security fixture。

完成门：一个逻辑 Session 在 Panel 折叠、展开、切换后不丢失，iframe denied 明确降级。

### Phase 1：Electron 第二实现

- main-process WebContents Engine；
- typed IPC、partition、权限和 crash recovery；
- Renderer reload reattach；
- 与 iframe 共用 Domain contract。

完成门：第二 Adapter 暴露的问题已回写 SPI，尚未使用的抽象被删除。

### Phase 2：冻结 v1 与多标签

- 冻结 Engine/Presentation v1；
- 多 Session、多 View、最近标签回退；
- stage/reveal/background；
- checkpoint 与故障恢复；
- 动态 title/favicon presentation。

完成门：快速切换 100 次无白闪、错页、泄漏。

### Phase 3：Remote Browser

- AppServer namespace/capability discovery；
- WebSocket 与 WebSocket over SSH；
- observer/controller lease；
- frame data plane 与坐标换算；
- Remote durable facts 的 V4 projector。

完成门：Web、Electron 可以观察并接管同一 Remote instance，旧输入无法穿透 fencing。

### Phase 4：Expo

- Native WebView Engine/Presentation；
- resident pool 与内存回收恢复；
- iPad split、iPhone route、Expo Web iframe；
- safe area、keyboard、gesture、VoiceOver。

完成门：共享命令/身份/capability fixture 通过；不要求各平台物理 history 完全相等。

### Phase 5：Inline Sandbox 与生产强化

- Assistant HTML 独立 CSP/Bridge；
- artifact/attachment host；
- 下载、权限、审计与遥测；
- capability-based chunk 边界。

## 21. 迁移与删除

通过对应门后逐步删除：

- Panel 组件本地 `currentUrl/history/loading`；
- `display:none` 偶然保活 iframe；
- ResizeObserver 回写 AppShell 主宽度；
- 修按钮重叠的局部 z-index workaround；
- timeout 恢复条件渲染后的 Surface；
- mock Changes/Terminal 占位资源；
- React Provider 内创建物理 Runtime；
- 只用裸 `threadId` 的 Panel Map；
- 把 right/bottom/full-width 暴露给 Native 的共享状态；
- UI 直接终止 Remote Authority；
- 用 View 数量或 React unmount 推导 Session/Backing 生命周期；
- 同时让低层 AppServer client registry 与 HostRuntimeRegistry 拥有同一 client；
- 把 Authority profile、runtime incarnation、Engine instance 和 restore ref 混成一个 ID；
- 把逻辑 Browser ID 与 Conversation Host 强制绑成同一复合主键的错误不变量；
- Surface 上重复的 restore/history ownership。

不做一次性大清理。每类删除前先落地不变量测试。

## 22. 完成定义

1. Conversation identity、Browser logical identity、Authority profile/runtime/Engine binding 和 Presentation identity 完全分离。
2. 一个 Supervisor 管理多个生命周期域；同一物理资源只有一个 owner。
3. 共享 Resource 不含 right/bottom/full-width 等平台布局状态。
4. Browser UI snapshot 不暴露 Backing/WebContents/storage/eventSeq 内部细节。
5. Authority、Presentation、Host policy 和 Session lifecycle 命令不混用。
6. iframe 与 Electron 两种实现共同证明并冻结 Engine/Presentation v1。
7. Local 只承诺共享行为；只有 Remote 承诺跨设备同一运行实例。
8. Remote control 有 generation、lease fencing、input sequence 和 viewport revision。
9. 实时帧、presence 和 control lease 不进入 durable Replica。
10. 原始秘密与恢复材料不进入普通 checkpoint。
11. 高频几何不形成 React/Cordis/AppShell 反馈环。
12. Vite、Electron、Expo 按 capability contract 验收，而不是伪造完全相同的平台能力。
13. React unmount、View dispose、Session close、Authority terminate 与 Backing destroy 有独立命令和测试。
14. 每个 HostRuntime 拥有一个逻辑 AppServerClient；共享物理 transport 时只由 TransportBroker 复用帧通道。
15. 插件只能经 capability Port 请求 Browser 操作；Extension unload 不销毁不归它所有的 Session、Backing 或 Surface。
16. Agent 只看到 Browser Capability，不看到 Extension/Engine/Adapter；每次调用都钉住 Lease、Provider revision 与 Invocation identity。

最终形态不是“一个巨大 Cordis Context 管住五层”，而是：一个稳定语义模型、一个显式
Supervisor、多个有清晰所有权的 Runtime scope，以及可被两种以上实现证明的最小接口。

## 23. R6 复审结论

以下所有权与生命周期规则已经定案，不再作为实现阶段的开放二选一：

1. View 只是 presentation claim；Session、Authority 与 Backing 生命周期不能由 React
   mount 数量推导。
2. Authority 使用稳定 `profileId`、短命 `runtimeId`、物理 `engineInstanceId` 与 binding
   `generation` 四层身份；checkpoint 只保存 profile 与 opaque restore ref。
3. 应用级 Registry 索引完整 `HostRuntime`；每个 HostRuntime 直接拥有一个逻辑
   AppServerClient；物理多路复用下沉到可选 TransportBroker。
4. 逻辑 Session close 与 Authority terminate 分开；close 先提交 tombstone，物理清理最终
   完成，不能回滚成 active。
5. Cordis 是内部生命周期内核，不是社区扩展 ABI 或安全沙箱；跨 Chat/Panel/Browser 的
   插件贡献由 ExtensionSupervisor 原子登记，社区代码只能经过 capability/sandbox 边界。
6. Extension 是 Browser Capability 的实现载体，不是 Agent-facing identity；Resolver、
   Task Lease、Execution Router 与 Receipt Journal 属于 AgentCapabilityRuntime。

当前代码与目标模型之间仍有四项明确迁移工作：

| 当前路径 | 现状 | R6 目标 |
| --- | --- | --- |
| `packages/workbench-runtime/src/appserver-runtime.ts` | 每个单 Host runtime 内创建一项 Cordis client registry | HostRuntime 直接拥有 client，由应用 HostRuntimeRegistry 索引 |
| `apps/workbench-web/src/runtime/appserver-runtime-context.tsx`、`apps/workbench-expo/src/runtime/runtime-context.tsx` | Runtime 仍由 React Provider 构造 | bootstrap 的 ApplicationSupervisor 构造，Provider 只借用稳定引用 |
| Browser packages | 尚未实现本设计的 Session/owner/presentation 分层 | Phase 0 iframe 与 Phase 1 Electron 两个纵切共同校正 SPI |
| Chat/Panel renderer registries | 各自暴露内部 Cordis `install(plugin, unknown)` | 保持内部 API；由 ExtensionSupervisor/Contribution Broker 提供公共扩展入口 |

仍然保持 provisional 的只有物理 Adapter SPI 细节、Native resident pool 策略和 Remote
Browser 协议能力发现；它们必须由第二实现或真实服务证据决定。身份、生命周期与 Host
client 所有权不应再因这些 Adapter 细节反复改动。
