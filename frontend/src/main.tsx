// ⚠️ 必须第一行引入：React 19 兼容补丁（findDOMNode / render / unmountComponentAtNode）
// tea-component 在模块初始化时就会调用这些已移除的 API，必须在任何
// tea-component 代码执行前完成 monkey-patch。
import "@/polyfills/react-dom-compat";
import "@/observability/aegis-bootstrap";

import { mountApp } from "@/app/mount";
import "@/i18n";
import "@/styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

mountApp(rootElement);
