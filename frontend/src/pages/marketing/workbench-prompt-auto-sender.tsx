import { useEffect } from "react";

// 注意：自动发送目前借用 @tencent/agentchat-claw-panel 的 useClawSender 单例来写入
// 面板输入框并触发发送，这只是「临时通过 claw-panel 这个 SDK 实现自动发送」的过渡方案。
// 后续该能力应由 @tencent/agentchat-lightvela-panel 原生提供，届时应改为从
// lightvela-panel 获取 sender 能力并移除此处对 claw-panel 的依赖。
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
 * 由工作台卡片写入 sessionStorage 的 pending prompt，在 chat 面板（LightVelaPanel）
 * 挂载后被本组件读取并自动「填入输入框 → 发送」，随后清除 pending。
 *
 * 实现要点：
 * - setClawSenderInput 来自 @tencent/agentchat-claw-panel 的 useClawSender，
 *   底层是 claw-hooks 的全局单例 store（senderInput.set），与面板内部 sender 共享同一实例，
 *   因此在面板兄弟节点调用即可写入面板输入框（不依赖 React context provider）。
 *   ⚠️ 这里借用 claw-panel 只是过渡：自动发送能力后续应由 lightvela-panel 原生提供，
 *   届时应改为从 lightvela-panel 取 sender 能力并移除对 claw-panel 的依赖。
 * - 发送不直接调用底层 send()（会绕过 sender 的 mention 解析/埋点/canSubmit 校验），
 *   而是复用 sender 自身的提交按钮 button[data-eid="send-submit"]，行为与真实用户点击一致。
 * - sender 是异步挂载的（等待 launchToken → 懒加载面板 → 渲染），因此填入与点击都带重试轮询，
 *   在超时窗口内等待输入框订阅生效、发送按钮 enable。
 */

const SUBMIT_BUTTON_SELECTOR = 'button[data-eid="send-submit"]';
/** 轮询间隔：兼顾响应速度与不空转 */
const POLL_INTERVAL_MS = 150;
/**
 * 最长等待窗口：覆盖懒加载 + 建连 + 输入框就绪 + agent 冷启动初始化。
 *
 * agent 首次进入时后端要拉起实例并执行初始化脚本（/debug/exec），
 * 期间发送按钮会持续 disabled，耗时可达数十秒。窗口太短会在按钮 enable
 * 之前就超时兜底，表现为「文本已填、按钮已亮，却没自动发」。因此放宽到 60s，
 * 让轮询持续到按钮真正 enable 后立即点击。
 */
const MAX_WAIT_MS = 60000;

/**
 * 模块级运行守卫。
 *
 * React 18/19 的 StrictMode 在开发模式下会「挂载 → 立即卸载 → 再挂载」组件，
 * 若把轮询状态放在组件内并在 cleanup 里取消，第一次挂载启动的轮询会被立刻杀掉，
 * 而第二次挂载又因 handledRef 已置位而跳过 —— 导致轮询只跑一次就死掉。
 *
 * 因此把「本条 pending 是否已在处理」提升到模块级：
 * - 同一条 pending 只启动一次轮询；
 * - 轮询不随组件 cleanup 取消，跨双挂载存活，直到发送成功或超时。
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

export function WorkbenchPromptAutoSender() {
  const { setClawSenderInput } = useClawSender();

  useEffect(() => {
    // 模块级守卫：同一条 pending 只启动一次轮询，避免 StrictMode 双挂载重复触发。
    if (autoSendRunning) return;
    const pending = readPendingWorkbenchPrompt();
    if (!pending) return;
    autoSendRunning = true;
    // 立即清除，避免二次进入 chat 或刷新时重复发送。
    clearPendingWorkbenchPrompt();

    const { prompt, templateId } = pending;
    // 发送那一刻统一追加共享技术栈约束：无论来源是预设模板还是未来的用户自定义输入，
    // 都在这里补全，避免约束写死进各处文案。
    const finalPrompt = withSharedTechStack(prompt);
    const startedAt = Date.now();
    // 文本填入后不再持续覆盖：agent 冷启动期间按钮长时间 disabled，
    // 若每轮都重写会覆盖用户在等待期的手动编辑。因此只要 sender 已挂载、
    // 文本成功写入过一次，后续仅轮询按钮 enable，不再回写。
    let inputFilled = false;

    // 关键：轮询不随组件 cleanup 取消。StrictMode 会「挂载→卸载→再挂载」，
    // 若在 cleanup 里 clearTimeout，会把刚启动的轮询杀掉、而再挂载又被守卫跳过，
    // 导致轮询只跑一次就死。sender 是异步挂载的，必须让轮询跨双挂载持续存活。
    const attempt = () => {
      const textareas = document.querySelectorAll<HTMLTextAreaElement>("textarea");
      if (!inputFilled) {
        // sender 挂载前反复尝试写入，覆盖挂载前的丢失与草稿缓存的竞态。
        setClawSenderInput(finalPrompt);
        // 输入框已出现且内容写入成功，视为填入完成，后续不再覆盖用户编辑。
        if (textareas.length > 0 && Array.from(textareas).some((t) => t.value.length > 0)) {
          inputFilled = true;
        }
      }

      const button =
        Array.from(
          document.querySelectorAll<HTMLButtonElement>(SUBMIT_BUTTON_SELECTOR),
        ).find((b) => !b.disabled) ?? null;

      if (button) {
        button.click();
        trackAutoSend(templateId, "sent");
        autoSendRunning = false;
        return;
      }

      if (Date.now() - startedAt >= MAX_WAIT_MS) {
        // 超时兜底：文本已填入输入框，用户可手动发送。
        trackAutoSend(templateId, "timeout");
        autoSendRunning = false;
        return;
      }

      setTimeout(attempt, POLL_INTERVAL_MS);
    };

    attempt();
  }, [setClawSenderInput]);

  return null;
}
