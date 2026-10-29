import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".scss"]);

function collectFiles(directory) {
  if (statSync(directory).isFile()) return [directory];
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...collectFiles(path));
    else if ([...sourceExtensions].some((extension) => path.endsWith(extension))) files.push(path);
  }
  return files;
}

const violations = [];

// Menu activation and focus are a shared contract; business code cannot import
// Radix menus behind the adapter.
for (const directory of ["apps/workbench-web/src", "packages", "plugins"]) {
  for (const path of collectFiles(resolve(repositoryRoot, directory))) {
    const location = relative(repositoryRoot, path);
    if (location.startsWith("packages/design-system-web/")) continue;
    const source = readFileSync(path, "utf8");
    if (/["']@radix-ui\/react-(?:dropdown-menu|context-menu)["']/.test(source)) {
      violations.push(`${location}: command menus must consume design-system-web dropdown-menu/context-menu`);
    }
  }
}

// Shared workbench code consumes SpeechServicePort/AudioCapturePort. Product
// bridge globals, authenticated routes and fixed product model policy belong
// to downstream adapters rather than the public embedded host.
checkFiles("shared voice composition", "apps/workbench-web/src", [{
  pattern: /__LIGHTVELA_BOT_(?:RUNTIME_ID|POST)__/m,
  message: "must receive native audio through a capture port, not product bootstrap globals",
}, {
  pattern: /\/api\/speech\//m,
  message: "must receive the product speech service through its public port",
}, {
  pattern: /["']ep-hyasr3["']/m,
  message: "must not select a fixed product speech model in the shared workbench",
}]);

checkFiles("shared styles", "apps/workbench-web/src/styles", [{
  pattern: /url\(\s*["']?\/lightvela-intl-home\//m,
  message: "must not select product artwork; compose product styles in the explicit product entry",
}, {
  pattern: /\.lightvela-(?:login|management|bot-creation)/m,
  message: "must not own private login, management or onboarding styles; compose them downstream",
}]);
checkFiles("shared icon presentation", "packages/design-system/src/icons.web.scss", [{
  pattern: /data-workbench-product/m,
  message: "must select declared icon presentation, not product identity",
}]);
checkFiles("startup resource policy", "apps/workbench-web/startup-resource-policy.vite.ts", [{
  pattern: /lightvela|enterprise-identity/m,
  message: "must accept private roots and exclusions from trusted build composition",
}]);

// Public development commands must remain usable without a product checkout.
// Product probes and source synchronizers are owned by their downstream workspace.
checkFiles("public tool", "scripts", [{
  pattern: /["'](?:\.\.\/)+(?:products|frontend)(?:\/|["'])/m,
  message: "must not load a private product workspace; keep the tool downstream",
}, {
  pattern: /\b(?:join|resolve)\([^;\n]*["'](?:products|frontend)(?:\/|["'])/m,
  message: "must not select private product source roots; keep the tool downstream",
}, {
  pattern: /\b(?:lightVelaApiBase|enableLightVelaCollaboration)\s*:/m,
  message: "must use the public clientProduct port instead of removed product bootstrap options",
}]);
for (const directory of ["apps/workbench-web/src/components/workbench-tool-navigation.tsx", "apps/workbench-web/src/runtime/workbench-tool-pages.ts"]) {
  checkFiles("workbench tool projection", directory, [{
    pattern: /lightvela\.hermes\.(?:skills|storage)/m,
    message: "must consume declared management entry points, not private page IDs",
  }]);
}
checkFiles("public Expo tool", "apps/mobile/scripts", [{
  pattern: /mobile-bot-runtime\.html|native-cron-client\.js/m,
  message: "must not depend on downstream Bot/Cron generated artifacts; keep the probe with its product builder",
}]);
const publicScripts = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).scripts;
checkFiles("public browser fixture", "tests/fixtures", [{
  pattern: /(?:from\s*|import\s*)["'][^"']*\/lightvela-web-bootstrap(?:\.[cm]?[jt]s)?["']/m,
  message: "must supply navigation policy through the public port, not a removed private bootstrap",
}]);
for (const [name, command] of Object.entries(publicScripts)) {
  if (/\.\.\/(?:products|frontend)(?:\/|$)/.test(command)) {
    violations.push(`package.json scripts.${name}: public command must not select a private product workspace`);
  }
}

function checkFiles(label, directory, rules) {
  for (const path of collectFiles(resolve(repositoryRoot, directory))) {
    const source = readFileSync(path, "utf8");
    for (const rule of rules) {
      if (rule.pattern.test(source)) {
        violations.push(`${relative(repositoryRoot, path)}: ${label} ${rule.message}`);
      }
    }
  }
}

const purePackageRules = [
  {
    pattern: /(?:from\s*|import\s*)["'](?:react(?:-dom|-native)?|expo(?:\/|["'])|expo-router|prosemirror-|lucide-react)/m,
    message: "must not import a renderer or UI framework",
  },
  {
    pattern: /(?:(?<![\w.])(?:window|document|localStorage)\s*(?:\.|\[)|\btypeof\s+(?:window|document|localStorage)\b|\b(?:HTMLElement|HTMLInputElement)\b|\bnew\s+File\s*\()/,
    message: "must not reference browser globals; use a host port",
  },
  {
    pattern: /(?:from\s*|import\s*)["'][^"']*\/apps\//m,
    message: "must not import from an app host",
  },
];

for (const directory of [
  "packages/appserver-protocol/src",
  "packages/document-storage/src/contract.ts",
  "packages/identity-core/src",
  "packages/access-control/src",
  "packages/relay-protocol/src",
  "packages/hub-network/src",
  "packages/browser-core/src",
  "packages/file-preview-core/src",
  "packages/chat-core/src",
  "packages/chat-document/src",
  "packages/composer-core/src",
  "packages/design-system/src",
  "packages/extension-contract/src",
  "packages/extension-runtime/src",
  "packages/timeline-virtualizer/src",
  "packages/workbench-runtime/src",
  "plugins/cloud-desktop/src/contract.ts",
]) {
  checkFiles("shared package", directory, purePackageRules);
}

for (const directory of ['packages/identity-core/src', 'packages/access-control/src', 'packages/relay-protocol/src', 'packages/hub-network/src']) {
  checkFiles('identity/authorization core', directory, [{
    pattern: /(?:from\s*|import\s*)["'](?:@opencraft\/plugin-|[^"']*\/plugins\/)/m,
    message: 'must consume generic verified identities, never import a provider plugin',
  }]);
}

checkFiles("shared React renderer", "packages/chat-render-react/src", [
  {
    pattern: /(?:from\s*|import\s*)["'](?:react-dom|react-native|expo(?:\/|["'])|expo-router|lucide-react)/m,
    message: "must not import a platform renderer",
  },
  {
    pattern: /(?:(?<![\w.])(?:window|document|localStorage)\s*(?:\.|\[)|\btypeof\s+(?:window|document|localStorage)\b|\b(?:HTMLElement|HTMLInputElement)\b)/,
    message: "must not reference browser globals",
  },
  {
    pattern: /(?:from\s*|import\s*)["'][^"']+\.s?css["']/m,
    message: "must not import platform styles",
  },
]);

checkFiles("Web chat renderer", "packages/chat-render-web/src", [
  {
    pattern: /(?:from\s*|import\s*)["'](?:react-native|expo(?:\/|["'])|expo-router)/m,
    message: "must not import Expo or React Native",
  },
]);

checkFiles("Web timeline host", "packages/timeline-host-web/src", [
  {
    pattern: /(?:from\s*|import\s*)["'](?:react-native|expo(?:\/|["'])|expo-router)/m,
    message: "must not import Expo or React Native",
  },
]);

checkFiles("Web design system adapter", "packages/design-system-web/src", [
  {
    pattern: /(?:from\s*|import\s*)["'](?:react-native|expo(?:\/|["'])|expo-router)/m,
    message: "must not import Native renderers",
  },
  {
    pattern: /(?:from\s*|import\s*)["'][^"']*\/apps\//m,
    message: "must not import from an app host",
  },
]);

checkFiles("Native chat renderer", "packages/chat-render-native/src", [
  {
    pattern: /(?:from\s*|import\s*)["'](?:react-dom|shiki|katex|mermaid)/m,
    message: "must not import DOM or Web-only heavy renderers",
  },
  {
    pattern: /(?:from\s*|import\s*)["'][^"']+\.s?css["']/m,
    message: "must not import Web styles",
  },
  {
    pattern: /(?:(?<![\w.])(?:window|document|localStorage)\s*(?:\.|\[)|\btypeof\s+(?:window|document|localStorage)\b|\b(?:HTMLElement|HTMLInputElement)\b)/,
    message: "must not reference browser globals",
  },
]);

for (const directory of [
  "packages/appserver-client/src",
  "packages/appserver-replica/src",
  "packages/appserver-session/src",
  "packages/chat-runtime/src",
  "packages/composer-appserver/src",
  "packages/appserver-transport-memory/src",
  "packages/appserver-transport-replay/src",
]) {
  checkFiles("renderer-neutral runtime package", directory, [
    {
      pattern: /(?:from\s*|import\s*)["'](?:react(?:-dom|-native)?|expo(?:\/|["'])|expo-router|prosemirror-|lucide-react)/m,
      message: "must not import a renderer or UI framework",
    },
    {
      pattern: /(?:(?<![\w.])(?:window|document|localStorage)\s*(?:\.|\[)|\btypeof\s+(?:window|document|localStorage)\b|\b(?:HTMLElement|HTMLInputElement)\b|\bnew\s+File\s*\()/,
      message: "must not reference browser globals",
    },
  ]);
}

checkFiles("Vite host", "apps/workbench-web/src", [
  {
    pattern: /(?:from\s*|import\s*)["'](?:react-native|expo(?:\/|["'])|expo-router)/m,
    message: "must not import Expo or React Native",
  },
]);

checkFiles("Expo host", "apps/mobile/src", [
  {
    pattern: /(?:from\s*|import\s*)["'](?:@opencraft\/opencraft-composer|prosemirror-|lucide-react["'])/m,
    message: "must not import DOM-only composer or icon packages",
  },
  {
    pattern: /(?:from\s*|import\s*)["'][^"']+\.scss["']/m,
    message: "must not import the Vite SCSS surface",
  },
]);

checkFiles("Electron Main", "apps/workbench-electron/src/main.ts", [
  {
    pattern: /@opencraft\/(?:app-host-server|appserver-transport-websocket|local-agent-host)|\bAppHostServer\b|\bWebSocketTransport\b|\bstartLocalAgentHost\b/m,
    message: "must remain a window/tray/IPC relay and must not own a physical Host",
  },
  {
    pattern: /serve-workbench-web\.mjs|OPENCRAFT_APPSERVER_URL|function\s+appServerTarget/m,
    message: "must use the static-only loopback server and must not retain an AppServer proxy fallback",
  },
]);

checkFiles("public desktop", "apps/workbench-electron/src", [{
  pattern: /lightvela-(?:login|session-store|account-http)|\bDesktopLightVelaLogin\b|\blightvelaAccount\b|https:\/\/api\.lightvela\.(?:com|ai)/m,
  message: "must receive private accounts through explicit desktop product composition",
}]);

checkFiles("AppServer Lab", "apps/appserver-lab/src", [
  {
    pattern: /(?:from\s*|import\s*)["'](?:react(?:-dom|-native)?|expo(?:\/|["'])|expo-router|lucide-react)/m,
    message: "must stay renderer-free",
  },
  {
    pattern: /(?:from\s*|import\s*)["'](?:\.\.\/)+\.\.\/packages\/|@opencraft\/[^"']+\/src\//m,
    message: "must consume SDK packages through public exports",
  },
]);

for (const path of collectFiles(resolve(repositoryRoot, "apps/appserver-lab/src"))) {
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) {
    violations.push(`${relative(repositoryRoot, path)}: AppServer Lab production source must be TypeScript`);
  }
}

const forbiddenUiAuthorityImports = [
  "@opencraft/appserver-client",
  "@opencraft/appserver-session",
  "@opencraft/appserver-transport-memory",
  "@opencraft/appserver-transport-replay",
  "@opencraft/appserver-transport-websocket",
];

checkFiles("cloud desktop plugin", "plugins/cloud-desktop/src", [
  {
    pattern: /(?:from\s*|import\s*\(?)["'][^"']*(?:lightvela|tencent-tat|tat-websocket|\/apps\/)/m,
    message: "must not import product, enterprise service or application authority; use an authorized provider port",
  },
  {
    pattern: /\b(?:fetch|localStorage|sessionStorage)\s*\(|\b(?:localStorage|sessionStorage)\s*\./m,
    message: "must not own product HTTP or credentials",
  },
]);


const desktopPackage = JSON.parse(readFileSync(resolve(repositoryRoot, "plugins/cloud-desktop/package.json"), "utf8"));
for (const dependency of Object.keys(desktopPackage.dependencies ?? {})) {
  if (/^(?:@lightvela\/|@opencraft\/plugin-lightvela-)/.test(dependency)) {
    violations.push(`plugins/cloud-desktop/package.json: product dependency ${dependency} inverts the provider boundary`);
  }
}

for (const directory of ["apps/workbench-web/src/components", "apps/mobile/src/components"]) {
  checkFiles("ChatUI host", directory, forbiddenUiAuthorityImports.map((specifier) => ({
    pattern: new RegExp(`(?:from\\s*|import\\s*)["']${specifier.replaceAll("/", "\\/")}(?:["'/])`),
    message: `must consume ${specifier} through a runtime composition root, not from a UI component`,
  })));
}

for (const entry of readdirSync(resolve(repositoryRoot, "tests"), { recursive: true })) {
  if (basename(entry).startsWith("appserver-lab") && !entry.endsWith(".test.ts")) {
    violations.push(`tests/${entry}: AppServer Lab tests must be TypeScript`);
  }
}

if (violations.length > 0) {
  console.error("Platform boundary violations:\n" + violations.map((violation) => `- ${violation}`).join("\n"));
  process.exit(1);
}

console.log("Platform boundaries passed: shared core is renderer-free; Vite and Expo adapters are isolated; AppServer Lab is TypeScript-only.");
