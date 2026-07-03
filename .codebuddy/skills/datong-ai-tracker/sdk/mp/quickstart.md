# 小程序 SDK（universal-report-mp）快速开始

## 安装与初始化

### NPM 安装

```bash
npm install @tencent/universal-report-mp@latest --save
```

### 初始化（在 `new App()` 之前执行）

**【重要】必须在小程序 `App` 实例化之前完成 SDK 初始化，否则自动采集无法生效。**

```javascript
import UniversalReport from '@tencent/universal-report-mp';  // 如果项目使用老的 commonjs规范，则是 const UniversalReport = require('@tencent/universal-report-mp')

// 实例建议挂载到全局对象上，以便在自定义组件中也可以访问，如 wx.universalReport / Taro.universalReport / qq.universalReport / tt.universalReport 等
const universalReport = new UniversalReport({
  beacon: 'XXXXX',              // 必填，小程序 appKey，从灯塔官网获取
  system: wx,                   // 必填，小程序环境对象：
                                //   - 原生微信小程序：wx
                                //   - Taro 框架：Taro（不是 wx）
                                //   - QQ 小程序：qq
                                //   - 抖音小程序：tt
  pageSelector: '.dt-pg',       // 必填，页面元素的 class 选择器，建议为 .dt-pg
  exposeSelector: '.dt-el',     // 必填，元素曝光的 class 选择器，建议为 .dt-el
  autoReport: true,             // 必填，启动自动采集上报
  publicParams: { },        // 选填，业务公共参数
})
```


## 原生小程序

### 1. SDK 初始化

```javascript
// app.js, 在App实例运行前初始化sdk
const UniversalReport = require('@tencent/universal-report-mp')

// 【关键】App 实例化之前初始化 SDK
wx.universalReport = new UniversalReport({
  beacon: 'your_app_key',
  system: wx,
  pageSelector: '.dt-pg',
  exposeSelector: '.dt-el',
  autoReport: true,
  publicParams: {
    platform: 'mp',
    version: '1.0.0',
  },
})

// App 入口
App({
   ... 
})

```

### 2. 声明式埋点（默认方式）

**页面埋点**

```xml
<!-- page/login/login.wxml -->
<view class="dt-pg" data-dt-pgid="pg_login">
  <!-- 页面内容 -->
</view>
```
-  class 增加 `dt-pg` class， 这里与初始化配置 `pageSelector: '.dt-pg'` 保持一致
- `data-dt-pgid`：页面标识，对应埋点方案中的 `dt_pgid`

那么SDK 则自动采集并上报：
- `dt_pgin`：页面曝光事件（进入可视区域）
- `dt_pgout`：页面结束曝光事件（离开可视区域）

非常重要： 页面节点只小程序pages目录下， 每个页面一个pgid， 不支持页面page页面，多个pgid



**元素埋点**

```xml
<view class="dt-el" data-dt-eid="btn_login_wx" data-dt-params="source=homepage&channel=1">
  微信登录
</view>
```
-  class 增加 `dt-el` class， 这里与初始化配置 `exposeSelector: '.dt-el'` 保持一致
- `data-dt-eid`：元素标识，对应埋点方案中的 `dt_eid`
- `data-dt-params={key=value}`：元素私参, 支持多个参数：`data-dt-params="a=1&b=2"`

那么SDK 则会自动采集并上报：
- `dt_imp`：元素曝光事件（进入可视区域）
- `dt_clck`：元素点击事件
- `dt_imp_end`：元素结束曝光事件（离开可视区域）



### 3. 手动上报 （需要用户主动提及才干）

需要精确控制上报时机或上报自定义事件时使用。

```javascript
// 页面内通过 getApp() 或 wx.universalReport 访问
const reporter = wx.universalReport

reporter.reportEvent({
  eventName: 'custom_submit',   // 事件名称
  pgid: 'pg_login',             // 页面 ID
  businessParams: {
    eid: 'submit_btn',
    form_id: 'login_form',
  },
})
```



## Taro 框架小程序

### 1. SDK 初始化

**关键：`system` 参数必须传入 `Taro`，而不是 `wx`**

```javascript
// app.js（Taro 项目）
import Taro from '@tarojs/taro'
import UniversalReport from '@tencent/universal-report-mp'

// 【关键】system 传入 Taro，不是 wx
Taro.universalReport = new UniversalReport({
  beacon: 'your_app_key',
  system: Taro,                   // ⚠️ 必须传入 Taro
  pageSelector: '.dt-pg',
  exposeSelector: '.dt-el',
  autoReport: true,
  publicParams: {
    platform: 'taro',
    version: '1.0.0',
  },
})

// Taro 3.x App 入口
const App = createApp({})
export default App
```


### 2. Taro 框架构建配置插件

Taro 编译时会过滤掉未声明的自定义属性（如 `data-dt-pgid`），需要通过插件注入。

#### Taro 3.x

**安装插件：**

```bash
npm install @tarojs/plugin-inject --save-dev
```

**配置 `config/index.js`：**

```javascript
export default {
  // ...
  plugins: [
    [
      '@tarojs/plugin-inject',
      {
        components: {
          View: {
            'data-dt-pgid': '',
            'data-dt-eid': '',
            'data-dt-params': '',
          },
        },
      },
    ],
  ],
}
```

#### Taro 4.x

```bash
npm install @tencent/dt_taro4_inject_plugin --save-dev
```

**配置 `config/index.ts`：**

如果项目的是webpack构建，那么参考如下
```typescript
import  { DtWebpackPlugin } from '@tencent/dt_taro4_inject_plugin'

export default {
  // ...其他配置
  plugins: [
    DtWebpackPlugin, // 增加DtWebpackPlugin
  ]
  
}
```

如果项目的是vite构建，那么参考如下
```typescript
import  { DtVitePlugin } from '@tencent/dt_taro4_inject_plugin'

export default {
  // ...
  mini: {
    webpackChain(/* 不用这里 */) {},
    vitePlugins: [
        DtVitePlugin(), // 增加DtVitePlugin
    ],
  },
}
```

> ⚠️ **不配置插件的后果**：Taro 编译后会丢失 `data-dt-pgid` / `data-dt-eid` 等自定义属性，导致 SDK 自动采集无法识别埋点元素。

### 3. Taro 框架组件中的声明式埋点

**taro3 框架的埋点方式（主要要用驼峰方式）：**
```jsx
// Taro3 组件
export default function LoginPage() {
  return (
    <View className="dt-pg" dataDtPgid="pg_login" dataDtParams='a=1&b=2'>
      <View className="dt-el" dataDtEid="btn_login_wx" dataDtParams='c=3&d=4'>
        微信登录
      </View>
    </View>
  )
}
```
-  页面节点 class 增加 `dt-pg` class， 这里与初始化配置 `pageSelector: '.dt-pg'` 保持一致
-  元素节点 class 增加 `dt-el` class， 这里与初始化配置 `exposeSelector: '.dt-el'` 保持一致
- `dataDtPgid`：页面标识，对应埋点方案中的 `dt_pgid`
- `dataDtEid`：元素标识，对应埋点方案中的 `dt_eid`
- `dataDtParams`：节点（页面or元素）私参, 支持多个参数：`dataDtParams="a=1&b=2"`


**taro4 框架的埋点方式（注意非驼峰，且无需data-开头）：**
```jsx
// Taro4 组件
export default function LoginPage() {
  return (
    <View className="dt-pg" dt-pgid="pg_login" dt-params='a=1&b=2'>
      <View className="dt-el" dt-eid="btn_login_wx" dt-params='c=3&d=4'>
        微信登录
      </View>
    </View>
  )
}
```
-  页面节点 class 增加 `dt-pg` class， 这里与初始化配置 `pageSelector: '.dt-pg'` 保持一致
-  元素节点 class 增加 `dt-el` class， 这里与初始化配置 `exposeSelector: '.dt-el'` 保持一致
- `dt-pgid`：页面标识，对应埋点方案中的 `dt_pgid`
- `dt-eid`：元素标识，对应埋点方案中的 `dt_eid`
- `dt-params`：节点（页面or元素）私参, 支持多个参数：`dt-params="a=1&b=2"`


### taro 框架手动上报 （需要用户主动提及才干）

需要精确控制上报时机或上报自定义事件时使用。

```javascript
// 页面内通过 getApp() 或 wx.universalReport 访问
const reporter = wx.universalReport

reporter.reportEvent({
  eventName: 'custom_submit',   // 事件名称
  pgid: 'pg_login',             // 页面 ID
  businessParams: {
    eid: 'submit_btn',
    form_id: 'login_form',
  },
})
```

---

## SDK自动采集事件说明

| 事件 | event_code | 触发时机 |
|------|------------|----------|
| 页面曝光 | dt_pgin | 页面进入可视区域 |
| 页面结束曝光 | dt_pgout | 页面离开可视区域 |
| 元素曝光 | dt_imp | 元素进入可视区域 |
| 元素点击 | dt_clck | 元素被点击 |
| 元素结束曝光 | dt_imp_end | 元素离开可视区域 |

---

## 整体关键约束

1. **初始化时机**：必须在 `new App()` 之前执行，否则自动采集不生效
2. **system 参数**：
   - 原生微信小程序传 `wx`
   - Taro 框架传 `Taro`（⚠️ 不是 `wx`）
   - QQ 小程序传 `qq`
   - 抖音小程序传 `tt`
3. **class 选择器**：`pageSelector` 和 `exposeSelector` 必须与 WXML 中实际使用的 class 一致
4. **data 属性**：声明式埋点使用 `data-dt-pgid` 和 `data-dt-eid`，不是 HTML 的 `dt-pgid` 属性
