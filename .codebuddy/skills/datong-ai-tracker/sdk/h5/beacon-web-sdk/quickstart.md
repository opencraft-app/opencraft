# 轻量版 SDK（beacon-web-sdk）快速开始

## 安装与初始化

### 方式一：NPM（推荐）

```bash
tnpm install @tencent/beacon-web-sdk@latest --save
```

```javascript
import BeaconAction from '@tencent/beacon-web-sdk'

const beacon = new BeaconAction({
  appkey: 'your_app_key'  // 在 https://datong.woa.com/#/home 获取
})
```

### 方式二：CDN

```html
<script src="//beacon.cdn.qq.com/sdk/4.7.6/beacon_web.min.js"></script>

<script>
const beacon = new BeaconAction({
  appkey: 'your_app_key'  // 在 https://datong.woa.com/#/home 获取
})
</script>
```

## 上报事件

### 普通上报（推荐）

SDK 自动聚合后批量发送，性能最优。**绝大多数场景使用此方法。**

```javascript
beacon.onUserAction('eventCode', {
  key1: 'value1',
  key2: 'value2'
})
```

### 实时上报

调用后立即上报，不经过聚合。仅在有时效性要求时使用。

```javascript
beacon.onDirectUserAction('eventCode', {
  key1: 'value1'
})
```

> **就这么简单！** 三步即可完成埋点上报：安装 → 初始化 → 调用 `onUserAction`

---

## 参数要求

- `eventCode`：必须是 **string** 类型，**不支持中文**
- params 的 key 和 value：只支持 **string** 类型
- 非 string/number 值需先转换：`String(value)`
