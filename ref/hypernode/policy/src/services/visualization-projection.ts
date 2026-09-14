import { Service, type Inject } from "@deepseek-ai/cordis";
import { utf8Encode } from "../runtime/bytes.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  VisualizationInvocation,
  VisualizationProjectionPort,
} from "../types/visualization.ts";
import { nativeKnownGoodVisualizationHtml } from "./native-known-good-visualization.ts";

export const VISUALIZATION_PUBLIC_ROOT = "/workspace/.codex/visualizations";
const VISUALIZATION_CONTROL_ROOT = "/localhost/.codex/visualizations";

type Dependencies = "userDirectory" | "virtualFilesystem";

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safePathSegment(value: unknown): string {
  return String(value ?? "thread").replace(/[^A-Za-z0-9_-]+/g, "-") || "thread";
}

function visualizationDatePath(threadId: unknown): string {
  const uuidV7 = String(threadId ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuidV7)) {
    throw new Error("inline visualization requires a UUIDv7 thread id");
  }
  const timestamp = Number.parseInt(`${uuidV7.slice(0, 8)}${uuidV7.slice(9, 13)}`, 16);
  const date = new Date(timestamp);
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("/");
}

export function helloWorldHtml(username: unknown = "friend"): string {
  const safeUsername = escapeHtml(username);
  return `<div id="hypernode-hello-world">
  <style>
    #hypernode-hello-world { box-sizing: border-box; min-height: 210px; padding: 26px;
      color: light-dark(#202123, #f4f4f5); font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      border: 1px solid light-dark(#dedede, #3f3f46); border-radius: 20px;
      background: linear-gradient(135deg, light-dark(#f8fbff, #18181b), light-dark(#eef6ff, #172033)); }
    #hypernode-hello-world * { box-sizing: border-box; }
    #hypernode-hello-world .eyebrow { color: #2f80ed; font-size: 13px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
    #hypernode-hello-world h1 { margin: 10px 0 8px; font-size: clamp(28px, 7vw, 48px); line-height: 1; }
    #hypernode-hello-world p { margin: 0; color: light-dark(#5f6368, #b4b4bd); font-size: 15px; }
    #hypernode-hello-world button { display: inline-block; margin-top: 24px; border: 0; border-radius: 999px;
      padding: 10px 16px; color: white; background: #2f80ed; font: inherit; font-weight: 700; cursor: pointer; }
    #hypernode-hello-world button:hover { background: #176dcc; }
    #hypernode-hello-status { display: inline-block; margin-left: 12px; color: #2f80ed; font-size: 14px; }
  </style>

  <div class="eyebrow">HyperNode · Native inline visualization</div>
  <h1>Hello, ${safeUsername} 👋</h1>
  <p>这个网页来自 SSH 节点，通过 Codex Desktop 原生沙箱渲染；Desktop 没有被修改。</p>
  <button type="button">点我试试</button>
  <span id="hypernode-hello-status" aria-live="polite"></span>

  <script>
    (() => {
      const root = document.getElementById("hypernode-hello-world");
      const button = root.querySelector("button");
      const status = root.querySelector("#hypernode-hello-status");
      button.addEventListener("click", () => {
        status.textContent = "Hello World! 页面内交互正常。";
      });
    })();
  <\/script>
</div>`;
}

export function inlineVisualizationDirective(path: string): string {
  // Keep this byte-for-byte aligned with the native Desktop token emitted by
  // the bundled visualize skill. `mode: "wide"` selects a separate portal
  // layout path and is not an innocuous hint for SSH-hosted fragments.
  return `visualize${JSON.stringify({ path })}`;
}

export function materializeHelloWorld(
  ctx: HypernodeContext<Dependencies>,
  invocation: VisualizationInvocation = {},
): string {
  const identityId = invocation.connection?.identity?.id;
  const user = typeof identityId === "string" ? ctx.userDirectory.find(identityId) : null;
  if (!user?.username) {
    throw new Error("inline visualization requires an authenticated SSH user");
  }

  const threadSegment = safePathSegment(invocation.threadId);
  const turnSegment = safePathSegment(invocation.turnId ?? "latest");
  const datePath = visualizationDatePath(invocation.threadId);
  const publicDirectory = `${VISUALIZATION_PUBLIC_ROOT}/${datePath}/${threadSegment}`;
  const controlDirectory = `${VISUALIZATION_CONTROL_ROOT}/${datePath}/${threadSegment}`;
  // Visualization messages are durable, so their assets must be immutable.
  // A Turn-scoped slug preserves the native one-message/one-file contract.
  const fileName = `hello-world-${turnSegment}.html`;
  const publicPath = `${publicDirectory}/${fileName}`;
  const controlPath = `${controlDirectory}/${fileName}`;

  ctx.virtualFilesystem.createDirectory({ path: controlDirectory, recursive: true }, user);
  ctx.virtualFilesystem.writeFile(
    { path: controlPath },
    utf8Encode(nativeKnownGoodVisualizationHtml),
    user,
  );

  return [
    "这是由 HyperNode SSH Host 提供的原生内嵌网页：",
    "",
    inlineVisualizationDirective(publicPath),
  ].join("\n");
}

export class VisualizationProjectionService extends Service implements VisualizationProjectionPort {
  static inject = ["userDirectory", "virtualFilesystem"] satisfies
    Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "visualizationProjection");
  }

  helloWorld(invocation: VisualizationInvocation = {}): string {
    return materializeHelloWorld(this.ctx, invocation);
  }
}
