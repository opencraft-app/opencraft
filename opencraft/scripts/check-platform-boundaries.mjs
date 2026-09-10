import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

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
  "packages/browser-core/src",
  "packages/chat-core/src",
  "packages/chat-document/src",
  "packages/composer-core/src",
  "packages/design-system/src",
  "packages/extension-contract/src",
  "packages/extension-runtime/src",
  "packages/timeline-virtualizer/src",
  "packages/workbench-runtime/src",
]) {
  checkFiles("shared package", directory, purePackageRules);
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

checkFiles("Expo host", "apps/workbench-expo/src", [
  {
    pattern: /(?:from\s*|import\s*)["'](?:@opencraft\/codex-composer|prosemirror-|lucide-react["'])/m,
    message: "must not import DOM-only composer or icon packages",
  },
  {
    pattern: /(?:from\s*|import\s*)["'][^"']+\.s?css["']/m,
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

for (const directory of ["apps/workbench-web/src/components", "apps/workbench-expo/src/components"]) {
  checkFiles("ChatUI host", directory, forbiddenUiAuthorityImports.map((specifier) => ({
    pattern: new RegExp(`(?:from\\s*|import\\s*)["']${specifier.replaceAll("/", "\\/")}(?:["'/])`),
    message: `must consume ${specifier} through a runtime composition root, not from a UI component`,
  })));
}

for (const entry of readdirSync(resolve(repositoryRoot, "tests"))) {
  if (entry.startsWith("appserver-lab") && !entry.endsWith(".test.ts")) {
    violations.push(`tests/${entry}: AppServer Lab tests must be TypeScript`);
  }
}

if (violations.length > 0) {
  console.error("Platform boundary violations:\n" + violations.map((violation) => `- ${violation}`).join("\n"));
  process.exit(1);
}

console.log("Platform boundaries passed: shared core is renderer-free; Vite and Expo adapters are isolated; AppServer Lab is TypeScript-only.");
