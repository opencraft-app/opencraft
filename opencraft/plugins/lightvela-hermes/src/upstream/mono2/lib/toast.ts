// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * 轻量 toast 提示 —— 顶部居中、3s 自动消失。
 *
 * 风格与 `@tencent/tea-sdk-lightclaw` 内部的 `common/utils/message` 一致
 * （SDK 在"接入通道 / 断开连接"等场景里用的就是它），
 * 这样跨我们自己的页面 + SDK 面板的反馈视觉是统一的。
 *
 * 用纯 DOM 实现而不是 React portal，是为了：
 *  1. 不受任何 React 生命周期影响（成功后哪怕组件立刻 unmount，toast 也照样跑完）
 *  2. 跟 SDK 的 toast 共享容器；同时出现时按触发顺序纵向排列
 *  3. React 19 + ReactDOM.render 在某些组合下的 race condition 不会触发
 *
 * API：
 *   toast.success("重置成功")
 *   toast.error("重置失败，请重试")
 */

// SDK message 使用同一容器 ID；复用后两类提示会按容器的 column + gap 布局排列。
const CONTAINER_ID = "_lh-message-container";
const DEFAULT_DURATION_MS = 3000;

let currentEl: HTMLElement | null = null;
let currentTimer: ReturnType<typeof setTimeout> | null = null;

const TOAST_TYPE = {
  SUCCESS: "success",
  ERROR: "error",
} as const;

type ToastType = (typeof TOAST_TYPE)[keyof typeof TOAST_TYPE];

const SUCCESS_ICON_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none">' +
  '<circle cx="8" cy="8" r="7" fill="var(--tea-color-text-success-default, #088f50)"/>' +
  '<path d="M5 8l2 2 4-4" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
  "</svg>";

const ERROR_ICON_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none">' +
  '<circle cx="8" cy="8" r="7" fill="var(--tea-color-text-error-default, #eb1c26)"/>' +
  '<path d="M8 5v3.5M8 10.5v.5" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>' +
  "</svg>";

function getContainer(): HTMLDivElement {
  let container = document.getElementById(CONTAINER_ID) as HTMLDivElement | null;
  if (!container) {
    container = document.createElement("div");
    container.id = CONTAINER_ID;
    /* z-index 略高于 settings page 的 modal（z-200），保证 toast 始终在最上 */
    container.style.cssText =
      "position:fixed;top:24px;left:50%;transform:translateX(-50%);" +
      "z-index:10010;display:flex;flex-direction:column;align-items:center;" +
      "gap:8px;pointer-events:none;";
    document.body.appendChild(container);
  }
  return container;
}

function dismissCurrent() {
  if (currentTimer) {
    clearTimeout(currentTimer);
    currentTimer = null;
  }
  if (currentEl) {
    currentEl.remove();
    currentEl = null;
  }
}

function show(type: ToastType, content: string, duration = DEFAULT_DURATION_MS) {
  if (typeof document === "undefined") return () => {}; // SSR / node 单测兜底

  dismissCurrent();

  const container = getContainer();
  const el = document.createElement("div");
  el.style.cssText =
    "display:inline-flex;align-items:center;gap:8px;padding:8px 16px;" +
    "border-radius:4px;font-size:12px;line-height:20px;color:rgba(0,0,0,0.9);" +
    "background:#fff;box-shadow:0 4px 12px rgba(0,0,0,0.12);" +
    "pointer-events:auto;opacity:0;transition:opacity 0.2s ease,transform 0.2s ease;" +
    "transform:translateY(-8px);";

  const icon = document.createElement("span");
  icon.style.cssText =
    "width:16px;height:16px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;";
  icon.innerHTML = type === TOAST_TYPE.SUCCESS ? SUCCESS_ICON_SVG : ERROR_ICON_SVG;

  const text = document.createElement("span");
  text.textContent = content;

  el.appendChild(icon);
  el.appendChild(text);
  container.appendChild(el);
  currentEl = el;

  requestAnimationFrame(() => {
    el.style.opacity = "1";
    el.style.transform = "translateY(0)";
  });

  currentTimer = setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(-8px)";
    setTimeout(() => {
      if (currentEl === el) {
        currentEl = null;
        currentTimer = null;
      }
      el.remove();
      if (container.children.length === 0) {
        container.remove();
      }
    }, 200);
  }, duration);

  // 调用方只能关闭自己的提示，避免组件卸载时误清理其他操作的反馈。
  return () => {
    if (currentEl !== el) return;
    dismissCurrent();
    if (container.children.length === 0) container.remove();
  };
}

export const toast = {
  success: (content: string, duration?: number) => show(TOAST_TYPE.SUCCESS, content, duration),
  error: (content: string, duration?: number) => show(TOAST_TYPE.ERROR, content, duration),
};
