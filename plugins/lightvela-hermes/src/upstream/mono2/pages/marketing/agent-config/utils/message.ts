// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * 轻量级 message 提示 — 替代 tea-component message（React 19 兼容）
 *
 * tea-component 的 message.success/error 内部使用 ReactDOM.render，
 * 在 React 19 + Vite 环境下会触发 race condition。
 * 本模块用纯 DOM 实现，无 React 依赖。
 *
 * API 与 tea-component message 保持一致：
 *   showMessage.success({ content: '操作成功' })
 *   showMessage.error({ content: '操作失败' })
 */

interface MessageOptions {
  content: string;
  duration?: number;
}

const CONTAINER_ID = '_lh-message-container';

/** 当前显示的 message 元素和退场定时器 */
let currentEl: HTMLElement | null = null;
let currentTimer: ReturnType<typeof setTimeout> | null = null;

function getContainer(): HTMLElement {
  let container = document.getElementById(CONTAINER_ID);
  if (!container) {
    container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.style.cssText =
      'position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:10010;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;';
    document.body.appendChild(container);
  }
  return container;
}

/** 立即移除当前 message */
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

function show(type: 'success' | 'error', options: MessageOptions) {
  const { content, duration = 3000 } = options;

  // 先清除上一条
  dismissCurrent();

  const container = getContainer();

  const el = document.createElement('div');
  el.style.cssText =
    'display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border-radius:4px;font-size:12px;line-height:20px;color:rgba(0,0,0,0.9);background:#fff;box-shadow:0 4px 12px rgba(0,0,0,0.12);pointer-events:auto;opacity:0;transition:opacity 0.2s ease,transform 0.2s ease;transform:translateY(-8px);';

  // 图标
  const icon = document.createElement('span');
  icon.style.cssText =
    'width:16px;height:16px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;';
  if (type === 'success') {
    icon.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" fill="#088f50"/><path d="M5 8l2 2 4-4" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  } else {
    icon.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" fill="#eb1c26"/><path d="M8 5v3.5M8 10.5v.5" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>';
  }

  const text = document.createElement('span');
  text.textContent = content;

  el.appendChild(icon);
  el.appendChild(text);
  container.appendChild(el);
  currentEl = el;

  // 入场动画
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  });

  // 退场
  currentTimer = setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(-8px)';
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
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export const message = {
  success: (options: MessageOptions) => show('success', options),
  error: (options: MessageOptions) => show('error', options),
  warning: (options: MessageOptions) => show('error', options),
  info: (options: MessageOptions) => show('success', options),
};
