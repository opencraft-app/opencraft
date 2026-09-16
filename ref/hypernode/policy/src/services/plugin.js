import { Service } from "@deepseek-ai/cordis";

export const HYPERNODE_MARKETPLACE = Object.freeze({
  name: "hypernode",
  root: "/workspace/.codex/marketplaces/hypernode",
  path: "/workspace/.codex/marketplaces/hypernode/marketplace.json",
});

export const OPENAI_BUNDLED_MARKETPLACE = Object.freeze({
  name: "openai-bundled",
  root: "/workspace/.codex/.tmp/bundled-marketplaces/openai-bundled",
  path: "/workspace/.codex/.tmp/bundled-marketplaces/openai-bundled/.agents/plugins/marketplace.json",
});

const PLUGIN_ROOT = `${HYPERNODE_MARKETPLACE.root}/plugins/hypernode-control`;
const SKILL_PATH = "/workspace/.codex/skills/hypernode/SKILL.md";
export const BUNDLED_PLUGIN_VERSIONS = Object.freeze({
  visualize: "1.0.23",
  sites: "0.1.46",
});

function bundledPluginCacheRoot(pluginName, version) {
  return `/workspace/.codex/plugins/cache/${OPENAI_BUNDLED_MARKETPLACE.name}/${pluginName}/${version}`;
}

function pluginSummary() {
  return {
    id: "hypernode-control",
    remotePluginId: null,
    version: "1.0.0",
    localVersion: "1.0.0",
    name: "hypernode-control",
    shareContext: null,
    source: { type: "local", path: PLUGIN_ROOT },
    installed: true,
    installedAt: null,
    enabled: true,
    installPolicy: "INSTALLED_BY_DEFAULT",
    installPolicySource: "WORKSPACE_SETTING",
    mustShowInstallationInterstitial: false,
    authPolicy: "ON_USE",
    availability: "AVAILABLE",
    disabledReason: null,
    eligiblePlanTypes: null,
    interface: {
      displayName: "HyperNode 管理",
      shortDescription: "管理当前 SSH Codex 主机",
      longDescription: "通过原生 Codex 技能查看并管理当前 HyperNode SSH 主机。",
      developerName: "HyperNode",
      category: "开发者工具",
      capabilities: ["skills"],
      websiteUrl: null,
      privacyPolicyUrl: null,
      termsOfServiceUrl: null,
      defaultPrompt: ["打开 HyperNode 管理入口"],
      brandColor: "#4F8CFF",
      composerIcon: null,
      composerIconUrl: null,
      logo: null,
      logoDark: null,
      logoUrl: null,
      logoUrlDark: null,
      screenshots: [],
      screenshotUrls: [],
    },
    keywords: ["hypernode", "ssh", "management"],
  };
}

function skillSummary() {
  return {
    name: "hypernode",
    description: "打开 HyperNode 管理入口。",
    shortDescription: "管理当前 SSH Codex 主机",
    interface: {
      displayName: "HyperNode",
      shortDescription: "管理当前 SSH Codex 主机",
      iconSmallUrl: null,
      iconLargeUrl: null,
      brandColor: "#4F8CFF",
      defaultPrompt: "打开 HyperNode 管理入口",
    },
    path: SKILL_PATH,
    enabled: true,
  };
}

function visualizePluginSummary(version = BUNDLED_PLUGIN_VERSIONS.visualize) {
  const root = `${OPENAI_BUNDLED_MARKETPLACE.root}/plugins/visualize`;
  return {
    id: "visualize@openai-bundled",
    remotePluginId: null,
    version: null,
    localVersion: version,
    name: "visualize",
    shareContext: null,
    source: { type: "local", path: root },
    installed: true,
    installedAt: null,
    enabled: true,
    installPolicy: "AVAILABLE",
    installPolicySource: null,
    mustShowInstallationInterstitial: null,
    authPolicy: "ON_INSTALL",
    availability: "AVAILABLE",
    disabledReason: null,
    eligiblePlanTypes: null,
    interface: {
      displayName: "可视化",
      shortDescription: "创建交互式图表、模拟与界面预览",
      longDescription: "直接在会话中创建交互式图表、地图、关系图、模拟、三维模型、数据浏览器和界面预览，并可筛选数据、比较方案和调整参数。",
      developerName: "OpenAI",
      category: "效率工具",
      capabilities: ["Interactive", "Read", "Write"],
      websiteUrl: "https://openai.com/",
      privacyPolicyUrl: "https://openai.com/policies/row-privacy-policy/",
      termsOfServiceUrl: "https://openai.com/policies/row-terms-of-use/",
      defaultPrompt: [
        "把这份数据集做成支持筛选和详情选择的交互式浏览器",
        "用可调整的三维模拟展示旋转陀螺仪的工作原理",
        "将这个数据库结构做成交互式关系图",
      ],
      brandColor: "#0169CC",
      // The host catalog is self-contained and does not expose host filesystem
      // paths to Desktop. Desktop renders its generic plugin glyph when these
      // optional assets are absent.
      composerIcon: null,
      composerIconUrl: null,
      logo: null,
      logoDark: null,
      logoUrl: null,
      logoUrlDark: null,
      screenshots: [],
      screenshotUrls: [],
    },
    keywords: [
      "visualize", "data visualization", "chart", "map", "diagram",
      "simulation", "3d model", "interactive", "dashboard", "data explorer",
      "ui preview",
    ],
  };
}

export function visualizeSkillSummary(version = BUNDLED_PLUGIN_VERSIONS.visualize) {
  return {
    name: "visualize:visualize",
    description: "直接在会话中创建可视化和交互式工具，适合图表、地图、关系图、模拟、三维模型、数据浏览器与界面原型。",
    shortDescription: null,
    interface: {
      displayName: "可视化",
      shortDescription: "把想法和数据变成交互式视觉内容",
      iconSmall: null,
      iconLarge: null,
      iconSmallUrl: null,
      iconLargeUrl: null,
      brandColor: null,
      defaultPrompt: "使用 $visualize 创建交互式可视化，让图表、地图、关系图、模拟、三维模型、数据浏览器或界面预览更容易理解和调整。",
    },
    path: `${bundledPluginCacheRoot("visualize", version)}/skills/visualize/SKILL.md`,
    scope: "user",
    enabled: true,
    dependencies: null,
  };
}

export function installedPluginSkillSummaries(
  visualizeVersion = BUNDLED_PLUGIN_VERSIONS.visualize,
) {
  return [visualizeSkillSummary(visualizeVersion)];
}

export function desktopMarketplace() {
  return {
    name: HYPERNODE_MARKETPLACE.name,
    path: HYPERNODE_MARKETPLACE.path,
    interface: { displayName: "HyperNode" },
    plugins: [pluginSummary()],
  };
}

export function openAiBundledMarketplace(
  visualizeVersion = BUNDLED_PLUGIN_VERSIONS.visualize,
) {
  return {
    name: OPENAI_BUNDLED_MARKETPLACE.name,
    path: OPENAI_BUNDLED_MARKETPLACE.path,
    interface: { displayName: "OpenAI Bundled" },
    plugins: [visualizePluginSummary(visualizeVersion)],
  };
}

export function pluginListResponse(visualizeVersion = BUNDLED_PLUGIN_VERSIONS.visualize) {
  return {
    marketplaces: [desktopMarketplace(), openAiBundledMarketplace(visualizeVersion)],
    marketplaceLoadErrors: [],
    featuredPluginIds: ["hypernode-control"],
  };
}

export function visualizePluginDetail(
  visualizeVersion = BUNDLED_PLUGIN_VERSIONS.visualize,
) {
  return {
    marketplaceName: OPENAI_BUNDLED_MARKETPLACE.name,
    marketplacePath: OPENAI_BUNDLED_MARKETPLACE.path,
    summary: visualizePluginSummary(visualizeVersion),
    shareUrl: null,
    description: "Create interactive charts, maps, diagrams, simulations, 3D models, data explorers, and UI previews directly in Codex.",
    skills: [visualizeSkillSummary(visualizeVersion)],
    hooks: [],
    apps: [],
    appTemplates: [],
    mcpServers: [],
    scheduledTasks: null,
  };
}

export function pluginDetail() {
  return {
    marketplaceName: HYPERNODE_MARKETPLACE.name,
    marketplacePath: HYPERNODE_MARKETPLACE.path,
    summary: pluginSummary(),
    shareUrl: null,
    description: "Native management entry points for the HyperNode SSH host.",
    skills: [skillSummary()],
    hooks: [],
    apps: [],
    appTemplates: [],
    mcpServers: ["hypernode-calculator"],
    scheduledTasks: null,
  };
}

function assertPlugin(params) {
  if (params?.pluginName !== "hypernode-control" && params?.pluginId !== "hypernode-control") {
    throw new Error(`unknown HyperNode plugin: ${params?.pluginName ?? params?.pluginId ?? "missing"}`);
  }
  if (params.marketplacePath != null && params.marketplacePath !== HYPERNODE_MARKETPLACE.path) {
    throw new Error(`unknown HyperNode marketplace path: ${params.marketplacePath}`);
  }
}

function isVisualizePlugin(params) {
  return (params?.pluginName === "visualize" || params?.pluginId === "visualize@openai-bundled") &&
    (params?.marketplacePath == null ||
      params.marketplacePath === OPENAI_BUNDLED_MARKETPLACE.path ||
      params.marketplacePath.endsWith("/openai-bundled/.agents/plugins/marketplace.json"));
}

function isOpenAiBundledSource(source) {
  return typeof source === "string" &&
    (source === OPENAI_BUNDLED_MARKETPLACE.root || source.endsWith("/openai-bundled"));
}

function textFromBytes(bytes) {
  if (typeof TextDecoder === "function") return new TextDecoder().decode(bytes);
  return Buffer.from(bytes).toString("utf8");
}

export function bundledPluginVersionForConnection(ctx, connection, pluginName) {
  const fallback = BUNDLED_PLUGIN_VERSIONS[pluginName];
  if (!fallback) throw new Error(`unknown bundled plugin version: ${pluginName}`);
  const user = connection?.identity?.id
    ? ctx.userDirectory.find(connection.identity.id)
    : null;
  if (!user?.username) return fallback;

  const sourceManifest =
    `${OPENAI_BUNDLED_MARKETPLACE.root}/plugins/${pluginName}/.codex-plugin/plugin.json`;
  try {
    const controlPath = ctx.workspaceFilesystem.controlPathForUser(sourceManifest);
    const manifest = JSON.parse(textFromBytes(ctx.virtualFilesystem.readFile(controlPath, user)));
    const version = manifest?.name === pluginName ? manifest.version : null;
    // A manifest version becomes a cache path segment below. Keep that path
    // boundary explicit even though the marketplace source is Desktop-owned.
    if (typeof version === "string" && /^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) {
      return version;
    }
  } catch {
    // A first plugin/list may arrive before Desktop materializes its bundled
    // marketplace. The current bundled version is the safe bootstrap value;
    // plugin/install and skills/list will re-resolve after materialization.
  }
  return fallback;
}

export function installBundledPlugin(vfs, pluginName, version) {
  const source = `${OPENAI_BUNDLED_MARKETPLACE.root}/plugins/${pluginName}`;
  const cacheParent = `/workspace/.codex/plugins/cache/${OPENAI_BUNDLED_MARKETPLACE.name}/${pluginName}`;
  const destination = `${cacheParent}/${version}`;
  // Desktop materializes the bundled marketplace through fs/writeFile before
  // invoking marketplace/add and plugin/install. Match native app-server by
  // publishing that immutable source tree into the canonical plugin cache.
  vfs.createDirectory(cacheParent, true);
  vfs.remove(destination, true, true);
  vfs.copy(source, destination, true);
}

export function installBundledPluginForConnection(ctx, connection, pluginName, version) {
  const user = connection?.identity?.id
    ? ctx.userDirectory.find(connection.identity.id)
    : null;
  if (!user?.username) throw new Error("bundled plugin installation requires an authenticated SSH user");

  const source = `${OPENAI_BUNDLED_MARKETPLACE.root}/plugins/${pluginName}`;
  const cacheParent = `/workspace/.codex/plugins/cache/${OPENAI_BUNDLED_MARKETPLACE.name}/${pluginName}`;
  const destination = `${cacheParent}/${version}`;
  const sourceControl = ctx.workspaceFilesystem.controlPathForUser(source);
  const cacheParentControl = ctx.workspaceFilesystem.controlPathForUser(cacheParent);
  const destinationControl = ctx.workspaceFilesystem.controlPathForUser(destination);

  // Desktop materializes bundled marketplaces through fs/writeFile. Those
  // writes live in the authenticated user's durable control volume, not in
  // the process-global MemoryVFS. Keep installation in that same filesystem
  // domain so the advertised cache-backed skill path is actually readable.
  ctx.virtualFilesystem.createDirectory({ path: cacheParentControl, recursive: true }, user);
  ctx.virtualFilesystem.remove({ path: destinationControl, recursive: true, force: true }, user);
  ctx.virtualFilesystem.copy({
    sourcePath: sourceControl,
    destinationPath: destinationControl,
    recursive: true,
  }, ctx.vfs, user);
}

export function marketplaceAddResponse(params) {
  return isOpenAiBundledSource(params?.source) ? {
    marketplaceName: OPENAI_BUNDLED_MARKETPLACE.name,
    installedRoot: OPENAI_BUNDLED_MARKETPLACE.root,
    alreadyAdded: true,
  } : {
    marketplaceName: HYPERNODE_MARKETPLACE.name,
    installedRoot: HYPERNODE_MARKETPLACE.root,
    alreadyAdded: true,
  };
}

// This service implements only Codex Desktop's official host-scoped catalog
// contract. Runtime Plugins are a separate operator control plane.
export class PluginService extends Service {
  constructor(ctx) {
    super(ctx, "desktopPluginCatalog");
    const register = (method, handler) => ctx.effect(() => ctx.appServer.register(method, handler));
    const visualizeVersion = (connection) =>
      bundledPluginVersionForConnection(ctx, connection, "visualize");
    register("plugin/list", (_params, connection) => pluginListResponse(visualizeVersion(connection)));
    register("plugin/installed", (_params, connection) => ({
      marketplaces: [desktopMarketplace(), openAiBundledMarketplace(visualizeVersion(connection))],
      marketplaceLoadErrors: [],
    }));
    register("plugin/read", (params, connection) => {
      if (isVisualizePlugin(params)) {
        return { plugin: visualizePluginDetail(visualizeVersion(connection)) };
      }
      assertPlugin(params);
      return { plugin: pluginDetail() };
    });
    register("plugin/skill/read", (params) => {
      if (params?.skillName !== "hypernode") return { contents: null };
      return { contents: [
        "---",
        "name: hypernode",
        "description: Open the HyperNode management menu.",
        "---",
        "",
        "# HyperNode",
        "",
        "Use the HyperNode management menu exposed by this SSH host.",
      ].join("\n") };
    });
    register("plugin/install", (params, connection) => {
      if (isVisualizePlugin(params)) {
        installBundledPluginForConnection(
          ctx,
          connection,
          "visualize",
          visualizeVersion(connection),
        );
        return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] };
      }
      // The current Desktop materializes Sites and Visualize together. Sites
      // is not advertised by this focused lab, but accepting its companion
      // installation keeps the bundled-marketplace transaction atomic.
      if (params?.pluginName === "sites" &&
          (params?.marketplacePath == null ||
            params.marketplacePath.endsWith("/openai-bundled/.agents/plugins/marketplace.json"))) {
        installBundledPluginForConnection(
          ctx,
          connection,
          "sites",
          bundledPluginVersionForConnection(ctx, connection, "sites"),
        );
        return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] };
      }
      assertPlugin(params);
      return { authPolicy: "ON_USE", appsNeedingAuth: [] };
    });
    register("plugin/uninstall", (params) => {
      assertPlugin(params);
      throw new Error("HyperNode Control is installed by the SSH host administrator");
    });
    register("marketplace/add", (params) => marketplaceAddResponse(params));
    register("marketplace/remove", (params) => {
      if (params?.marketplaceName !== HYPERNODE_MARKETPLACE.name) {
        throw new Error(`unknown HyperNode marketplace: ${params?.marketplaceName ?? "missing"}`);
      }
      throw new Error("The HyperNode marketplace is owned by the SSH host administrator");
    });
    register("marketplace/upgrade", (params) => ({
      selectedMarketplaces: params?.marketplaceName == null ? [HYPERNODE_MARKETPLACE.name] : [params.marketplaceName],
      upgradedRoots: [HYPERNODE_MARKETPLACE.root],
      errors: [],
    }));
  }
}

PluginService.inject = ["appServer", "userDirectory", "vfs", "virtualFilesystem", "workspaceFilesystem"];
