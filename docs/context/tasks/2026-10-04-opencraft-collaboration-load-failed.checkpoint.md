## stage
只读诊断完成，等待是否实施的授权。

## verified
- 默认国内/国际公共 API 协作预检 404；国内 GET route_not_found 且无跨域许可。
- 北京入口有路由，但仅 localhost 预检取得 Allow-Origin；不能只换 URL。
- 协作加载耦合列表/资料/IM，直接展示原始错误；连接失败 Promise 被缓存。
- 本机后台健康，未修改行为或重启。

## unverified
- 用户浏览器当前 region、Origin 和具体失败请求；无可检查 tabs。
- 已登录请求、腾讯 IM 登录及完整业务数据链路。

## discard
- 生成翻译 Load failed 的命中不属于此插件。
- smoke 时段 WebSocket 故障不能当成用户故障证据。

## restore
- 同名 Task Pack 中记录请求证据、入口与授权边界。

## next_action
- 向用户说明接口路由/CORS 阻断与恢复缺陷；修复或服务发布须另获授权。
