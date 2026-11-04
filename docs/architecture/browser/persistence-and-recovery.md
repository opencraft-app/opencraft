# Browser: Persistence and recovery

[Architecture index](../../browser-workbench-architecture.md) · [Documentation index](../../README.md)

## 14. Replica、Checkpoint 与安全

### 14.1 可进入 V4 Replica

- V4-native Remote Authority 的 durable session created/ended 和可重放状态；
- Browser 与 Conversation 的服务端权威关系变化；
- 清洗后的 URL/title/navigation outcome；
- 用户明确保存或工具产出的截图/页面快照资源引用。

Controller lease、presence、loading、音频、Presentation、viewport 和实时 frame 都是
ephemeral state，不进入 durable Replica Journal。

browser-use/tool 事件可投影为聊天活动、截图和链接，但这些投影不能作为完整交互式
Browser RPC 的能力凭据；是否可交互仍须核对实际协议能力。

### 14.2 本地 View Checkpoint

```ts
export type BrowserRestoreHandleRef = string & {
  readonly __brand: "BrowserRestoreHandleRef";
};

export interface BrowserCheckpointV1 {
  readonly version: 1;
  readonly browserSessionId: BrowserSessionId;
  readonly authorityProfileId: BrowserAuthorityProfileId | null;
  readonly safeUrl: BrowserSafeRestoreUrl | null;
  readonly restoreHandleRef: BrowserRestoreHandleRef | null;
  readonly capturedAt: number;
}
```

安全材料只存在 Electron main 加密存储、iOS Keychain 或远端 vault。普通
IndexedDB/localStorage 只保存 opaque ref；Web 没有安全 vault 时 ref 必须为 null。
`runtimeId`、`engineInstanceId`、Authority/Presentation generation、adoption lease 和
WebContentsId 永不进入 checkpoint。恢复后创建新 runtime/instance，并通过新的 binding
generation fence 掉旧事件。

### 14.3 永不持久化到普通 View/Replica

- Cookie、localStorage、sessionStorage 内容；
- Bearer token、OAuth code、签名 URL；
- WebContentsId、WindowProxy、DOM node、MessagePort；
- 摄像头/麦克风授权 token；
- 原始恢复材料和注入脚本闭包。

原始 URL 默认敏感。Disclosure policy 决定保存 origin、清洗后的 path、hash 或完全
省略。

## 15. iframe Bridge

握手流程：

1. Host 创建 nonce、embedId 和 MessageChannel；
2. iframe load 后 transfer port；
3. 双方校验协议版本、nonce、embedId、source 和 allowed origin；
4. 业务消息只走 MessagePort；
5. 每个 requestId 只允许响应一次；
6. clipboard、download、popup、camera、microphone 默认拒绝。

Bridge 不发送原始登录 token。可信 iframe 也只能调用最小权限委托 RPC，Host 返回业务
结果或短期、单用途 capability handle。

Assistant HTML 使用独立更严格 CSP，不与通用浏览器共享 Cookie、权限或 Bridge policy。

## 16. TanStack Query

适合：

- Browser/Thread catalog；
- bookmark、下载记录和持久 artifact 元数据；
- capability discovery；
- 冷数据分页查询。

不适合：

- active Browser Session snapshot；
- Presentation visibility/focus；
- pointer/frame stream；
- Panel drag animation；
- Replica cursor 状态机。

Query key 必须包含资源真正的 identity，不能仅用裸 session/thread ID：Host 数据使用
`hostId`；Authority 配置目录使用 `profileId`；只在缓存一次运行时实例结果时才加入
`runtimeId + generation`。持久查询键不得包含短命 `engineInstanceId`。

## 17. 失败与恢复

### 17.1 iframe 拒绝

```text
navigate → embed-denied
  → policy allows remote ? bind replacement Authority runtime/instance
  → otherwise external fallback
```

逻辑 BrowserSessionId 保持不变；Authority Binding generation 提升。

### 17.2 Host/Authority 断线

```text
connectivity = recovering
  → 保留最后可显示 snapshot/frame
  → transport reconnect / replica catch-up
  → allocate new runtimeId/engineInstanceId as needed
  → rebind with new AuthorityGeneration
  → ready or explicit failed
```

### 17.3 Presentation 丢失

```text
presentation lost
  → PresentationGeneration + 1
  → Engine survives detach ? attach replacement
  → otherwise Session suspended → restore Engine instance
  → stage → atomic reveal
```

### 17.4 防 React 更新环

- `getSnapshot()` 无变化时返回相同引用；
- React effect 只订阅，不把 snapshot 无条件写回 Store；
- bounds 使用 epsilon + animation-frame coalescing；
- Surface measurement 不回写 AppShell 宽度；
- plugin registration 不在会反复挂载的内容组件里；
- connection、Authority、Presentation、Layout generation 分别校验；
- View claim/Backing owner 变更必须走幂等 command，不允许订阅回调同步反写同一个 Store。


### Authoritative remote tab closure

The remote surface forwards SESSION_CLOSED and the explicit server close reason
to the logical Page owner. Workbench removes the corresponding tabs, panels and
presentations rather than retaining an error that can reload a retired lease.
An acknowledged remote close does not issue another discard or allocate a fresh
lease. Metadata fences and transport callbacks check their connection identity;
a stale callback cannot end a replacement connection. Ordinary disconnection
and admission errors keep their separate recovery/error semantics. Server close
notifications follow the durable retirement commit.
