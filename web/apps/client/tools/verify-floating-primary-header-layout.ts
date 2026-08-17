import {mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";

import {
  type FloatingHeaderLayoutSample,
  validateFloatingHeaderLayout,
  validateStableLayoutBox,
} from "./floating-primary-header-layout";

interface BrowserSample extends FloatingHeaderLayoutSample {
  kind: "conversation" | "management";
  viewport: number;
}

const args = process.argv.slice(2);
const value = (name: string, fallback?: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const baseURL = value("--url");
const evidenceDirectory = value("--evidence", ".floating-header-evidence")!;
const expectedHeaderHeight = Number(value("--expected-header-height", "52"));
const touch = args.includes("--touch");
if (!baseURL || !Number.isFinite(expectedHeaderHeight)) {
  throw new Error("usage: bun tools/verify-floating-primary-header-layout.ts --url URL [--evidence DIR] [--expected-header-height N]");
}

const session = `vela-floating-header-${process.pid}`;
const run = (command: string[], allowFailure = false) => {
  const result = Bun.spawnSync({cmd: ["agent-browser", "--session", session, ...command]});
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout;
};
const evaluate = <T>(script: string): T => {
  const output = run(["eval", script]);
  const decoded = JSON.parse(output) as unknown;
  return (typeof decoded === "string" ? JSON.parse(decoded) : decoded) as T;
};
const boxScript = (
  stageSelector: string,
  headerSelector: string,
  contentSelector: string,
) => `(() => {
  const read = selector => {
    const element = document.querySelector(selector);
    if (!element) throw new Error('missing selector ' + selector);
    const box = element.getBoundingClientRect();
    return {bottom: box.bottom, height: box.height, left: box.left, right: box.right, top: box.top, width: box.width};
  };
  return JSON.stringify({stage: read(${JSON.stringify(stageSelector)}), header: read(${JSON.stringify(headerSelector)}), content: read(${JSON.stringify(contentSelector)})});
})()`;
const readBoxScript = (selector: string) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) throw new Error('missing selector ' + ${JSON.stringify(selector)});
  const box = element.getBoundingClientRect();
  return JSON.stringify({bottom: box.bottom, height: box.height, left: box.left, right: box.right, top: box.top, width: box.width});
})()`;
const clickButtonScript = (label: string) => `(() => {
  const button = Array.from(document.querySelectorAll('[role="button"]')).find(element => element.getAttribute('aria-label') === ${JSON.stringify(label)});
  if (!(button instanceof HTMLElement)) throw new Error('missing button ' + ${JSON.stringify(label)});
  button.click();
  return 'ok';
})()`;

async function verifyWideTouchLayout() {
  run(["open", "about:blank"]);
  const browserURL = new URL(run(["get", "cdp-url"]));
  const targets = await fetch(`http://${browserURL.host}/json/list`).then(response => response.json()) as Array<{
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
  }>;
  const pageURL = targets.find(target => target.type === "page" && target.url === "about:blank")
    ?.webSocketDebuggerUrl;
  if (!pageURL) throw new Error("touch verifier could not find the page CDP target");

  const socket = new WebSocket(pageURL);
  let nextID = 0;
  const pending = new Map<number, {
    reject(reason: unknown): void;
    resolve(value: unknown): void;
  }>();
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = event => reject(event);
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data)) as {
        error?: unknown;
        id?: number;
        result?: unknown;
      };
      if (!message.id) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(message.error);
      else request.resolve(message.result);
    };
  });
  const send = <T>(method: string, params: object = {}) => new Promise<T>((resolve, reject) => {
    const id = ++nextID;
    pending.set(id, {reject, resolve: value => resolve(value as T)});
    socket.send(JSON.stringify({id, method, params}));
  });
  const evaluateCDP = async <T>(script: string): Promise<T> => {
    const response = await send<{
      exceptionDetails?: unknown;
      result: {value?: string};
    }>("Runtime.evaluate", {expression: script, returnByValue: true});
    if (response.exceptionDetails || response.result.value === undefined) {
      throw new Error(`CDP evaluation failed: ${JSON.stringify(response.exceptionDetails)}`);
    }
    return JSON.parse(response.result.value) as T;
  };
  const waitForSelector = async (selector: string) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const ready = await evaluateCDP<boolean>(
        `JSON.stringify(Boolean(document.querySelector(${JSON.stringify(selector)})))`,
      );
      if (ready) return;
      await Bun.sleep(250);
    }
    throw new Error(`timed out waiting for ${selector}`);
  };
  const screenshot = async (name: string) => {
    const capture = await send<{data: string}>("Page.captureScreenshot", {format: "png"});
    writeFileSync(join(evidenceDirectory, name), Buffer.from(capture.data, "base64"));
  };

  try {
    await send("Page.enable");
    await send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
    await send("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: 900,
      mobile: false,
      width: 1280,
    });
    await send("Page.navigate", {url: `${baseURL!.replace(/\/$/u, "")}/stylelab`});
    await waitForSelector('[data-testid="conversation-primary-header"]');
    const media = await evaluateCDP<{coarse: boolean; fine: boolean; touchPoints: number}>(
      `JSON.stringify({fine: matchMedia('(pointer: fine)').matches, coarse: matchMedia('(pointer: coarse)').matches, touchPoints: navigator.maxTouchPoints})`,
    );
    if (media.fine || !media.coarse || media.touchPoints < 1) {
      throw new Error(`touch media emulation failed: ${JSON.stringify(media)}`);
    }
    const conversation = await evaluateCDP<Omit<BrowserSample, "kind" | "placement" | "viewport">>(
      boxScript(
        '[data-testid="message-stage"]',
        '[data-testid="conversation-primary-header"]',
        '[data-testid="message-viewport"]',
      ),
    );
    const operationOverlay = await evaluateCDP<FloatingHeaderLayoutSample["header"]>(
      readBoxScript('[data-testid="conversation-operation-status-island"]'),
    );
    await send("Runtime.evaluate", {expression: clickButtonScript("切换到断线状态")});
    await waitForSelector('[data-testid="chat-error-toast-layer"]');
    const disconnectedStage = await evaluateCDP<FloatingHeaderLayoutSample["stage"]>(
      readBoxScript('[data-testid="message-stage"]'),
    );
    const errorOverlay = await evaluateCDP<FloatingHeaderLayoutSample["header"]>(
      readBoxScript('[data-testid="chat-error-toast-layer"]'),
    );
    const touchSamples: BrowserSample[] = [{
      ...conversation,
      expectedHeaderHeight,
      kind: "conversation",
      overlays: [operationOverlay, errorOverlay],
      placement: "inside",
      viewport: 1280,
    }];
    const stabilityFailures = validateStableLayoutBox(
      conversation.stage,
      disconnectedStage,
    ).map(error => `conversation@touch: ${error}`);
    await send("Runtime.evaluate", {expression: clickButtonScript("切换到正常状态")});
    await Bun.sleep(200);
    await screenshot("conversation-touch-1280.png");
    await send("Runtime.evaluate", {expression: clickButtonScript("预览 Agent 界面")});
    await waitForSelector('[data-testid="management-primary-header"]');
    const management = await evaluateCDP<Omit<BrowserSample, "kind" | "placement" | "viewport">>(
      boxScript(
        '[data-testid="system-page"]',
        '[data-testid="management-primary-header"]',
        '[data-testid="agent-detail-scroll"]',
      ),
    );
    touchSamples.push({
      ...management,
      expectedHeaderHeight,
      kind: "management",
      placement: "inside",
      viewport: 1280,
    });
    await send("Runtime.evaluate", {expression: clickButtonScript("切换到断线状态")});
    await Bun.sleep(300);
    const disconnectedManagementStage = await evaluateCDP<FloatingHeaderLayoutSample["stage"]>(
      readBoxScript('[data-testid="system-page"]'),
    );
    stabilityFailures.push(...validateStableLayoutBox(
      management.stage,
      disconnectedManagementStage,
    ).map(error => `management@touch: ${error}`));
    await screenshot("management-touch-1280.png");
    const failures = [...stabilityFailures, ...touchSamples.flatMap(sample =>
      validateFloatingHeaderLayout(sample).map(error => `${sample.kind}@touch: ${error}`),
    )];
    writeFileSync(
      join(evidenceDirectory, "floating-primary-header-boxes.json"),
      `${JSON.stringify({failures, media, samples: touchSamples}, null, 2)}\n`,
      {mode: 0o600},
    );
    if (failures.length > 0) throw new Error(failures.join("\n"));
    console.log(`floating primary header touch layout verified: ${touchSamples.length} samples`);
  } finally {
    socket.close();
    run(["close"], true);
  }
}

mkdirSync(evidenceDirectory, {recursive: true});
if (touch) {
  await verifyWideTouchLayout();
  process.exit(0);
}
const samples: BrowserSample[] = [];
const stabilityFailures: string[] = [];
try {
  run(["open", `${baseURL.replace(/\/$/u, "")}/stylelab`]);
  run(["wait", "--load", "networkidle"]);
  for (const viewport of [1280, 961, 959, 900]) {
    run(["set", "viewport", String(viewport), "900"]);
    run(["wait", "250"]);
    const compact = viewport < 960;
    const conversation = evaluate<Omit<BrowserSample, "kind" | "placement" | "viewport">>(
      boxScript(
        '[data-testid="message-stage"]',
        compact
          ? '[data-testid="compact-primary-header"]'
          : '[data-testid="conversation-primary-header"]',
        '[data-testid="message-viewport"]',
      ),
    );
    const operationOverlay = evaluate<FloatingHeaderLayoutSample["header"]>(
      readBoxScript('[data-testid="conversation-operation-status-island"]'),
    );
    run(["eval", clickButtonScript("切换到断线状态")]);
    run(["wait", "250"]);
    const disconnectedStage = evaluate<FloatingHeaderLayoutSample["stage"]>(
      readBoxScript('[data-testid="message-stage"]'),
    );
    const errorOverlay = evaluate<FloatingHeaderLayoutSample["header"]>(
      readBoxScript('[data-testid="chat-error-toast-layer"]'),
    );
    samples.push({
      ...conversation,
      expectedHeaderHeight,
      kind: "conversation",
      overlays: [operationOverlay, errorOverlay],
      placement: compact ? "before" : "inside",
      viewport,
    });
    stabilityFailures.push(...validateStableLayoutBox(
      conversation.stage,
      disconnectedStage,
    ).map(error => `conversation@${viewport}: ${error}`));
    run(["eval", clickButtonScript("切换到正常状态")]);
    run(["wait", "250"]);
    run(["screenshot", join(evidenceDirectory, `conversation-${viewport}.png`)]);

    run(["eval", clickButtonScript("预览 Agent 界面")]);
    run(["wait", "250"]);
    const management = evaluate<Omit<BrowserSample, "kind" | "placement" | "viewport">>(
      boxScript(
        '[data-testid="system-page"]',
        '[data-testid="management-primary-header"]',
        '[data-testid="agent-detail-scroll"]',
      ),
    );
    samples.push({
      ...management,
      expectedHeaderHeight,
      kind: "management",
      placement: "inside",
      viewport,
    });
    run(["eval", clickButtonScript("切换到断线状态")]);
    run(["wait", "250"]);
    const disconnectedManagementStage = evaluate<FloatingHeaderLayoutSample["stage"]>(
      readBoxScript('[data-testid="system-page"]'),
    );
    stabilityFailures.push(...validateStableLayoutBox(
      management.stage,
      disconnectedManagementStage,
    ).map(error => `management@${viewport}: ${error}`));
    run(["eval", clickButtonScript("切换到正常状态")]);
    run(["wait", "250"]);
    run(["screenshot", join(evidenceDirectory, `management-${viewport}.png`)]);
    run(["eval", clickButtonScript("预览聊天界面")]);
    run(["wait", "250"]);
  }

  const failures = [...stabilityFailures, ...samples.flatMap(sample =>
    validateFloatingHeaderLayout(sample).map(error =>
      `${sample.kind}@${sample.viewport}: ${error}`,
    ),
  )];
  writeFileSync(
    join(evidenceDirectory, "floating-primary-header-boxes.json"),
    `${JSON.stringify({failures, samples}, null, 2)}\n`,
    {mode: 0o600},
  );
  if (failures.length > 0) throw new Error(failures.join("\n"));
  console.log(`floating primary header layout verified: ${samples.length} samples`);
} finally {
  run(["close"], true);
}
