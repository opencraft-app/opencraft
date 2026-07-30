# 小程序 SDK（universal-report-mp）用法说明

## 初始化参数详解

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| beacon | string | ✅ | 小程序 appKey |
| system | object | ✅ | 小程序环境对象：`wx` / `Taro` / `qq` / `tt` |
| pageSelector | string | ✅ | 页面根元素选择器，建议 `.dt-pg` |
| exposeSelector | string | ✅ | 元素曝光选择器，建议 `.dt-el` |
| autoReport | boolean | ✅ | 是否启动自动采集 |
| publicParams | object | ❌ | 业务公共参数，所有事件自动携带 |
| log | number | ❌ | 日志级别：0-关闭 1-基础 2-详细 |
| beforeReport | function | ❌ | 上报前钩子，可拦截/修改上报数据 |

**完整配置示例：**

```javascript
wx.universalReport = new UniversalReport({
  beacon: 'your_app_key',
  system: wx,
  pageSelector: '.dt-pg',
  exposeSelector: '.dt-el',
  autoReport: true,
  publicParams: {
    platform: 'mp',
    channel: 'wechat',
    version: '2.1.0',
  },
  log: 1,
  beforeReport: (context) => {
    // 过滤调试事件
    if (context.eventName === 'dt_imp_end') {
      return false
    }
    return true
  },
})
```

---

## 公共参数管理

```javascript
const reporter = wx.universalReport

// 设置公共参数
reporter.setPublicParams({
  user_id: '12345',
  channel: 'wechat',
})

// 获取公共参数
const params = reporter.getPublicParams()

// 删除单个公共参数
reporter.removePublicParams('user_id')
```

---

## 用户信息设置

```javascript
// 登录后设置用户信息
reporter.setPublicParams({
  dt_qq: 'qq_number',
  dt_wxopenid: 'wx_openid',
  dt_mainlogin: 'wx',
})

// 登出时清空
reporter.removePublicParams('dt_qq')
reporter.removePublicParams('dt_wxopenid')
```

---

## 手动控制页面埋点

需要精确控制页面上报时机时：

```javascript
// 手动设置当前页面
reporter.setPage({
  pgid: 'pg_login',
  tab: 'wx',
})

// 手动上报页面曝光
reporter.reportPV('pg_login')

// 手动上报页面结束曝光（携带停留时长）
reporter.reportPgOut('pg_login', {
  duration: 120,  // 停留时长，单位秒
})
```

---

## 手动控制元素埋点

```javascript
// 手动上报元素事件
reporter.reportEvent({
  eventName: 'dt_clck',
  pgid: 'pg_login',
  businessParams: {
    eid: 'btn_login_wx',
    login_type: 'wx',
  },
})
```

---

## 上报前钩子（beforeReport）

用于过滤、抽样或修改上报数据：

```javascript
wx.universalReport = new UniversalReport({
  beacon: 'your_app_key',
  system: wx,
  pageSelector: '.dt-pg',
  exposeSelector: '.dt-el',
  autoReport: true,
  beforeReport: (context) => {
    // 过滤：不上报元素结束曝光
    if (context.eventName === 'dt_imp_end') {
      return false
    }

    // 抽样：只上报 10% 的曝光事件
    if (context.eventName === 'dt_imp' && Math.random() > 0.1) {
      return false
    }

    // 修改：给所有事件添加额外参数
    context.businessParams = context.businessParams || {}
    context.businessParams.timestamp = Date.now()

    return true  // 允许上报
  },
})
```

---

## 调试工具

### 开启日志

```javascript
wx.universalReport = new UniversalReport({
  beacon: 'your_app_key',
  system: wx,
  pageSelector: '.dt-pg',
  exposeSelector: '.dt-el',
  autoReport: true,
  log: 1,  // 0-关闭 1-基础日志 2-详细日志
})
```

日志输出在小程序开发者工具控制台中查看。

### 可视化联调

SDK 支持可视化联调功能，可在大同平台实时查看上报数据和埋点状态。

---

## 常见问题

### 自动采集不生效？

1. 检查 SDK 是否在 `new App()` 之前初始化
2. 检查 `pageSelector` / `exposeSelector` 与 WXML 中的 class 是否匹配
3. 检查 `system` 参数是否传入正确（Taro 传 `Taro`，不是 `wx`）
4. 开启 `log: 2` 查看详细日志排查

### Taro 项目中 className 不生效？

确保 Taro 编译后的 WXML 中 class 名称与配置一致。Taro 3 使用 `className`，编译后变为 `class`。

```jsx
// 正确
<View className="dt-pg" data-dt-pgid="pg_login">

// 错误（不要在小程序原生写法中用 dt-pgid 属性）
<view dt-pgid="pg_login">
```

### 如何确认 SDK 正常工作？

1. 开启日志模式：`log: 1`
2. 打开小程序开发者工具控制台查看上报日志
3. 使用大同平台的可视化联调功能

### 声明式埋点和手动上报如何选择？

- **声明式埋点（推荐）**：适合标准页面和元素埋点，通过 `data-dt-pgid` / `data-dt-eid` 自动采集，简单快捷
- **手动上报**：需要精确控制上报时机，或上报自定义事件

可以混合使用：标准埋点用声明式，特殊场景用手动。
