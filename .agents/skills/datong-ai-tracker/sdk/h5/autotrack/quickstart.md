# 无埋点版 SDK（autotracker）快速开始

## 安装与初始化

### 方式一：NPM（推荐）

```bash
npm i @tencent/autotracker-beacon-oa@latest
```

```javascript
import AutoTrackBeacon from '@tencent/autotracker-beacon-oa'

const autoInstance = new AutoTrackBeacon({
  report: {
    appkey: 'your_app_key'  // 在 https://datong.woa.com/#/lite 获取
  }
})

autoInstance.init()
```

### 方式二：CDN

```html
<script src="//beacon.cdn.qq.com/auto_tracker/js/autotracker-beacon-oa-${version}.min.js"></script>

<script>
const autoInstance = new AutoTrackBeacon({
  report: {
    appkey: 'your_app_key'
  }
})

autoInstance.init()
</script>
```

> **注意**：初始化后必须显式调用 `autoInstance.init()` 才会开始采集。

## 上报方式

### 方式一：自动采集（推荐）

SDK 默认自动采集页面浏览和点击事件，零代码。通过 `uselib` 配置组件库可增强识别能力：

```javascript
const autoInstance = new AutoTrackBeacon({
  report: { appkey: 'your_app_key' },
  uselib: ['antd']  // 支持：antd、element、tdesign、antdm
})

autoInstance.init()
```

SDK 会自动识别并上报组件库元素的点击、曝光等行为。

### 方式二：声明式埋点

在 HTML 元素上添加 `dt-` 属性，SDK 自动识别并上报，适合需要携带业务参数的场景。

**点击埋点：**

```html
<a dt-eid="comment-btn" dt-remark='{"adId": 101, "type": "banner"}'>
  点击查看详情
</a>
```

**区域曝光埋点：**

```html
<div dt-areaid="activity-popup" dt-remark='{"campaignId": 2024}'>
  <!-- 区域内容 -->
</div>
```

### 方式三：手动上报

通过 JS 代码主动调用，适合异步操作、复杂业务逻辑等无法绑定 DOM 的场景。

```javascript
autoInstance.dtReport('at_click', {
  eid: 'submit_btn',
  remark: JSON.stringify({ status: 'success' })
})
```

> **就这么简单！** 安装 → 初始化 → 自动采集即刻生效，声明式和手动上报按需补充。

---

## 标准事件说明

| 事件代码 | 事件含义 | 触发时机 |
|----------|----------|----------|
| at_imp | 页面曝光 | 页面加载完成并展示 |
| at_stay_page | 页面停留 | 用户离开页面时，记录停留时长 |
| at_click | 元素点击 | 用户点击被监测元素 |
| at_show_area | 区域曝光 | 被监测区域进入视口 |
| at_stay_area | 区域停留 | 被监测区域离开视口，记录停留时长 |
| at_scroll_page | 视区停留 | 页面滚动停止，记录滚动位置 |
