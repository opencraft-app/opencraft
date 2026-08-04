# Expo Web 静态部署到腾讯云 COS

## 部署边界

前端是完全独立的静态 SPA。浏览器直接连接两类服务：

- 平台 Go API：注册、登录、Server、Member、Agent、Computer、Task 等业务控制面；
- 腾讯云 IM Web SDK：Channel、DM、历史消息、实时消息与已读状态。

静态站点不需要 Node.js 服务端，也不通过 Next.js SSR。生产构建时必须设置独立的 API 地址：

```sh
cd apps/client
EXPO_PUBLIC_VELA_API_URL=https://api.example.com bun run build:web
```

构建产物位于 `apps/client/dist/`，可整体上传到 COS。

## COS 静态网站设置

在 COS 存储桶的“基础配置 → 静态网站”中设置：

- 强制 HTTPS；
- 索引文档：`index.html`；
- 错误文档：`index.html`；
- 错误文档响应码：`200`。

最后一项是浏览器深链接可刷新的关键。`/s/atlas`、`/s/atlas/c/...`、`/dm/...` 在 COS 中并没有同名文件；COS 必须返回 `index.html` 和 HTTP 200，再由 Expo Router 在浏览器中解释路径。

如果前面使用腾讯云 CDN，同样把未命中对象的 `403/404` 改写到 `/index.html`，对浏览器返回 `200`。不要使用 301/302 跳转到根路径，否则地址栏中的 Server、Channel 或 DM 链接会丢失。

## 缓存建议

- `index.html`：不缓存，或使用很短的缓存时间；
- 带内容哈希的 JS、CSS、字体与图片：长期缓存并标记 immutable；
- 发布新版本时先上传哈希资源，最后覆盖 `index.html`。

## 跨域与安全

- Go API 只允许正式前端域名进行 CORS 请求，并允许携带平台认证所需的请求头；
- 腾讯云 IM 的 `SDKAppID` 可以出现在前端，UserSig 私钥只能留在 Go 后台；
- `EXPO_PUBLIC_VELA_API_URL` 是公开配置，不得包含密钥；
- `?backend=` 只在 `localhost`、`127.0.0.1` 或回环 IPv6 页面生效，正式域名会忽略并移除它。

## 验证

本地构建后验证所有固定路由均能回退到同一个 SPA 入口：

```sh
cd apps/client
bun run build:web
bun run verify:web-fallback
```

部署后验证 COS/CDN 的真实回退规则：

```sh
VELA_WEB_VERIFY_ORIGIN=https://app.example.com bun run verify:web-fallback
```

验证器会直接请求 Server 根、Channel、四个管理页和 DM 深链接，并要求返回 HTTP 200 与 HTML。
