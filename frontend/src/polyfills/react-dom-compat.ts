/**
 * React 19 兼容补丁 — findDOMNode / render / unmountComponentAtNode
 *
 * tea-component 和 react-transition-group 调用了 React 19 已移除的 API。
 *
 * ## 注入策略（三层防线）
 *
 * 1. **esbuild 插件**（vite.config.ts）— dev 模式预打包 react-dom 时注入
 * 2. **Vite transform 插件**（vite.config.ts）— dev 模式二次 optimize 时注入
 * 3. **此运行时文件**（main.tsx 第一行）— 兜底，覆盖 build 产物
 *
 * Rollup 生产构建会把 `import * as X` 的 namespace 冻结，所以不能直接
 * 赋值。这里通过 `Object.defineProperty` + `configurable: true` 尝试
 * 添加属性，如果 namespace 被彻底冻结则跳过（此时依赖 vite.config.ts
 * 里的 renderChunk 插件在构建产物层面注入）。
 */
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";

// ── polyfill 实现 ──

function findDOMNodeShim(componentOrElement: any): Element | Text | null {
  if (componentOrElement == null) return null;
  if (
    componentOrElement.nodeType === 1 ||
    componentOrElement.nodeType === 3
  ) {
    return componentOrElement;
  }
  const fiber =
    componentOrElement._reactInternals ||
    componentOrElement._reactInternalFiber;
  if (!fiber) return null;

  let node = fiber;
  while (node) {
    const sn = node.stateNode;
    if (sn && (sn.nodeType === 1 || sn.nodeType === 3)) return sn;
    if (node.child) {
      node = node.child;
      continue;
    }
    if (node === fiber) return null;
    while (node && !node.sibling) {
      if (!node.return || node.return === fiber) return null;
      node = node.return;
    }
    node = node?.sibling;
  }
  return null;
}

const rootMap = new Map<Element, ReturnType<typeof ReactDOMClient.createRoot>>();

function renderShim(
  element: React.ReactNode,
  container: Element,
  callback?: () => void,
) {
  let root = rootMap.get(container);
  if (!root) {
    root = ReactDOMClient.createRoot(container);
    rootMap.set(container, root);
  }
  root.render(element);
  if (typeof callback === "function") setTimeout(callback, 0);
}

function unmountShim(container: Element): boolean {
  const root = rootMap.get(container);
  if (root) {
    root.unmount();
    rootMap.delete(container);
    return true;
  }
  return false;
}

// ── 安全注入（兼容冻结的 ESM namespace） ──

function safePatch(target: any, name: string, impl: Function) {
  if (typeof target[name] === "function") return; // 已存在，跳过
  try {
    // 先尝试直接赋值（dev 模式下 CJS exports 可写）
    target[name] = impl;
  } catch {
    try {
      // 赋值失败（namespace 被冻结），尝试 defineProperty
      Object.defineProperty(target, name, {
        value: impl,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } catch {
      // 彻底冻结（Object.freeze），运行时无法 patch
      // 依赖 vite.config.ts 的 renderChunk 插件在构建产物层面注入
    }
  }
}

safePatch(ReactDOM, "findDOMNode", findDOMNodeShim);
safePatch(ReactDOM, "render", renderShim);
safePatch(ReactDOM, "unmountComponentAtNode", unmountShim);
