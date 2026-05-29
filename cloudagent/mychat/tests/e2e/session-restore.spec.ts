import { expect, type Page, test } from "@playwright/test";

const acpURL = process.env.MYCHAT_E2E_ACP_URL ?? process.env.CLOUDAGENT_ACP_E2E_URL;
const liveEnabled = process.env.MYCHAT_E2E === "1";
const cleanupSessions = process.env.MYCHAT_E2E_CLEANUP_SESSIONS === "1";
const agentMessageSelector = '[data-testid="chat-message"][data-role="agent"]';

test.skip(!liveEnabled || !acpURL, "set MYCHAT_E2E=1 and MYCHAT_E2E_ACP_URL to run live MyChat restore e2e");

test.beforeEach(async () => {
  await cleanupAcpSessions();
});

test.afterEach(async () => {
  await cleanupAcpSessions();
});

async function cleanupAcpSessions() {
  if (!cleanupSessions || !acpURL) return;
  const list = await acpRPC("session/list", {});
  const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
  for (const session of sessions) {
    const sessionId =
      session && typeof session.sessionId === "string"
        ? session.sessionId
        : undefined;
    if (!sessionId) continue;
    try {
      await acpRPC("session/delete", { sessionId });
    } catch (error) {
      console.warn(`session/delete cleanup failed for ${sessionId}:`, error);
      try {
        await acpRPC("session/close", { sessionId });
      } catch (closeError) {
        console.warn(`session/close cleanup failed for ${sessionId}:`, closeError);
      }
    }
  }
}

async function acpRPC(method: string, params: Record<string, unknown>) {
  if (!acpURL) throw new Error("MYCHAT_E2E_ACP_URL is required");
  const wsURL = acpURL.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const ws = new WebSocket(wsURL);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timed out waiting for ${method}`));
    }, 180_000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    });
    ws.addEventListener("message", (event) => {
      const data =
        typeof event.data === "string"
          ? event.data
          : Buffer.from(event.data as ArrayBuffer).toString("utf8");
      const message = JSON.parse(data) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message?: string };
      };
      if (message.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (message.error) {
        reject(new Error(message.error.message ?? `${method} failed`));
        return;
      }
      resolve(message.result ?? {});
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`websocket error during ${method}`));
    });
  });
}

async function openConnectedApp(page: Page) {
  await page.goto(`/?acp_url=${encodeURIComponent(acpURL!)}`);
  await expect(page.getByLabel("Open session properties")).toContainText(
    "connected",
  );
  await expect(page.getByTestId("prompt-input")).toBeEnabled();
}

async function createFreshSession(page: Page) {
  await page.getByLabel("New 会话").click();
  await expect(page.getByTestId("prompt-input")).toBeEnabled();
}

async function sendPrompt(page: Page, prompt: string) {
  const agentMessages = page.locator(agentMessageSelector);
  const agentCountBeforePrompt = await agentMessages.count();
  await page.getByTestId("prompt-input").fill(prompt);
  await page.getByTestId("send-button").click();
  return agentMessages.nth(agentCountBeforePrompt);
}

async function sendPromptAndExpectAgentText(
  page: Page,
  prompt: string,
  text: string,
  timeout = 180_000,
) {
  const message = await sendPrompt(page, prompt);
  await expect(message).toContainText(text, { timeout });
  await expect(page.getByTestId("prompt-input")).toBeEnabled({
    timeout: 60_000,
  });
  return message;
}

async function expectAnyAgentMessage(page: Page, text: string, timeout = 180_000) {
  await expect(
    page.locator(agentMessageSelector, { hasText: text }).last(),
  ).toBeVisible({ timeout });
}

test("reloads the page, loads the ACP session, and preserves model conversation history", async ({
  page,
}) => {
  const marker = `cloudagent-browser-history-${Date.now()}`;
  const firstPrompt = `这一轮只输出 HISTORY_READY。为了后续校验，这条用户消息包含唯一标记 ${marker}。`;
  const secondPrompt =
    "请查看本对话的上一条用户消息，完整逐字复制其中以 cloudagent-browser-history- 开头并包含数字时间戳的唯一标记。不要省略前缀，不要解释，最终答案必须以 cloudagent-browser-history- 开头。";

  await openConnectedApp(page);
  await createFreshSession(page);
  await sendPromptAndExpectAgentText(page, firstPrompt, "HISTORY_READY");

  await page.reload();
  await openConnectedApp(page);

  await sendPrompt(page, secondPrompt);
  await expectAnyAgentMessage(page, marker);
});

test("recovers a completed answer after the stream is interrupted", async ({
  page,
}) => {
  const marker = `cloudagent-stream-reload-${Date.now()}`;
  const appURL = `/?acp_url=${encodeURIComponent(acpURL!)}`;
  const prompt =
    `请先输出 STREAM_RELOAD_BEGIN，然后必须调用 terminal 执行 \`sleep 6 && echo ${marker}\`。` +
    "命令结束后只追加终端输出的标记，不要提前输出标记。";

  await openConnectedApp(page);
  await createFreshSession(page);

  const agentMessages = page.locator(agentMessageSelector);
  const agentCountBeforePrompt = await agentMessages.count();
  await page.getByTestId("prompt-input").fill(prompt);
  await page.getByTestId("send-button").click();

  await page.waitForFunction(
    ({ index, marker, selector }) => {
      const node = document.querySelectorAll(selector)[index];
      const text = node?.textContent ?? "";
      return text.trim().length > 0 && !text.includes(marker);
    },
    { index: agentCountBeforePrompt, marker, selector: agentMessageSelector },
    { timeout: 120_000 },
  );

  await page.goto("about:blank");
  await page.waitForTimeout(18_000);
  await page.goto(appURL);
  await openConnectedApp(page);
  await expectAnyAgentMessage(page, marker, 240_000);
});

test("preserves chat memory across turns without reloading", async ({ page }) => {
  const marker = `cloudagent-active-memory-${Date.now()}`;

  await openConnectedApp(page);
  await createFreshSession(page);
  await sendPromptAndExpectAgentText(
    page,
    `请记住这个唯一标记：${marker}。本轮最终只输出 ACTIVE_MEMORY_READY。`,
    "ACTIVE_MEMORY_READY",
  );

  await sendPrompt(page, "请只输出上一轮用户消息里的 cloudagent-active-memory- 唯一标记，不要解释。");
  await expectAnyAgentMessage(page, marker);
});

test("streams a short CJK answer to completion without reloading", async ({
  page,
}) => {
  const expected = `LIVE_CJK_STREAM_OK_${Date.now()}`;

  await openConnectedApp(page);
  await createFreshSession(page);
  await sendPromptAndExpectAgentText(
    page,
    `最终答案只输出 ${expected}，不要解释，不要调用工具。`,
    expected,
  );
});

test("keeps a fresh session isolated from the previous session", async ({
  page,
}) => {
  const marker = `cloudagent-isolation-a-${Date.now()}`;

  await openConnectedApp(page);
  await createFreshSession(page);
  await sendPromptAndExpectAgentText(
    page,
    `请记住这个唯一标记：${marker}。本轮最终只输出 SESSION_A_READY。`,
    "SESSION_A_READY",
  );

  await createFreshSession(page);
  const message = await sendPromptAndExpectAgentText(
    page,
    "如果本会话历史里没有 cloudagent-isolation-a- 标记，只输出 NO_SESSION_A_MARKER；如果有，才输出那个标记。",
    "NO_SESSION_A_MARKER",
  );
  await expect(message).not.toContainText(marker);
});

test("executes a terminal command and returns stdout in chat", async ({
  page,
}) => {
  const marker = `cloudagent-terminal-${Date.now()}`;

  await openConnectedApp(page);
  await createFreshSession(page);
  await sendPrompt(page, `必须调用 terminal 执行 \`echo ${marker}\`。工具完成后，最终答案只输出 stdout 中的唯一标记。`);
  await expectAnyAgentMessage(page, marker, 240_000);
});

test("creates and reads a workspace file through the agent runtime", async ({
  page,
}) => {
  const marker = `cloudagent-file-${Date.now()}`;
  const filename = `cloudagent_e2e_${Date.now()}.txt`;

  await openConnectedApp(page);
  await createFreshSession(page);
  await sendPrompt(
    page,
    `必须调用 terminal 执行 \`printf '${marker}' > /workspace/${filename} && cat /workspace/${filename}\`。` +
      "工具完成后，最终答案只输出 cat 读到的唯一标记。",
  );
  await expectAnyAgentMessage(page, marker, 240_000);
});
