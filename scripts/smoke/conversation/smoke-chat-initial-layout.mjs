// Full packaged App: synthetic identity/history; real file and PTY owners.
// Sample from navigation start through cold/refresh media settlement.
// PLAIN=1 or MANY=1 selects text-only/history fixtures; default covers media.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
import { _electron } from "playwright-core";
import { startHeadlessServer } from "../../headless-server.mjs";
import { startTerminalPtyOwner } from "../../../apps/local-agent-host/src/terminal-pty-owner.ts";
import { startHostFileSystem } from "../../host-filesystem.ts";

const webRoot = process.env.OPENCRAFT_FILES_WEB_ROOT;
const executablePath = process.env.OPENCRAFT_ELECTRON_EXECUTABLE;
if (!webRoot || !executablePath) throw Error("Set OPENCRAFT_FILES_WEB_ROOT and OPENCRAFT_ELECTRON_EXECUTABLE");
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-initial-layout-smoke");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "opencraft-files-ui-")),
  work = join(root, "workspace");
await mkdir(work);
const image = join(work, "preview.png"),
  text = join(work, "notes-with-a-long-single-line-title-for-overview.txt");
await writeFile(
  image,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  ),
);
await writeFile(text, "Hands file preview acceptance");
const visualization = join(work, "visualization.html");
await writeFile(visualization, "<div id=state>Stateful HTML</div><script>window.previewCounter=1</script>");
const files = { endpoint: join(root, "files.sock"), tokenFile: join(root, "files.token") };
const owner = await startHostFileSystem(files),
  nativeFiles = [];
const terminalOps = [];
let historyRequests = 0;
const ptyDirectory = join(root, "pty");
await mkdir(ptyDirectory, { mode: 0o700 });
const terminalOwner = {
  directory: ptyDirectory,
  endpoint: join(root, "terminal.sock"),
  tokenFile: join(root, "terminal.token"),
};
await writeFile(terminalOwner.tokenFile, "synthetic-fixture-token-with-more-than-32-characters", { mode: 0o600 });
const stopTerminal = await startTerminalPtyOwner(ptyDirectory, terminalOwner.endpoint, {
  token: "synthetic-fixture-token-with-more-than-32-characters",
  prepare: async (method, params, identity) => {
    terminalOps.push({ method });
    return identity;
  },
});
const turn = {
  id: "turn-files",
  status: "completed",
  error: null,
  items: [
    { id: "user", type: "userMessage", content: [{ type: "text", text: "Show my workspace files and image" }] },
    {
      id: "answer",
      type: "agentMessage",
      phase: "final_answer",
      text: `## Real Markdown\n\n**Formatted answer**\n\n\`\`\`js\nconst answer = 42;\n\`\`\`\n\n[Browse workspace](${work})\n\n[Read notes](${text})\n\n![Hands preview](${image})\n\n\uE200visualize\uE202${JSON.stringify({ path: visualization, title: "Stateful preview" })}\uE201`,
    },
  ],
};
if (process.env.PLAIN)
  turn.items[1].text =
    "## Real Markdown\n\n**Formatted answer**\n\n" +
    Array.from({ length: 12 }, (_, i) => "- List item " + i).join("\n");
turn.items[1].text +=
  "\n\n" +
  Array.from({ length: 36 }, (_, i) => "Context paragraph " + i + ". The conversation continues.").join("\n\n") +
  "\n\nLATEST_PREVIEW_MESSAGE";
if (process.env.ENHANCED)
  turn.items[1].text =
    "## Real Markdown\n\n**Formatted answer**\n\n" +
    Array.from({ length: 6 }, (_, i) => "Paragraph " + i + ". Reading context.").join("\n\n") +
    "\n\n" +
    String.fromCharCode(96).repeat(3) +
    "js\nconst answer = 42;\n" +
    String.fromCharCode(96).repeat(3) +
    "\n\n" +
    String.fromCharCode(36).repeat(2) +
    "\n\\sum_{i=1}^n i^2=\\frac{n(n+1)(2n+1)}{6}\n" +
    String.fromCharCode(36).repeat(2) +
    "\n\nLATEST_PREVIEW_MESSAGE";
const thread = {
  id: "files-acceptance",
  name: "Hands files acceptance",
  preview: "Files fixture",
  cwd: work,
  createdAt: Math.floor(Date.now() / 1000),
  updatedAt: Math.floor(Date.now() / 1000),
  source: "cli",
  modelProvider: "fixture",
  path: null,
  turns: [turn],
};
if (process.env.MANY) {
  thread.turns = Array.from({ length: 24 }, (_, i) => ({
    id: "turn-" + i,
    status: "completed",
    error: null,
    startedAt: 1794200000 + i * 60,
    completedAt: 1794200050 + i * 60,
    durationMs: 50000,
    items: [
      { id: "user-" + i, type: "userMessage", content: [{ type: "text", text: "继续排查这个会话的显示问题 " + i }] },
      {
        id: "comment-" + i,
        type: "agentMessage",
        phase: "commentary",
        text: "我会检查首次刷新后的位置变化，保留原来的输入和滚动状态。",
      },
      {
        id: "command-" + i,
        type: "commandExecution",
        command: "git status",
        cwd: work,
        status: "completed",
        aggregatedOutput: "working tree clean",
        exitCode: 0,
        durationMs: 80,
      },
      {
        id: "answer-" + i,
        type: "agentMessage",
        phase: "final_answer",
        text:
          "已完成检查。这里是第 " +
          i +
          " 轮结果。\n\n- 保持主聊天与工具的状态。\n- 不加入额外等待或加载遮罩。\n- 验证手机与桌面布局。\n\n" +
          (i === 23 ? "LATEST_PREVIEW_MESSAGE" : "继续下一轮。"),
      },
    ],
  }));
}
if (process.env.ASYNC) {
  turn.startedAt = 1794200000;
  turn.completedAt = 1794203093;
  turn.durationMs = 3093000;
  const title = "从零刷新时，闪动更像哪一种？";
  turn.items = [
    { id: "user", type: "userMessage", content: [{ type: "text", text: "没解决，话说页面从零刷新也是一样这个现象" }] },
    {
      id: "question",
      type: "agentMessage",
      phase: "final_answer",
      delivery: "async",
      questions: [
        {
          title,
          options: ["整块聊天正文短暂消失后重现", "文字一直在，但位置或大小突然跳变", "背景、按钮或遮罩的明暗闪一下"],
        },
      ],
      text:
        title + "\n\n- 整块聊天正文短暂消失后重现\n- 文字一直在，但位置或大小突然跳变\n- 背景、按钮或遮罩的明暗闪一下",
    },
    {
      id: "reply",
      type: "steeringUserMessage",
      clientId: "reply-client",
      content: [
        {
          type: "text",
          text:
            "<send_user_message_question_reply>\n" +
            JSON.stringify([
              {
                questionItemId: JSON.stringify(["request_user_input_async", "question", 0]),
                question: title,
                answer: "文字一直在，但位置或大小突然跳变",
              },
            ]) +
            "\n</send_user_message_question_reply>",
        },
      ],
    },
    { id: "progress", type: "agentMessage", phase: "commentary", text: "检查布局测量与滚动补偿。" },
    {
      id: "answer",
      type: "agentMessage",
      phase: "final_answer",
      text: "已修复并上线。这次确认了两处布局问题：\n\n- 正文变矮后，外层仍保留旧高度，造成约 100px 跳动。\n- 恢复会话时，整轮高度变化触发了多余的滚动补偿。\n\n桌面和触控模拟中，刷新、切换及异步内容加载的位置检查均通过。\n\nLATEST_PREVIEW_MESSAGE",
    },
  ];
}
let releaseHistory;
let historyGate = null;
const otherThread = {
  ...thread,
  id: "switch-acceptance",
  name: "Switch acceptance",
  turns: [
    {
      ...turn,
      id: "other-turn",
      items: [{ id: "other-answer", type: "agentMessage", phase: "final_answer", text: "OTHER_CONVERSATION_READY" }],
    },
  ],
};
class Engine {
  status = { state: "open" };
  listeners = new Set();
  async connect() {}
  async close() {}
  subscribeStatus() {
    return () => {};
  }
  subscribeMessage(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  async send(frame) {
    const v = JSON.parse(frame);
    if (v.id == null) return;
    let result = { data: [], nextCursor: null, providers: [], models: [], settings: [] };
    if (["thread/read", "thread/resume", "thread/turns/list"].includes(v.method) || v.method.includes("/items/list")) {
      historyRequests++;
      if (historyGate) await historyGate;
    }
    if (v.method.startsWith("fs/")) nativeFiles.push(v.method);
    if (v.method === "initialize") result = { serverInfo: { name: "Files fixture", version: "1" }, capabilities: {} };
    const selected = v.params?.threadId === otherThread.id ? otherThread : thread;
    if (v.method === "thread/list")
      result = {
        data: [
          { ...thread, turns: [] },
          { ...otherThread, turns: [] },
        ],
        nextCursor: null,
      };
    if (["thread/read", "thread/resume"].includes(v.method))
      result = {
        thread: selected,
        model: "fixture",
        modelProvider: "fixture",
        cwd: work,
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
      };
    if (v.method === "thread/turns/list") result = { data: selected.turns, nextCursor: null };
    if (v.method.includes("/items/list"))
      result = {
        data: (selected.turns.find((t) => t.id === v.params?.turnId) ?? selected.turns[0]).items,
        nextCursor: null,
      };
    if (v.method === "project/list")
      result = {
        data: [{ id: "files-project", name: "Files fixture", roots: [{ id: "root", path: work }], metadata: {} }],
        nextCursor: null,
      };
    if (v.method === "config/read") result = { config: { cwd: work }, origins: {} };
    const reply = {
      id: v.id,
      __opencraftClient: v.__opencraftClient,
      ...(v.method.startsWith("fs/")
        ? { error: { code: -32603, message: "local filesystem is not configured" } }
        : { result }),
    };
    for (const fn of this.listeners) fn(JSON.stringify(reply));
  }
}
const agent = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => agent.once("listening", r));
agent.on("connection", (socket) => {
  const engine = new Engine();
  engine.subscribeMessage((frame) => socket.readyState === 1 && socket.send(frame));
  socket.on("message", (frame) => engine.send(String(frame)));
});
const principal = {
  provider: "files-fixture",
  subject: "acceptance-user",
  displayName: "Files tester",
  expiresAt: Date.now() + 600000,
};
let app, browser;
try {
  app = await startHeadlessServer(
    {
      root,
      webRoot,
      dataDirectory: join(root, "gateway"),
      runtimeDirectory: work,
      port: 0,
      fileSystemOwner: files,
      terminalOwner,
      accessMemberProviders: [principal.provider],
      createCodexTransport: () => new Engine(),
      startAgentHost: async () => ({ websocketUrl: "ws://127.0.0.1:" + agent.address().port + "/rpc", close() {} }),
    },
    {
      createIdentity: async () => ({
        providers: [
          { authenticate: (request) => (request.headers["x-fixture-proof"] === "verified" ? principal : null) },
        ],
        close() {},
      }),
    },
  );
  const script = join(root, "app.cjs");
  await writeFile(
    script,
    "const{app,BrowserWindow}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(()=>new BrowserWindow({show:true,width:1280,height:900,webPreferences:{sandbox:true}}).loadURL('about:blank'));",
  );
  const env = { ...process.env };
  for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH", "DISPLAY", "WAYLAND_DISPLAY"])
    delete env[key];
  browser = await _electron.launch({
    executablePath,
    args: [
      "--disk-cache-size=1",
      "--disable-gpu-shader-disk-cache",
      "--ozone-platform=headless",
      "--ozone-override-screen-size=1920,1080",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      script,
    ],
    env,
  });
  const page = await browser.firstWindow();
  page.setDefaultTimeout(20000);
  await page.context().setExtraHTTPHeaders({ "x-fixture-proof": "verified" });
  const touch = process.argv.includes("--touch");
  if (touch) {
    await page.setViewportSize({ width: 390, height: 844 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.setUserAgentOverride", {
      userAgent: (await page.evaluate(() => navigator.userAgent)).replace(/Electron\/[\d.]+ ?/, ""),
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  }
  await page.addInitScript(() => {
    localStorage.setItem("opencraft.appearance-theme", "system");
    localStorage.setItem("opencraft.appearance-theme-id", "opencraft.core.longing");
  });
  await page.emulateMedia({ colorScheme: "light" });
  if (process.env.OPENCRAFT_PREVIEW_FORCE_POPOVER) await page.addInitScript("delete Element.prototype.moveBefore");
  await page.addInitScript(() => {
    window.flashFrames = [];
    window.flashSampling = true;
    const nodes = new WeakMap();
    let seq = 0;
    const id = (n) => {
      if (!n) return null;
      if (!nodes.has(n)) nodes.set(n, ++seq);
      return nodes.get(n);
    };
    function sample() {
      if (!window.flashSampling) return;
      const body = document.querySelector(".main-content-body"),
        scroll = document.querySelector(".thread-scroll");
      const turns = [...document.querySelectorAll(".thread-turn")];
      const rect = (e) =>
        e
          ? { y: e.getBoundingClientRect().y, h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width }
          : null;
      window.flashFrames.push({
        at: performance.now(),
        url: location.pathname,
        alpha: body ? getComputedStyle(body).opacity : null,
        scroll: scroll?.scrollTop,
        height: scroll?.scrollHeight,
        client: scroll?.clientHeight,
        root: id(scroll),
        turns: turns.map((e) => ({ id: id(e), key: e.dataset.turnKey, ...rect(e) })),
        frames: [...document.querySelectorAll(".thread-frame")].map((e) => ({
          id: id(e),
          key: e.dataset.frameKey,
          ...rect(e),
        })),
        images: [...document.querySelectorAll(".thread-scroll img,.thread-scroll iframe")].map((e) => ({
          tag: e.tagName,
          loaded: e.complete,
          id: id(e),
          ...rect(e),
        })),
        docs: [...document.querySelectorAll(".opencraft-chat-document")].map((e) => ({
          id: id(e),
          animated: e.dataset.markdownAnimated,
          font: getComputedStyle(e).font,
          paragraphs: [...e.querySelectorAll("p")]
            .slice(-3)
            .map((p) => ({ ...rect(p), text: p.innerText, font: getComputedStyle(p).font })),
          text: e.innerText.length,
          ...rect(e),
        })),
        fallbacks: document.querySelectorAll(".chat-math-fallback").length,
        highlighted: document.querySelectorAll(".chat-code-block .chat-code-highlight").length,
        mediaPending: document.querySelectorAll(".chat-markdown-media-placeholder").length,
        hidden: [...document.querySelectorAll(".thread-scroll [data-chat-text-segment]")].filter(
          (e) => +getComputedStyle(e).opacity < 1,
        ).length,
        animations: document
          .getAnimations()
          .map((a) => ({ name: a.animationName, state: a.playState, target: a.effect?.target?.className })),
        ancestors: scroll
          ? [
              scroll,
              ...(function* (e) {
                while (e.parentElement) {
                  e = e.parentElement;
                  yield e;
                }
              })(scroll),
            ].map((e) => ({
              cls: e.className,
              style: e.getAttribute("style"),
              alpha: getComputedStyle(e).opacity,
              visibility: getComputedStyle(e).visibility,
            }))
          : [],
        tail: scroll?.innerText.slice(-180),
      });
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error("PAGE", msg.text());
  });
  const network = [];
  page.on("response", (r) => network.push({ at: Date.now(), url: r.url(), status: r.status() }));
  for (const phase of ["cold", "reload"]) {
    if (phase === "cold") await page.goto(app.url + "/local/files-acceptance?hostId=local-codex");
    else {
      if (process.env.ASYNC)
        historyGate = new Promise((resolve) => {
          releaseHistory = resolve;
        });
      await page.reload();
    }
    await page.getByText("LATEST_PREVIEW_MESSAGE", { exact: false }).first().waitFor();
    if (process.env.ASYNC && phase === "reload") {
      const capture = () =>
        page.evaluate(() => {
          const scroll = document.querySelector(".thread-scroll");
          return {
            text: scroll?.innerText,
            users: [...scroll.querySelectorAll(".thread-user-message")].map((e) => e.innerText),
            questions: [...scroll.querySelectorAll(".thread-async-question")].map((e) => ({
              state: e.dataset.state,
              text: e.innerText,
            })),
            tail: [...scroll.querySelectorAll("p")]
              .filter((e) => e.textContent === "LATEST_PREVIEW_MESSAGE")
              .map((e) => e.getBoundingClientRect().y),
          };
        });
      await page.waitForTimeout(300);
      const before = await capture();
      await page.screenshot({ path: join(output, "cache-before-history.png") });
      releaseHistory();
      historyGate = null;
      await page.waitForTimeout(1500);
      const after = await capture();
      await writeFile(join(output, "semantic-handoff.json"), JSON.stringify({ before, after }, null, 2));
      assert.deepEqual(after.users, before.users, "cache and canonical history must preserve user bubbles");
      assert.deepEqual(after.questions, before.questions, "cache and canonical history must preserve question states");
      assert.ok(before.text.includes("文字一直在，但位置或大小突然跳变"));
      assert.ok(after.tail.length && before.tail.length);
      assert.ok(Math.abs(after.tail[0] - before.tail[0]) <= 1, "semantic handoff must not move the tail");
    }
    await page.waitForTimeout(4500);
    await writeFile(
      join(output, phase + "-frames.json"),
      JSON.stringify(
        await page.evaluate(() => {
          window.flashSampling = false;
          return window.flashFrames;
        }),
        null,
        2,
      ),
    );
    await page.screenshot({ path: join(output, phase + ".png") });
    if (process.env.ASSERT_TAIL !== "0") {
      const frames = await page.evaluate(() => window.flashFrames);
      const positions = frames.flatMap((f) =>
        f.docs.flatMap((d) => d.paragraphs.filter((p) => p.text === "LATEST_PREVIEW_MESSAGE").map((p) => p.y)),
      );
      assert.ok(positions.length > 10);
      const drift = Math.max(...positions) - Math.min(...positions);
      console.log("TAIL_DRIFT", phase, drift, positions.length);
      assert.ok(drift <= 1, "tail must stay fixed through asynchronous size changes: " + drift);
    }
  }

  if (!process.env.MANY && !process.env.ENHANCED && !process.env.ASYNC) {
    const scroll = page.locator(".thread-scroll");
    await scroll.evaluate((e) => {
      e.scrollTop = -350;
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const anchor = await scroll.evaluate((e) => {
      const bounds = e.getBoundingClientRect();
      const p = [...e.querySelectorAll("p")].find(
        (p) =>
          p.textContent.startsWith("Context paragraph") &&
          p.getBoundingClientRect().top >= bounds.top &&
          p.getBoundingClientRect().bottom <= bounds.bottom,
      );
      if (!p) throw Error("No visible reading anchor");
      return { text: p.textContent, offset: p.getBoundingClientRect().top - bounds.top };
    });
    const assertAnchor = async (label) => {
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))),
      );
      const offset = await scroll.evaluate(
        (e, text) =>
          [...e.querySelectorAll("p")].find((p) => p.textContent === text).getBoundingClientRect().top -
          e.getBoundingClientRect().top,
        anchor.text,
      );
      assert.ok(Math.abs(offset - anchor.offset) <= 1, label + ": reading paragraph moved " + (offset - anchor.offset));
    };
    // Exercise layout changes below the reader in the same mounted Turn. The
    // real row observer/controller must preserve the paragraph, not row height.
    for (const padding of ["180px", "0px"]) {
      await page.getByText("LATEST_PREVIEW_MESSAGE", { exact: true }).evaluate((e, value) => {
        e.style.paddingBottom = value;
      }, padding);
      await assertAnchor("mounted content below reader " + padding);
    }
    for (const id of [otherThread.id, thread.id, otherThread.id, thread.id]) {
      const row = page.locator('[data-thread-id="' + id + '"]').first();
      if (!(await row.isVisible())) await page.locator("[data-app-shell-sidebar-trigger]:visible").first().click();
      await row.click();
      await page.waitForURL((url) => url.pathname.endsWith("/" + id));
      await page
        .getByText(id === thread.id ? "Formatted answer" : "OTHER_CONVERSATION_READY", { exact: true })
        .waitFor();
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector(".main-content-body")).opacity === "1" &&
          !document.querySelector(".main-content-body").inert,
      );
      if (touch) await row.waitFor({ state: "hidden" });
      if (id === thread.id) await assertAnchor("conversation return");
    }
    console.log("READING_ANCHOR_STABLE", anchor);
  }
  await writeFile(join(output, "network.json"), JSON.stringify(network, null, 2));
  console.log(JSON.stringify({ ok: true, phase: "cold and reload", historyRequests }));
} catch (error) {
  console.error("TERMINAL_METHODS", JSON.stringify(terminalOps));
  if (browser) {
    const page = await browser.firstWindow();
    console.error("FILES_FAILED_BODY", await page.locator("body").innerText());
    await page.screenshot({ path: join(output, "files-failed.png"), timeout: 5000 }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  await app?.close();
  for (const socket of agent.clients) socket.terminate();
  await new Promise((r) => agent.close(r));
  await owner.close();
  await stopTerminal();
  await rm(root, { recursive: true, force: true });
}
