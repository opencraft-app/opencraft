import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv, type PluginOption } from "vite";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Local hot-reload development switch for tea-sdk-lightclaw.
//
// Usage: `pnpm dev:local` (sets VITE_LOCAL_SDK=1) to load SDK directly from
// its `src/` TypeScript sources in a sibling repo checkout. No `npm run build`
// is needed on the SDK side — edits to SDK `.ts/.tsx` trigger Vite HMR
// instantly.
const USE_LOCAL_SDK = process.env.VITE_LOCAL_SDK === "1";
const LOCAL_SDK_ROOT = path.resolve(rootDir, "../../tea-sdk-lightclaw");
const LOCAL_SDK_SRC_ENTRY = path.join(LOCAL_SDK_ROOT, "src/index.ts");
const LOCAL_SDK_STYLES_ENTRY = path.join(LOCAL_SDK_ROOT, "styles/index.css");

/**
 * 本地 lightvela-panel（@tencent/agentchat-lightvela-panel）联调（已停用）
 * ────────────────────────────────────────────────────────────────────────
 * 现已通过 npm 包 @tencent/agentchat-lightvela-panel引入，
 * 走 node_modules 正常解析，无需本地链接。
 *
 * 如需恢复本地联调（开发 AgentChat-web 源码 → mono2 即时看到效果），需：
 *   1. 取消下方 4 块 alias 与 optimizeDeps.exclude 的注释
 *   2. 同步取消 tsconfig.json / tsconfig.app.json 中 paths 的注释
 *   3. 在 AgentChat-web 中先 `pnpm -r build`（仅默认 dist 模式需要）
 *   4. 启动：`pnpm dev:local-agentchat`（src HMR 模式）
 *           或 `pnpm dev:local-all`（联调 SDK + AgentChat-web）
 *
 * 由于 mono2/frontend 与 AgentChat-web 是两个独立的 pnpm 项目，
 * 通过 Vite alias 把 4 个 workspace 包指向 AgentChat-web 内已 build 的 dist。
 * 它们内部的 import（@tencent/agentchat-claw-panel 等）由 pnpm 软链
 * （AgentChat-web/packages/lightvela-panel/node_modules/@tencent/*）解析。
 */
// const AGENTCHAT_WEB_ROOT = path.resolve(rootDir, "../../AgentChat-web");
// const LIGHTVELA_PANEL_PKG = path.join(AGENTCHAT_WEB_ROOT, "packages/lightvela-panel");
// const CLAW_PANEL_PKG = path.join(AGENTCHAT_WEB_ROOT, "packages/claw-panel");
// const CLAW_HOOKS_PKG = path.join(AGENTCHAT_WEB_ROOT, "packages/claw-hooks");
// const CLAW_COMPONENTS_PKG = path.join(AGENTCHAT_WEB_ROOT, "packages/claw-components");

// Local hot-reload development switch for AgentChat-web 4 packages.
//
// Usage: `pnpm dev:local-agentchat` (sets VITE_LOCAL_AGENTCHAT=1) to load the
// 4 claw packages directly from their `src/` TypeScript sources instead of
// `dist/es/index.js`. Edits to claw `.ts/.tsx` trigger Vite HMR instantly,
// no `pnpm -r build` needed on the AgentChat-web side.
//
// Mirrors the VITE_LOCAL_SDK pattern. Combine via `pnpm dev:local-all`.
// const USE_LOCAL_AGENTCHAT = process.env.VITE_LOCAL_AGENTCHAT === "1";
// const AGENTCHAT_SRC_ENTRIES = {
//   components: path.join(CLAW_COMPONENTS_PKG, "src/index.ts"),
//   hooks: path.join(CLAW_HOOKS_PKG, "src/index.ts"),
//   panel: path.join(CLAW_PANEL_PKG, "src/index.ts"),
//   lightvela: path.join(LIGHTVELA_PANEL_PKG, "src/index.tsx"),
// } as const;

/**
 * Polyfill snippet appended to the end of `react-dom`'s CommonJS entry.
 *
 * `@tencent/tea-component` (DomRef.js, ThemeMode.js) and `react-
 * transition-group` call `ReactDOM.findDOMNode()` which React 19 removed.
 * We re-attach a shim directly on `module.exports` — the single mutable
 * object shared by every consumer of `react-dom`.
 *
 * ### findDOMNode semantics
 *
 * `findDOMNode(x)` accepts:
 *   1. A DOM element → returns it as-is
 *   2. A class component *instance* → returns the underlying host DOM
 *   3. null / undefined → returns null
 *
 * For (2), the class component's fiber `stateNode` points back to the
 * component *instance itself* (not a DOM node). We have to walk down
 * `fiber.child` until we hit a HostComponent (tag === 5) whose stateNode
 * IS a DOM node. This mirrors React's pre-19 implementation.
 *
 * This is critical for tea-component: its DomRef, ThemeMode, and
 * react-transition-group wrappers call findDOMNode on class component
 * instances — returning null (as a naive shim would) leaves interactive
 * components (Dropdown, Select, Bubble, Modal triggers) unable to
 * resolve their anchor element, making them appear "dead" to clicks.
 */
const findDOMNodePolyfillSnippet = `
;(function(){
  try {
    if (typeof module !== 'undefined' && module.exports && typeof module.exports.findDOMNode !== 'function') {
      var findDOMNode = function(c) {
        if (c == null) return null;
        // Case 1: already a DOM node
        if (c.nodeType === 1 || c.nodeType === 3) return c;
        // Case 2: class component instance — grab its fiber
        var fiber = c._reactInternals || c._reactInternalFiber;
        if (!fiber) return null;
        // Walk fibers (DFS) until we find a HostComponent or HostText whose
        // stateNode is an actual DOM node. stateNode on class component
        // fibers points back to the instance itself (not the DOM), so we
        // must descend.
        var node = fiber;
        while (node) {
          var sn = node.stateNode;
          if (sn && (sn.nodeType === 1 || sn.nodeType === 3)) return sn;
          if (node.child) { node = node.child; continue; }
          if (node === fiber) return null;
          while (node && !node.sibling) {
            if (!node.return || node.return === fiber) return null;
            node = node.return;
          }
          node = node && node.sibling;
        }
        return null;
      };
      module.exports.findDOMNode = findDOMNode;
    }

    // ── ReactDOM.render / unmountComponentAtNode polyfill ──
    // tea-component 的 Modal.show, notification, message 等工具方法
    // 在命令式 API 中调用 ReactDOM.render(element, container)，
    // React 19 已移除该 API。用 createRoot 桥接。
    var ex = module.exports;
    if (typeof ex.render !== 'function') {
      var rootMap = new Map();
      var clientMod = null;
      function getClient() {
        if (!clientMod) clientMod = require('react-dom/client');
        return clientMod;
      }
      ex.render = function(element, container, callback) {
        var client = getClient();
        var root = rootMap.get(container);
        if (!root) {
          root = client.createRoot(container);
          rootMap.set(container, root);
        }
        root.render(element);
        if (typeof callback === 'function') setTimeout(callback, 0);
      };
      ex.unmountComponentAtNode = function(container) {
        var root = rootMap.get(container);
        if (root) {
          root.unmount();
          rootMap.delete(container);
          return true;
        }
        return false;
      };
    }
  } catch (_) { /* ignore */ }
})();
`;

/**
 * Vite plugin: transform SDK i18n CJS translation files to ESM on the fly.
 *
 * `i18n/translation/en.js` / `zh.js` are CJS (`module.exports = {...}`).
 * In dev mode Vite serves them as ESM → "module is not defined".
 * Fix: rewrite `module.exports = { translation }` → `export { translation }`.
 */
function sdkI18nPlugin() {
  return {
    name: "sdk-i18n-plugin",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!/i18n[\\/]translation[\\/](en|zh)\.js$/.test(id)) return null;
      const transformed = code
        .replace(/module\.exports\s*=\s*\{\s*translation\s*:\s*translation\s*\}\s*;?/, "export { translation };");
      if (transformed === code) return null;
      return { code: transformed, map: null };
    },
  };
}

function reactDomFindDOMNodeEsbuildPlugin() {
  return {
    name: "react-dom-findDOMNode-esbuild",
    setup(build: any) {
      build.onLoad(
        { filter: /[\\/]react-dom[\\/]index\.js$/ },
        async (args: { path: string }) => {
          const source = await fs.promises.readFile(args.path, "utf8");
          return {
            contents: source + findDOMNodePolyfillSnippet,
            loader: "js" as const,
          };
        },
      );
    },
  };
}

/**
 * Vite plugin: also append the polyfill to `react-dom` on the fly, including
 * any deps chunks that Vite may re-generate mid-session (esbuild injection
 * only covers the initial pre-bundle pass — secondary optimize rounds skip
 * custom plugins).
 *
 * Chunks live under `node_modules/.vite/deps/chunk-*.js` once Vite has
 * pre-bundled them. We match on file contents (the generated chunk contains
 * `require_react_dom = __commonJS({ "node_modules/.pnpm/react-dom.../index.js"(`)
 * and inject the shim inside that CommonJS wrapper factory.
 */
function reactDomFindDOMNodeVitePlugin() {
  return {
    name: "react-dom-findDOMNode-vite",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!id.includes("/.vite/deps/")) return null;
      // Match the factory for react-dom's own index.js (not react-dom-client,
      // not react-dom.development, etc.). The wrapped source contains:
      //   "node_modules/.../react-dom/index.js"(exports, module) { ... }
      const marker = '/react-dom/index.js"(exports, module) {';
      const idx = code.indexOf(marker);
      if (idx === -1) return null;
      // Find the matching closing of the factory function body. The body
      // ends at the last `}` before `});` — but simpler: append the shim
      // just before the CJS factory's terminator `}`. Search for the end
      // of the factory (marker of next `}` that closes the factory scope).
      // Robust strategy: re-wrap with a post-factory hook using a require
      // proxy. But easier: append the shim via adding a new statement at
      // module top-level *after* `require_react_dom` is defined.
      //
      // `var require_react_dom = __commonJS({...});` is immediately followed
      // by more code. Inject our IIFE right after that assignment.
      const factoryEnd = code.indexOf(
        "});",
        idx + marker.length,
      );
      if (factoryEnd === -1) return null;
      // Find the final `;` after `});` that closes the `var require_react_dom = __commonJS({...});`
      const stmtEnd = code.indexOf(";", factoryEnd);
      if (stmtEnd === -1) return null;

      const injection = `
;(function(){
  try {
    var __rd = require_react_dom && require_react_dom();
    if (__rd && typeof __rd.findDOMNode !== 'function') {
      __rd.findDOMNode = function(c) {
        if (c == null) return null;
        if (c.nodeType === 1 || c.nodeType === 3) return c;
        var fiber = c._reactInternals || c._reactInternalFiber;
        if (!fiber) return null;
        var node = fiber;
        while (node) {
          var sn = node.stateNode;
          if (sn && (sn.nodeType === 1 || sn.nodeType === 3)) return sn;
          if (node.child) { node = node.child; continue; }
          if (node === fiber) return null;
          while (node && !node.sibling) {
            if (!node.return || node.return === fiber) return null;
            node = node.return;
          }
          node = node && node.sibling;
        }
        return null;
      };
    }
    if (__rd && typeof __rd.render !== 'function') {
      var __rootMap = new Map();
      var __client = null;
      function __getClient() {
        if (!__client) __client = require_react_dom_client ? require_react_dom_client() : null;
        return __client;
      }
      __rd.render = function(el, container, cb) {
        var cl = __getClient();
        if (!cl) return;
        var root = __rootMap.get(container);
        if (!root) { root = cl.createRoot(container); __rootMap.set(container, root); }
        root.render(el);
        if (typeof cb === 'function') setTimeout(cb, 0);
      };
      __rd.unmountComponentAtNode = function(container) {
        var root = __rootMap.get(container);
        if (root) { root.unmount(); __rootMap.delete(container); return true; }
        return false;
      };
    }
  } catch (_) {}
})();
`;
      return {
        code:
          code.slice(0, stmtEnd + 1) + injection + code.slice(stmtEnd + 1),
        map: null,
      };
    },
  };
}

/**
 * Rollup plugin: inject polyfill into the PRODUCTION build output.
 *
 * ## 问题
 *
 * Rollup 生产构建中 react-dom 的加载链路（minified）：
 *
 *   var To = K0();              // CJS factory → 可写的 module.exports
 *   const yo = Ha(To);          // getDefaultExportFromCjs → yo === To
 *   tea-component: yo.findDOMNode(this)  →  💥 React 19 删了
 *
 * ## 为什么之前的方案不行
 *
 * - 运行时 `import * as ReactDOM` 拿到的是冻结的 ESM namespace（不可写）
 * - 拦截 `Object.freeze` 没用（`To` 本身不经过 freeze）
 * - 重写 `Ha` 函数没用（ESM 模块顶层 `function` 声明是不可变绑定）
 *
 * ## 最终策略
 *
 * 在 minify 后的产物中，用正则找到 react-dom CJS factory 的调用：
 *   `var To=K0()`（react-dom/index.js 的 CJS 包装器结果）
 * 在赋值语句**之后**直接注入 patch 代码：
 *   `if(To&&To.createElement&&!To.findDOMNode){To.findDOMNode=...}`
 *
 * `To` 是 CJS `module.exports`，始终可写。patch 后 `Ha(To)` 返回的
 * `yo` 上就有 `findDOMNode` 了。注意：开启 manualChunks 后 react-dom
 * 可能进入 vendor chunk，因此不能只处理 entry chunk。
 */
function reactDomPolyfillBuildPlugin() {
  // findDOMNode shim —— Fiber DFS（和 dev 模式完全一致）
  const findDOMNodeShim = `function(c){if(c==null)return null;if(c.nodeType===1||c.nodeType===3)return c;var f=c._reactInternals||c._reactInternalFiber;if(!f)return null;var n=f;while(n){var s=n.stateNode;if(s&&(s.nodeType===1||s.nodeType===3))return s;if(n.child){n=n.child;continue}if(n===f)return null;while(n&&!n.sibling){if(!n.return||n.return===f)return null;n=n.return}n=n&&n.sibling}return null}`;

  return {
    name: "react-dom-polyfill-build",
    apply: "build" as const,
    renderChunk: {
      order: "post" as const,
      handler(code: string) {
        if (!code.includes("createElement")) return null;

        // 收集所有需要注入 patch 的位置（从后往前插入，避免偏移错乱）
        const patches: { pos: number; text: string }[] = [];

        // 精确模式：`var <cjs>=<factory>();const <esm>=<Ga>(<cjs>),<ns>=<sue>({__proto__:null,default:<esm>},[<cjs>])`
        // 使用 [\w$]+ 匹配 JS 标识符（Rollup 可能生成含 $ 的变量名如 $0）
        const precisePattern = /var ([\w$]+)=([\w$]+)\(\);const ([\w$]+)=([\w$]+)\(\1\),([\w$]+)=([\w$]+)\(\{__proto__:null,default:\3\},\[\1\]\)/g;
        let m;
        while ((m = precisePattern.exec(code)) !== null) {
          const [fullMatch, cjsVar, , esmVar] = m;
          const insertPos = m.index + fullMatch.length;
          const patch = `;if(typeof ${cjsVar}.findDOMNode!=="function"){try{${cjsVar}.findDOMNode=${findDOMNodeShim}}catch(e){}}if(${cjsVar}!==${esmVar}&&typeof ${esmVar}.findDOMNode!=="function"){try{${esmVar}.findDOMNode=${findDOMNodeShim}}catch(e){}}if(typeof ${cjsVar}.render!=="function"){var __rm${patches.length}=new Map();${cjsVar}.render=function(el,ct,cb){var r=__rm${patches.length}.get(ct);if(!r){try{var cl=require("react-dom/client");r=cl.createRoot(ct);__rm${patches.length}.set(ct,r)}catch(e2){return}}r.render(el);typeof cb==="function"&&setTimeout(cb,0)};${cjsVar}.unmountComponentAtNode=function(ct){var r=__rm${patches.length}.get(ct);if(r){r.unmount();__rm${patches.length}.delete(ct);return true}return false};if(${cjsVar}!==${esmVar}){try{${esmVar}.render=${cjsVar}.render;${esmVar}.unmountComponentAtNode=${cjsVar}.unmountComponentAtNode}catch(e){}}}`;
          patches.push({ pos: insertPos, text: patch });
        }

        // Fallback：宽泛模式 `var <cjs>=<factory>();const <esm>=<Ga>(<cjs>)`
        // 仅匹配未被精确模式覆盖的位置
        const fallbackPattern = /var ([\w$]+)=([\w$]+)\(\);const ([\w$]+)=[\w$]+\(\1\)/g;
        while ((m = fallbackPattern.exec(code)) !== null) {
          const [fullMatch, cjsVar] = m;
          const insertPos = m.index + fullMatch.length;
          // 跳过已被精确模式覆盖的位置
          if (patches.some((p) => Math.abs(p.pos - insertPos) < 50)) continue;
          // 验证后面紧跟 `{__proto__:null`（确认是 react-dom 相关模块）
          const after = code.substring(m.index, m.index + 500);
          if (!after.includes("__proto__:null")) continue;
          const patch = `;if(${cjsVar}&&typeof ${cjsVar}.findDOMNode!=="function"){${cjsVar}.findDOMNode=${findDOMNodeShim}}`;
          patches.push({ pos: insertPos, text: patch });
        }

        if (patches.length === 0) return null;

        // 从后往前插入，保证偏移不错乱
        patches.sort((a, b) => b.pos - a.pos);
        let result = code;
        for (const p of patches) {
          result = result.slice(0, p.pos) + p.text + result.slice(p.pos);
        }

        return { code: result, map: null };
      },
    },
  };
}

function manualChunks(id: string) {
  if (!id.includes("node_modules")) return undefined;

  if (/[\\/]node_modules[\\/](?:\.pnpm[\\/])?(?:react|react-dom|react-router|react-router-dom|scheduler)[@\\/]/.test(id)) {
    return "vendor-framework";
  }
  if (id.includes("framer-motion")) return "vendor-motion";
  if (id.includes("@xterm/")) return "vendor-terminal";
  if (
    id.includes("@tencent/tcb-jssdk")
    || id.includes("@tencent+i18n")
    || id.includes("@tencent/i18n")
  ) {
    return "vendor-wxpay";
  }
  if (
    id.includes("react-markdown")
    || id.includes("react-syntax-highlighter")
    || id.includes("remark-")
    || id.includes("rehype-")
    || id.includes("micromark")
    || id.includes("mdast-")
    || id.includes("hast-")
    || id.includes("unified")
  ) {
    return "vendor-docs";
  }
  if (
    id.includes("@tencent/tea-sdk-lightclaw")
    || id.includes("tea-component")
    || id.includes("tea-style")
    || id.includes("tea-app")
  ) {
    return "vendor-tea";
  }
  if (id.includes("html2canvas")) return "vendor-capture";
  // 注意：曾经把 @radix-ui / lucide-react / clsx / tailwind-merge / cva
  // 拆成 vendor-ui chunk，但拆包后会出现 "U is not a function" 运行时错误：
  // 这些是被业务代码 named-import 的纯函数库，跨 chunk 引用时初始化顺序
  // 不可靠，Rollup 又无法在所有调用点正确插入 init wrapper。
  // 解法：让它们留在调用方所在 chunk（业务主 chunk）里，由 Rollup
  // 自动处理跨 chunk 引用。

  return undefined;
}

export default defineConfig(({ mode }) => {
  /* 读取 .env / .env.local / .env.development 里以 VITE_DEV_ 开头的变量
   * 这样 dev server 的网络配置可以针对不同开发者/不同调试方式灵活切换，
   * 且不会影响 `vite build` 构建产物。*/
  const env = loadEnv(mode, rootDir, "VITE_DEV_");

  const devHost = env.VITE_DEV_HOST || "127.0.0.1";
  const devPort = Number(env.VITE_DEV_PORT || 5173);

  /* 逗号分隔，例如：VITE_DEV_ALLOWED_HOSTS=lightclaw.site,.lightclaw.site
   * 默认已放行 Cloudflare Pages 正式域 / 预览域以及自有域 lightclaw.site，
   * 便于通过 cloudflared tunnel 将线上域名反代到本地 vite server 调试。
   * `.xxx` 前缀表示泛匹配所有子域，包括 Cloudflare Pages 的 <commit>.<project>.pages.dev 预览链接 */
  const defaultAllowedHosts = [
    "lightclaw.pages.dev",
    ".pages.dev",
    "lightvela.tencent.com",
    "lightvela.ai",
    "lightvela.com",
    "lightclaw.site",
    ".lightclaw.site",
  ];
  const extraAllowedHosts = (env.VITE_DEV_ALLOWED_HOSTS || "")
    .split(",")
    .map((h: string) => h.trim())
    .filter(Boolean);
  const allowedHosts = Array.from(
    new Set([...defaultAllowedHosts, ...extraAllowedHosts]),
  );

  /* 只有显式配置了 HMR 外部域名（比如 whistle 代理到 lightclaw.site）才开启远程 HMR，
   * 否则走 vite 默认逻辑（localhost:5173 直连）。*/
  const hmrHost = env.VITE_DEV_HMR_HOST;
  const hmr = hmrHost
    ? {
      host: hmrHost,
      protocol: env.VITE_DEV_HMR_PROTOCOL || "wss",
      clientPort: Number(env.VITE_DEV_HMR_CLIENT_PORT || 443),
    }
    : undefined;

  return {
    // tea-app i18n.init() 内部引用了 PRODUCTION / INTL_TRANSLATION_ID 全局变量
    // （webpack 环境由 DefinePlugin 注入），Vite 需要显式 define。
    define: {
      PRODUCTION: JSON.stringify(mode === "production"),
      INTL_TRANSLATION_ID: JSON.stringify(""),
    },
    plugins: [
      react(),
      tailwindcss(),
      sdkI18nPlugin(),
      reactDomFindDOMNodeVitePlugin(),
      reactDomPolyfillBuildPlugin(),
    ] as unknown as PluginOption[],
    resolve: {
      // Deduplicate React so the locally-linked SDK shares the host app's copy
      dedupe: ["react", "react-dom"],
      alias: [
        {
          find: /^react-syntax-highlighter$/,
          replacement: path.resolve(rootDir, "src/vendor/react-syntax-highlighter-shim.ts"),
        },
        {
          find: /^property-information\/(find|normalize|html|svg)$/,
          replacement: path.resolve(
            rootDir,
            "node_modules/.pnpm/property-information@5.6.0/node_modules/property-information/$1.js",
          ),
        },
        {
          find: /^@\//,
          replacement: `${path.resolve(rootDir, "./src")}/`,
        },
        // i18n 词条是 CJS 文件，需精确 alias 到实际路径。
        // 注意：此条必须在 SDK 主入口 alias 之前，否则会被前缀匹配拦截。
        {
          find: "@tencent/tea-sdk-lightclaw/i18n/translation/en",
          replacement: USE_LOCAL_SDK
            ? path.join(LOCAL_SDK_ROOT, "i18n/translation/en.js")
            : path.resolve(rootDir, "node_modules/@tencent/tea-sdk-lightclaw/i18n/translation/en.js"),
        },
        {
          find: "@tencent/tea-sdk-lightclaw/i18n/translation/zh",
          replacement: USE_LOCAL_SDK
            ? path.join(LOCAL_SDK_ROOT, "i18n/translation/zh.js")
            : path.resolve(rootDir, "node_modules/@tencent/tea-sdk-lightclaw/i18n/translation/zh.js"),
        },
        // dev:local 模式：指向 SDK 本地源码，改代码即时 HMR。
        // npm 包模式：不需要 alias，Vite 通过 package.json exports 自动解析。
        // 注意：alias 顺序很关键 —— 子路径必须排在主入口 alias 之前，
        // 因为 Vite alias 是前缀匹配，主入口写在前面会拦截子路径请求。
        ...(USE_LOCAL_SDK
          ? [
            {
              find: "@tencent/tea-sdk-lightclaw/scripts",
              replacement: path.join(LOCAL_SDK_ROOT, "src/scripts/index.ts"),
            },
            {
              find: "@tencent/tea-sdk-lightclaw/styles",
              replacement: LOCAL_SDK_STYLES_ENTRY,
            },
            {
              find: "@tencent/tea-sdk-lightclaw",
              replacement: LOCAL_SDK_SRC_ENTRY,
            },
          ]
          : []),

        // ── 本地 lightvela-panel 联调（已停用，详见文件顶部说明） ──
        // 当前走 npm 包 @tencent/agentchat-lightvela-panel@0.2.5-beta.0，
        // 由 node_modules 自动解析，无需 alias。
        //
        // 如需恢复本地联调，取消下方注释（顺序：子包在前，主包在后，
        // 因为 Vite alias 是前缀匹配）。
        // {
        //   find: "@tencent/agentchat-claw-components",
        //   replacement: USE_LOCAL_AGENTCHAT
        //     ? AGENTCHAT_SRC_ENTRIES.components
        //     : path.join(CLAW_COMPONENTS_PKG, "dist/es/index.js"),
        // },
        // {
        //   find: "@tencent/agentchat-claw-hooks",
        //   replacement: USE_LOCAL_AGENTCHAT
        //     ? AGENTCHAT_SRC_ENTRIES.hooks
        //     : path.join(CLAW_HOOKS_PKG, "dist/es/index.js"),
        // },
        // {
        //   find: "@tencent/agentchat-claw-panel",
        //   replacement: USE_LOCAL_AGENTCHAT
        //     ? AGENTCHAT_SRC_ENTRIES.panel
        //     : path.join(CLAW_PANEL_PKG, "dist/es/index.js"),
        // },
        // {
        //   find: "@tencent/agentchat-lightvela-panel",
        //   replacement: USE_LOCAL_AGENTCHAT
        //     ? AGENTCHAT_SRC_ENTRIES.lightvela
        //     : path.join(LIGHTVELA_PANEL_PKG, "dist/es/index.js"),
        // },
      ],
    },
    server: {
      host: devHost,
      port: devPort,
      ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
      ...(hmr ? { hmr } : {}),
      proxy: {
        "/auth/session": {
          target: "https://lightclaw.tech",
          changeOrigin: true,
        },
        "/auth/profile": {
          target: "https://lightclaw.tech",
          changeOrigin: true,
        },
        "/auth/sms": {
          target: "https://lightclaw.tech",
          changeOrigin: true,
        },
        "/auth/invite": {
          target: "https://lightclaw.tech",
          changeOrigin: true,
        },
        "/auth/realname": {
          target: "https://lightclaw.tech",
          changeOrigin: true,
        },
        "/auth/tat": {
          target: "https://lightclaw.tech",
          changeOrigin: true,
        },
        "/auth/guest": {
          target: "https://lightclaw.tech",
          changeOrigin: true,
        },
        "/subscriptions": {
          target: "https://lightclaw.tech",
          changeOrigin: true,
        },
        "/users": {
          target: "https://lightclaw.tech",
          changeOrigin: true,
        },
        "/v1": {
          target: "https://lightclaw.tech",
          changeOrigin: true,
        },
        "/sandboxes": {
          target: "https://lightclaw.tech",
          changeOrigin: true,
        },
        "/__skillhub": {
          target: "https://lightmake.cloud",
          changeOrigin: true,
          rewrite: (url) => url.replace(/^\/__skillhub/, ""),
        },
      },
      fs: {
        // Allow Vite to serve files from the sibling SDK checkout when linked.
        // 如需恢复 AgentChat-web 本地联调，需在此追加 AGENTCHAT_WEB_ROOT。
        allow: [rootDir, LOCAL_SDK_ROOT],
      },
    },
    /* vite preview 使用独立的 preview 配置，不会继承 server.allowedHosts，
     * 这里显式同步一份，避免通过 tunnel 反代到 `vite preview` 时被拦截 */
    preview: {
      host: devHost,
      port: devPort,
      ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    },
    build: {
      rollupOptions: {
        output: {
          // Keep vendor boundaries coarse and stable; route-level dynamic
          // imports own page chunks, while this function keeps shared deps
          // cacheable without binding chunks to page file names.
          manualChunks,
        },
      },
    },
    optimizeDeps: {
      // dev:local 走源码 HMR → 排除预打包；
      // npm 包模式：SDK 自身有 ESM 产出，但其依赖（tea-component、
      // tea-style-lighthouse 等）是 CJS + 带 CSS/SVG/TTF 资源的老包，
      // 必须纳入预打包让 esbuild 统一处理，否则 Vite 会把深路径 CSS
      // 当成直接文件请求，在非本地环境下解析失败。
      exclude: [
        ...(USE_LOCAL_SDK ? ["@tencent/tea-sdk-lightclaw"] : []),
        // 本地 AgentChat-web 联调已停用，走 npm 包正常预打包。
        // 如需恢复本地源码 HMR 模式，取消注释以排除预打包冻结：
        // ...(USE_LOCAL_AGENTCHAT
        //   ? [
        //     "@tencent/agentchat-claw-components",
        //     "@tencent/agentchat-claw-hooks",
        //     "@tencent/agentchat-claw-panel",
        //     "@tencent/agentchat-lightvela-panel",
        //   ]
        //   : []),
      ],
      include: USE_LOCAL_SDK
        ? []
        : [
          "@tencent/tea-sdk-lightclaw",
          // i18n 词条是 CJS（module.exports），需纳入预打包转 ESM
          "@tencent/tea-sdk-lightclaw/i18n/translation/en",
        ],
      esbuildOptions: {
        plugins: [reactDomFindDOMNodeEsbuildPlugin()],
        // tea-style-lighthouse 的 CSS 引用了相对路径的 .svg / .ttf 等资源，
        // esbuild 预打包默认不认识这些文件类型。用 dataurl loader 把它们
        // 内联为 data URI，和 webpack 的 url-loader 行为一致。
        loader: {
          ".svg": "dataurl",
          ".ttf": "dataurl",
          ".woff": "dataurl",
          ".woff2": "dataurl",
          ".png": "dataurl",
          ".jpg": "dataurl",
          ".gif": "dataurl",
        },
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
    },
  };
});
