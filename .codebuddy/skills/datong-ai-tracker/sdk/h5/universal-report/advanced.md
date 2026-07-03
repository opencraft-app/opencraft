# 标准版 SDK（universal-report）高级功能

## 手动控制页面埋点

如需精确控制上报时机：

```javascript
// 设置页面信息
reporter.setPage({
  pgid: 'home',
  tab: 1
}, document.body)

// 手动上报页面曝光
reporter.reportPV('home')

// 手动上报页面结束曝光
reporter.reportPgOut('home', true)
```

## 手动控制元素埋点

```javascript
reporter.reportElement(document.querySelector('.item'), {
  pgid: 'home',
  eventName: 'dt_imp',  // dt_imp, dt_clck, dt_imp_end
  businessParams: {
    eid: 'item',
    item_idx: 0
  }
})
```

## 设置用户信息

```javascript
// 初始化时设置
const reporter = new UniversalReport({
  beacon: 'your_app_key',
  accountInfo: {
    dt_qq: 'qq_number',
    dt_wxopenid: 'wx_openid',
    dt_mainlogin: 'wx'
  }
})

// 运行时动态设置
reporter.setAccountInfo({
  dt_qq: 'qq_number',
  dt_wxopenid: 'wx_openid'
})

// 清空账号信息（用户登出时）
reporter.clearAccountInfo()
```

## 设置公共参数

```javascript
// 设置
reporter.setPublicParams({
  platform: 'mobile',
  version: '1.0.0'
})

// 获取
reporter.getPublicParams('platform')

// 删除
reporter.removePublicParams('platform')
```

---

## 初始化参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| beacon | string | 必填 | 灯塔 APPKEY |
| accountInfo | object | - | 用户账号信息 |
| publicParams | object | {} | 自定义公共参数 |
| version | string | - | 业务版本号 |
| log | number | 0 | 日志级别：0/1/2 |
| isDisableObserver | boolean | false | 禁用自动检测 |
| beforeReport | function | - | 上报前钩子 |
| channel | string | 'app' | 上报通道 |

**配置示例：**

```javascript
const reporter = new UniversalReport({
  beacon: 'your_app_key',
  version: '1.0.0',
  log: 1,  // 开启日志
  publicParams: {
    platform: 'mobile'
  },
  beforeReport: (context) => {
    // 过滤元素结束曝光事件
    return context.eventName !== 'dt_imp_end'
  }
})
```

## 标记属性控制

### 延迟上报

```html
<div dt-eid="item" dt-cmd="hold=true" dt-params="id=1">
  <!-- 内容加载中，暂不上报 -->
</div>
```

数据加载完成后：

```javascript
reporter.setCommand(element, { hold: false })
```

### 忽略上报

```html
<!-- 忽略页面曝光 -->
<div dt-pgid="home" dt-pg-ignore="true"></div>

<!-- 忽略元素曝光，只上报点击 -->
<div dt-eid="item" dt-imp-ignore="true"></div>

<!-- 只曝光一次 -->
<div dt-eid="item" dt-imp-once="true"></div>
```

## sendBeacon 立即上报

适用于页面跳转前必须完成的上报：

```javascript
reporter.reportEvent({
  eventName: 'page_leave',
  pgid: 'home',
  businessParams: { duration: 120 },
  isSendBeacon: true  // 使用 sendBeacon 立即发送
})
```

> **⚠️ 注意**  
> iOS 手 Q 内 webview 不支持 sendBeacon，有手 Q 场景请勿使用。

## 自定义上报通道

```javascript
const reporter = new UniversalReport({
  beacon: 'your_app_key',
  channel: {
    init() {
      // 初始化自定义通道
    },
    report(context) {
      // 自定义上报逻辑
      fetch('/api/report', {
        method: 'POST',
        body: JSON.stringify(context)
      })
    }
  },
  extraDefaultChannel: 'app'  // 同时保留默认通道
})
```

## 多实例场景

**方式 1：指定 root 节点**

```javascript
const reporter1 = new UniversalReport({
  beacon: 'appkey1',
  root: document.getElementById('app1')
})

const reporter2 = new UniversalReport({
  beacon: 'appkey2',
  root: document.getElementById('app2')
})
```

**方式 2：页面过滤**

```javascript
const reporter1 = new UniversalReport({
  beacon: 'appkey1',
  excludePages: ['page_a']  // 排除特定页面
})

const reporter2 = new UniversalReport({
  beacon: 'appkey2',
  includePages: ['page_a']  // 只处理特定页面
})
```

## 过滤和抽样

使用 `beforeReport` 钩子实现：

```javascript
const reporter = new UniversalReport({
  beacon: 'your_app_key',
  beforeReport: (context) => {
    // 过滤：屏蔽元素结束曝光事件
    if (context.eventName === 'dt_imp_end') {
      return false
    }
    
    // 抽样：只上报 10% 的曝光事件
    if (context.eventName === 'dt_imp' && Math.random() > 0.1) {
      return false
    }
    
    // 调试：打印特定事件
    if (context.eventName === 'my_event') {
      console.log('上报数据：', context)
    }
    
    return true  // 允许上报
  }
})
```

---

## 调试工具

### 开启日志

```javascript
const reporter = new UniversalReport({
  beacon: 'your_app_key',
  log: 1  // 0-关闭 1-基础日志 2-详细日志
})
```

### 可视化联调

SDK 支持可视化联调功能，可在大同平台实时查看上报数据和埋点状态。

---

## 常见问题

### 如何确认 SDK 正常工作？

1. 开启日志模式：`log: 1`
2. 打开浏览器控制台查看上报日志
3. 使用大同平台的可视化联调功能

### 参数类型有什么要求？

- `eventName`：必须是 **string** 类型
- `pgid`：必须是 **string** 类型
- `businessParams`：支持 string、number、boolean 等，**无需强制转为 string**

### 自动上报和手动上报如何选择？

- **自动上报（推荐）**：适合标准页面和元素埋点，简单快捷
- **手动上报**：需要精确控制上报时机，或上报自定义事件

可以混合使用：标准埋点用自动，特殊场景用手动。

### 如何禁用自动检测？

```javascript
const reporter = new UniversalReport({
  beacon: 'your_app_key',
  isDisableObserver: true  // 禁用自动检测，全部手动上报
})
```
