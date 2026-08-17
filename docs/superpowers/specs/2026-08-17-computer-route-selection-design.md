# Computer 路由选择权设计

日期：2026-08-17  
状态：已确认

## 问题

`/computers/:computerId` 在同一个 Expo Router layout 内切换动态子路由时，浏览器 URL 会更新，
但父 layout 的 `useLocalSearchParams` 保留旧 child param。结果是列表交互和地址栏看似已切换，
`ComputersScreen.selectedComputerId` 仍是旧值，详情只有整页刷新后才正确。

## 权威边界

- URL 是路由环境中唯一的 Computer selection authority。
- `computers/_layout.tsx` 是 URL param 到稳定管理 surface 的投影边界。
- `ComputersScreen` 是受控/非受控双模式组件：提供 `selectedComputerId` 时只消费该值；没有该值时
  才使用 `localSelectedComputerId` 供 Style Lab、isolated tests 和非路由宿主使用。
- 点击列表项只调用 navigation adapter 推进 URL，不额外维护 optimistic route selection。
- list/detail child route 继续只负责匹配，不能重新拥有详情 surface。

## 实现

共享 Computers layout 使用 `useGlobalSearchParams` 读取当前活动 URL 的 `computerId`，再通过现有
`routeParam` 做单值规范化。`ExpoManagementRouteSurface` 保持同一组件身份，不增加 key，不因
`/computers/A -> /computers/B` 重挂载，因此创建表单、终端 controller 和页面级交互状态不会被
路由选择切换意外清空。

不在 `ComputersScreen` 增加 `useEffect` 镜像 route prop，也不让 `selectComputer` 同时写本地 state；
这两种做法都会形成 URL 与本地 selection 的双事实源。

## 验证

增加路由布局级回归测试：local params 固定为 A、global params 从 A 更新为 B，rerender 同一个
`ComputersLayout` 后，management surface 必须收到 B，并且 mount 次数仍为 1。现有 Screen tests
继续验证 unknown stable URL 不回退到第一台 Computer，以及无路由模式仍可本地选择。

发布前运行 focused Jest、全量 Web Jest、TypeScript、凭据扫描、Expo export，并在 live 页面验证
点击两个 Computer 后 URL、选中行和详情标题在同一次导航中一致。

