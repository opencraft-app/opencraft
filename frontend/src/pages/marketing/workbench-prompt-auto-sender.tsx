import { useEffect } from "react";

// 过渡方案：自动发送借用 @tencent/agentchat-claw-panel 的 useClawSender 单例写入
// 输入框并触发发送。后续应由 @tencent/agentchat-lightvela-panel 原生提供该能力。
import { useClawSender } from "@tencent/agentchat-claw-panel";

import { DATONG_EVENTS, DATONG_PAGE_IDS } from "@/observability/datong";
import { trackDatongEvent } from "@/observability/datong-tracker";

import {
  clearPendingWorkbenchPrompt,
  readPendingWorkbenchPrompt,
  withSharedTechStack,
  type WorkbenchTemplateId,
} from "./workbench-prompt-templates";

/**
 * 工作台模板 → 对话自动发送桥接。
 *
 * 读取工作台卡片写入 sessionStorage 的 pending prompt，在 LightVelaPanel 挂载后
 * 自动「填入输入框 → 发送」，随后清除 pending。
 *
 * 两个关键时序处理：
 * - 面板挂载 + grace period：等 textarea 出现后固定等 1500ms，让 SDK 走完骨架屏
 *   初始化，避免"上面 loading 下面已填好"。
 * - socket 就绪判定：按钮在 socket 未连时会乐观 enable，直接 click 消息只进乐观
 *   态、socket 连上后被冲掉（「刷新一下纪录没了」）。click 前拦截 console.warn，
 *   捕获 "Socket not connected" 则作废重试，未捕获则视为已连。
 */

const SUBMIT_BUTTON_SELECTOR = 'button[data-eid="send-submit"]';
/** 轮询间隔 */
const POLL_INTERVAL_MS = 150;
/** 最长等待窗口：覆盖懒加载 + 建连 + agent 冷启动（按钮可 disabled 数十秒） */
const MAX_WAIT_MS = 60000;
/** 面板挂载后的 grace period，等 SDK 骨架屏初始化完成再 fill+send */
const PANEL_MOUNT_GRACE_MS = 1500;
/** click 后等待判定 socket 是否未连的窗口（SDK 同步打印告警，100ms 足够） */
const SEND_RESULT_WAIT_MS = 100;
/** socket 未连重试间隔 */
const SOCKET_RETRY_DELAY_MS = 50;
/** SDK socket 未连时打印的告警文本片段 */
const SOCKET_NOT_CONNECTED_WARN = "Socket not connected";

/**
 * 模块级运行守卫：同一条 pending 只启动一次轮询，跨 StrictMode 双挂载存活。
 *
 * 若放组件内并在 cleanup 里取消，StrictMode 第一次挂载启动的轮询会被立刻杀掉，
 * 第二次挂载又因守卫已置位跳过 → 轮询只跑一次就死。sender 异步挂载，必须让轮询
 * 跨双挂载持续存活直到发送成功或超时。
 */
let autoSendRunning = false;

function trackAutoSend(templateId: WorkbenchTemplateId, status: "sent" | "timeout") {
  try {
    trackDatongEvent(DATONG_EVENTS.AGENT_MESSAGE_SEND, {
      pgid: DATONG_PAGE_IDS.AGENT_CHAT,
      params: {
        source: "workbench_template",
        template_id: templateId,
        auto_send_status: status,
      },
    });
  } catch {
    // 埋点失败不影响主流程。
  }
}

/** 临时拦截 console.warn，捕获含 marker 的告警；返回 restore 函数恢复原 warn。 */
function interceptWarn(marker: string, onMatch: () => void): () => void {
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (args.some((a) => typeof a === "string" && a.includes(marker))) {
      onMatch();
    }
    Reflect.apply(originalWarn, console, args);
  };
  return () => {
    console.warn = originalWarn;
  };
}

export function WorkbenchPromptAutoSender() {
  const { setClawSenderInput } = useClawSender();

  useEffect(() => {
    if (autoSendRunning) return;
    const pending = readPendingWorkbenchPrompt();
    if (!pending) return;
    autoSendRunning = true;
    clearPendingWorkbenchPrompt();

    const { prompt, templateId } = pending;
    const finalPrompt = withSharedTechStack(prompt);
    const startedAt = Date.now();
    // 文本填入后不再持续覆盖，避免覆盖用户等待期的手动编辑；socket 未连重试时重置。
    let inputFilled = false;
    // 面板挂载时刻（textarea 首次出现）。null = 尚未挂载。
    let panelMountedAt: number | null = null;

    const finishTimeout = () => {
      trackAutoSend(templateId, "timeout");
      autoSendRunning = false;
    };

    const attempt = () => {
      if (Date.now() - startedAt >= MAX_WAIT_MS) {
        finishTimeout();
        return;
      }

      const textareas = document.querySelectorAll<HTMLTextAreaElement>("textarea");

      // 阶段 1：等面板挂载（textarea 出现），记录时刻进入 grace period。
      if (panelMountedAt === null) {
        if (textareas.length > 0) {
          panelMountedAt = Date.now();
        }
        setTimeout(attempt, POLL_INTERVAL_MS);
        return;
      }

      // 阶段 2：等 grace period 让 SDK 走完骨架屏初始化。
      if (Date.now() - panelMountedAt < PANEL_MOUNT_GRACE_MS) {
        setTimeout(attempt, POLL_INTERVAL_MS);
        return;
      }

      // 阶段 3：grace 过后，fill + send。
      if (!inputFilled) {
        setClawSenderInput(finalPrompt);
        if (textareas.length > 0 && Array.from(textareas).some((t) => t.value.length > 0)) {
          inputFilled = true;
        }
      }

      const button =
        Array.from(
          document.querySelectorAll<HTMLButtonElement>(SUBMIT_BUTTON_SELECTOR),
        ).find((b) => !b.disabled) ?? null;

      if (!button) {
        if (Date.now() - startedAt >= MAX_WAIT_MS) {
          finishTimeout();
          return;
        }
        setTimeout(attempt, POLL_INTERVAL_MS);
        return;
      }

      // 按钮已 enable：拦截 console.warn 判定 socket 是否未连。
      // try/catch 保护：即使 click 抛错也要在回调里恢复 console.warn，避免永久劫持。
      let socketNotConnected = false;
      let clickFailed = false;
      const restoreWarn = interceptWarn(SOCKET_NOT_CONNECTED_WARN, () => {
        socketNotConnected = true;
      });
      try {
        button.click();
      } catch {
        clickFailed = true;
      }

      window.setTimeout(() => {
        restoreWarn();
        if (Date.now() - startedAt >= MAX_WAIT_MS) {
          finishTimeout();
          return;
        }
        if (clickFailed || socketNotConnected) {
          // click 抛错或 socket 未连：本次作废，重置输入重试。
          inputFilled = false;
          setTimeout(attempt, SOCKET_RETRY_DELAY_MS);
          return;
        }
        trackAutoSend(templateId, "sent");
        autoSendRunning = false;
      }, SEND_RESULT_WAIT_MS);
    };

    attempt();
  }, [setClawSenderInput]);

  return null;
}
