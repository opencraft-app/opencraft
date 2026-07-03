# 无埋点版 SDK（autotracker）高级功能

## 插件配置

SDK 采用插件化架构，所有采集功能由插件实现。

### 插件概览

| 插件名称 | 上报事件 | 默认开启 | 说明 |
|----------|----------|----------|------|
| Router | at_imp, at_stay_page | 是 | 路由与页面停留采集 |
| Click | at_click | 是 | 元素点击 |
| Exposure | at_show_area, at_stay_area | 否 | 元素曝光与停留采集 |
| Scroll | at_scroll_page | 否 | 页面滚动深度采集 |

### 配置默认插件

```javascript
// 修改 Click 插件：自动采集类名以 'click-' 开头的元素
autoInstance.config('Click', {
  autoSelector: ['[class^=click-]']
})
```

### 加载可选插件

```javascript
import exposure from '@tencent/autotracker-beacon-oa/dist/plugin/exposure'
import scroll from '@tencent/autotracker-beacon-oa/dist/plugin/scroll'

autoInstance.use(exposure, {
  autoSelector: ['#banner'],
  areaDelay: 1000,       // 有效曝光时长阈值(ms)
  areaThreshold: 0.5,    // 有效曝光面积比例(0-1)
  repeated: true,        // 重复曝光是否重复上报
  trackStayarea: false   // 是否采集区域停留时长
})

autoInstance.use(scroll, {
  scrollPageDelay: 4000  // 页面停留时长阈值(ms)
})

autoInstance.init()
```

### Router 插件参数

| 参数 | 类型 | 说明 |
|------|------|------|
| dynamicRoutes | Array | 动态路由规则，如 `["/user/:id"]` |
| getRouterExtraParams | Function | `(location) => object`，返回路由额外数据 |
| ignoreQuerys | Array | 忽略的 URL Query 参数 |

### Click 插件参数

| 参数 | 类型 | 说明 |
|------|------|------|
| autoSelector | Array/Function/null | 自动采集点击的元素选择器 |
| keyAttribute | String | 声明式点击属性名，默认 `dt-eid` |
| extraAttributes | Array | 需额外采集的元素属性 |
| shadowHostSelector | Array | Shadow DOM 宿主选择器 |

`autoSelector` 默认值：`['a', 'button', 'input', 'textarea']`，传入 Array 为追加，Function 为覆盖，null 为禁用。

---

## 公共参数

```javascript
// 初始化时设置
const autoInstance = new AutoTrackBeacon({
  report: {
    appkey: 'your_app_key',
    commonParams: {
      uid: 'user_rtx'
    }
  }
})

// 运行时追加
autoInstance.addAdditionalParams({
  platform: 'mobile',
  version: '1.0.0'
})
```

## 全局方法上报

在无法获取实例的场景，可使用全局方法：

```javascript
window.BeaconReport('at_click', {
  eid: 'editor-showhdimg',
  remark: JSON.stringify({ status: 'success' })
})
```

## SSR 适配

在 SSR 场景（如 Next.js）中，SDK 仅应在客户端环境初始化：

```javascript
import { useEffect } from 'react'

useEffect(() => {
  import('@tencent/autotracker-beacon-oa').then(({ default: AutoTrackBeacon }) => {
    const autoInstance = new AutoTrackBeacon({ /* 配置项 */ })
    autoInstance.init()
  })
}, [])
```

---

## 初始化参数

### report 配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| appkey | String | 必填 | DataHub AppKey |
| commonParams | Object | - | 全局公共参数（如 uid） |
| consolelog | Boolean | false | 控制台打印日志 |
| enableReport | Function | - | 上报开关控制函数 |
| beforeReport | Function | - | 上报前钩子：`(type, params, target) => newParams \| null` |
| onReportSuccess | Function | - | 上报成功回调 |
| onReportFail | Function | - | 上报失败回调 |
| maxStaytime | Number | 18000000 | 页面停留时间上限(ms) |
| reportImmediately | Boolean | true | 是否立即上报 |
| beaconParams | Object | - | 透传给底层 Beacon SDK 的参数 |

### 其他配置

| 参数 | 类型 | 说明 |
|------|------|------|
| uselib | Array | 组件库支持：`antd`、`element`、`tdesign`、`antdm` 等 |
| inspector | Object | 可视化圈选配置 |

**配置示例：**

```javascript
const autoInstance = new AutoTrackBeacon({
  report: {
    appkey: 'your_app_key',
    consolelog: true,
    commonParams: { uid: 'user_rtx' },
    beforeReport: (type, params, target) => {
      // 过滤不需要的事件
      if (type === 'at_scroll_page') return null
      return params
    }
  },
  uselib: ['antd']
})
```

---

## 可视化圈选

在初始化配置中启用 `inspector` 即可开启可视化埋点功能：

```javascript
const autoInstance = new AutoTrackBeacon({
  report: { appkey: 'your_app_key' },
  inspector: {
    chooseSelector: ['*']  // 允许圈选的元素范围，'*' 为任意元素
  }
})
```

开启后，在页面 URL 中添加 `?dt-inspector` 参数，页面右下角将出现可视化操作面板。

### 配置数据管理

可视化埋点配置托管在 Rainbow 平台，有三种加载方式：

1. **主动设置（推荐外网项目）**：自行拉取配置后调用 `autoInstance.setTrackConfig(config)`
2. **本地配置文件（短期项目）**：在面板中点击"下载"导出配置，硬编码到项目中
3. **自动拉取（内网项目）**：`*.woa.com` 域名项目自动生效，无需额外配置

---

## 实例方法速查

| 方法 | 说明 |
|------|------|
| `init()` | 初始化 SDK |
| `use(plugin, options)` | 加载插件 |
| `config(name, options)` | 配置插件 |
| `stop(name)` | 暂停插件 |
| `reStart(name)` | 重启插件 |
| `dtReport(code, params)` | 手动上报 |
| `addAdditionalParams(params)` | 追加公共参数 |
| `destroy()` | 销毁实例 |
| `setTrackConfig(config)` | 设置可视化埋点配置 |
| `getReportInstance()` | 获取底层 Beacon SDK 实例 |

---

## 调试验证

### 控制台日志

```javascript
const autoInstance = new AutoTrackBeacon({
  report: {
    appkey: 'your_app_key',
    consolelog: true  // 开启控制台日志
  }
})
```

### 工具面板验证

开启可视化圈选后，点击页面右下角大同图标，进入「验证模式」，操作页面后可实时查看采集到的事件。

### 网络请求调试

在浏览器 Network 面板中，过滤 `v2_upload` 关键词，查看请求 Payload 中的上报参数。

### 实时联调

进入 [灯塔数据质量中心](https://beacon.woa.com/datareporting/beacon/quality)，输入设备 ID（上报参数中的 `A2` 字段），即可实时查看接收到的数据。

---

## 常见上报参数

| 参数名 | 含义 | 示例 |
|--------|------|------|
| eid | 元素唯一标识 | `submit_btn` |
| remark | 自定义备注（JSON 字符串） | `{"status":"success"}` |
| staytime | 停留时间(ms) | `3000` |
| text | 元素文案 | `提交` |
| queryDom | CSS 选择器 | `.t-menu__item` |
| scrollY | 滚动条顶部距离 | `300` |
