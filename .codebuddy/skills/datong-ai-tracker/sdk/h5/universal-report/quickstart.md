# 标准版 SDK（universal-report）快速开始

## 安装与初始化

### 方式一：NPM（推荐）

```bash
tnpm install @tencent/universal-report@latest --save
```

```javascript
import UniversalReport from '@tencent/universal-report'

const reporter = new UniversalReport({
  beacon: 'your_app_key',  // 在 https://datong.woa.com/#/home 获取
  enableNoCodeTracking: false,  // 是否开启无代码埋点
})
```

### 方式二：CDN

```html
<script src="//staticfile.qq.com/datong/universalReportH5/{{lastVersion}}/universal-report.min.js"></script>

<script>
const reporter = new window.UniversalReport({
  beacon: 'your_app_key',  // 在 https://datong.woa.com/#/home 获取
})
</script>
```

## 上报事件

### 方式一：声明式埋点（默认使用）

在 HTML 元素上添加 `dt-` 属性，SDK 会自动检测并上报，无需编写 JS 代码。

**页面埋点：**

```html
<div dt-pgid="home" dt-params="tab=1">
  <!-- 页面内容 -->
</div>
```

SDK 自动上报页面曝光（dt_pgin）和页面结束曝光（dt_pgout）事件。 另外dt-params则是标记页面私参， 可根据业务代码上下文完善， 遵循kv格式（eg: a=1&b=2），亦或不标记，具体看业务需求

**元素埋点：**

```html
<div dt-eid="banner" dt-params="pos=1">
  <!-- 元素内容 -->
</div>
```

SDK 自动上报元素曝光（dt_imp）、点击（dt_clck）和退出（dt_imp_end）事件。另外dt-params则是标记元素私参， 可根据业务代码上下文完善， 遵循kv格式（eg: a=1&b=2），亦或不标记，具体看业务需求
重点注意：确保标记dt-eid的元素节点要是属于某个标记dt-pgid 页面节点下， 实际项目，可能要通过推断元素所在的代码组件与其父组件或祖父组件的关系，去推断是否有在页面节点下！！！

**vue/react 组件埋点**
``` vue
<component dt-eid="banner" dt-params="pos=1">
```
注意：不要去修改组件绑定click方法, 因为组件属性在渲染时会绑定html上，所以声明式就实现sdk采集dt_clck事件


### 方式二：手动上报 

通过 JS 代码主动调用上报方法，适合自定义事件场景。
重点注意：此方法应在用户明确时使用，默认使用声明式埋点

```javascript
reporter.reportEvent({
  eventName: 'click_search',  // 事件名称
  pgid: 'home',               // 页面 ID
  businessParams: {
    keyword: '搜索词',
    eid: 'search_btn'
  }
})
```

> **就这么简单！** 三步即可完成埋点上报：安装 → 初始化 → 上报事件（标签或手动）

---

## 标准事件说明

| 事件 | event_code | 触发时机 |
|------|------------|----------|
| 页面曝光 | dt_pgin | 页面进入可视区域 |
| 页面结束曝光 | dt_pgout | 页面离开可视区域 |
| 元素曝光 | dt_imp | 元素进入可视区域 |
| 元素点击 | dt_clck | 元素被点击 |
| 元素退出 | dt_imp_end | 元素离开可视区域 |
