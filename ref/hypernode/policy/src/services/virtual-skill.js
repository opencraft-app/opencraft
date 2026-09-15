import { Service } from "@deepseek-ai/cordis";
import {
  bundledPluginVersionForConnection,
  installedPluginSkillSummaries,
} from "./plugin.js";
import { utf8Encode } from "../runtime/bytes.ts";
export {
  BUILTIN_VIRTUAL_SKILL_ALIASES,
  hasExplicitBuiltinVirtualSkill,
} from "./builtin-virtual-skill.ts";

const SKILL_ROOT = "/workspace/.codex/skills";
const PHYSICAL_SKILL_ROOT = "/localhost/.codex/skills";

export class VirtualSkillService extends Service {
  constructor(ctx) {
    super(ctx, "virtualSkills");
    this.skills = new Map();
    this.aliases = new Map();
    this.physicalSkillKeys = new Map();
    ctx.vfs.createDirectory(SKILL_ROOT);
    this.register({
      name: "models",
      aliases: ["model-providers", "model-gateway"],
      description: "查看并管理 Codex 订阅、自定义 API 与节点公共模型。",
      displayName: "模型服务",
      shortDescription: "管理 Codex 订阅、自定义 API 与公共模型",
      defaultPrompt: "查看并管理模型服务",
      run: (input, invocation) => this.ctx.modelGateway.executeSkill(input, invocation),
    });
    this.register({
      name: "sessions",
      aliases: ["active-sessions", "thread-activity", "leases"],
      description: "查看当前持有写入租约的活跃会话、执行用户与最近活动时间。",
      displayName: "活跃会话",
      shortDescription: "查看正在执行或持有写入租约的会话",
      defaultPrompt: "查看活跃会话",
      run: (_input, invocation) => this.ctx.threadWriteLease.renderActiveThreads(
        invocation.threadId,
        Date.now(),
        invocation.connection?.identity?.id ?? null,
      ),
    });
    this.register({
      name: "codex-account",
      aliases: ["account", "bind-codex", "account-add"],
      description: "为当前 SSH 用户添加、恢复或切换 Codex 订阅账户。",
      displayName: "添加 Codex 账户",
      shortDescription: "为当前 SSH 用户绑定新的 Codex 订阅",
      defaultPrompt: "添加 Codex 账户",
      run: (_input, invocation) => this.ctx.accountCatalog.add(
        invocation.connection,
        invocation.threadId,
      ),
    });
    this.register({
      name: "search-conversations",
      aliases: ["search", "global-search", "conversation-search"],
      description: "通过全文索引搜索本节点中当前用户有权查看的历史会话。",
      displayName: "搜索会话",
      shortDescription: "全文搜索本节点中可见的历史会话",
      defaultPrompt: "搜索历史会话",
      run: (input, invocation) => this.ctx.administrator.search(input, invocation),
    });
    this.register({
      name: "evolution",
      aliases: ["policy-status", "hot-upgrade"],
      description: "查看 HyperNode 策略热升级版本、切换状态与回滚信息。",
      displayName: "策略演进",
      shortDescription: "查看热升级版本、切换与回滚状态",
      defaultPrompt: "查看策略演进状态",
      run: () => this.renderEvolution(),
    });
    ctx.effect(() => ctx.appServer.register("skills/list", (params, connection) => {
      this.materializeForConnection(connection);
      const cwds = Array.isArray(params.cwds) && params.cwds.length > 0
        ? params.cwds
        : ["/workspace"];
      const visualizeVersion = bundledPluginVersionForConnection(
        this.ctx,
        connection,
        "visualize",
      );
      return {
        data: cwds.map((cwd) => ({
          cwd,
          skills: [...this.list(connection), ...installedPluginSkillSummaries(visualizeVersion)],
          errors: [],
        })),
      };
    }));
  }

  register(skill) {
    return this.install(skill, false);
  }

  replace(skill) {
    return this.install(skill, true);
  }

  remove(name) {
    const skill = this.skills.get(name);
    if (!skill) return false;
    for (const alias of [skill.name, ...(skill.aliases ?? [])]) {
      if (this.aliases.get(alias) === skill.name) this.aliases.delete(alias);
    }
    this.skills.delete(skill.name);
    this.ctx.vfs.remove(`${SKILL_ROOT}/${skill.name}`, true, true);
    this.removePhysicalSkill(skill.name);
    this.broadcastChanged();
    return true;
  }

  install(skill, replace) {
    if (!skill?.name || typeof skill.run !== "function") throw new Error("invalid virtual skill");
    const previous = this.skills.get(skill.name);
    if (!replace && previous) throw new Error(`duplicate virtual skill: ${skill.name}`);
    const previousAliases = previous ? [previous.name, ...(previous.aliases ?? [])] : [];
    const aliases = [skill.name, ...(skill.aliases ?? [])];
    for (const alias of aliases) {
      const owner = this.aliases.get(alias);
      if (owner && owner !== skill.name) throw new Error(`duplicate virtual skill alias: ${alias}`);
    }
    for (const alias of previousAliases) {
      if (this.aliases.get(alias) === skill.name) this.aliases.delete(alias);
    }
    this.skills.set(skill.name, skill);
    for (const alias of aliases) {
      this.aliases.set(alias, skill.name);
    }
    this.seedSkillVfs(this.ctx.vfs, skill);
    this.broadcastChanged();
    return () => {
      if (this.skills.get(skill.name) !== skill) return false;
      for (const alias of aliases) {
        if (this.aliases.get(alias) === skill.name) this.aliases.delete(alias);
      }
      if (previous) {
        this.skills.set(skill.name, previous);
        for (const alias of previousAliases) this.aliases.set(alias, skill.name);
        this.seedSkillVfs(this.ctx.vfs, previous);
      } else {
        this.skills.delete(skill.name);
        this.ctx.vfs.remove(`${SKILL_ROOT}/${skill.name}`, true, true);
      }
      this.broadcastChanged();
      return true;
    };
  }

  broadcastChanged() {
    // `skills/changed` is the native cache-invalidation signal. Desktop will
    // re-run skills/list with its existing roots, which makes dynamically
    // published and rolled-back MCP App launchers appear without reconnecting.
    // The payload intentionally contains no skill identity because individual
    // launchers may be owner-only; all clients can safely invalidate their
    // local catalog without learning another user's App name.
    this.ctx.appServer?.broadcastNotification("skills/changed", {});
  }

  removePhysicalSkill(skillName) {
    for (const materializationId of [...this.physicalSkillKeys.keys()]) {
      const separator = materializationId.indexOf("\0");
      if (separator < 0 || materializationId.slice(separator + 1) !== skillName) continue;
      const identityId = materializationId.slice(0, separator);
      const user = this.ctx.userDirectory?.find(identityId);
      if (user) {
        this.ctx.virtualFilesystem?.remove(
          { path: `${PHYSICAL_SKILL_ROOT}/${skillName}`, recursive: true, force: true },
          user,
        );
      }
      this.physicalSkillKeys.delete(materializationId);
    }
  }

  list(connection) {
    return [...this.skills.values()].filter((skill) => (
      connection === undefined || skill.visible?.(connection) !== false
    )).map((skill) => ({
      name: skill.name,
      description: skill.description,
      shortDescription: skill.shortDescription ?? null,
      path: `${SKILL_ROOT}/${skill.name}/SKILL.md`,
      scope: "admin",
      enabled: true,
      dependencies: null,
      interface: {
        displayName: skill.displayName ?? skill.name,
        shortDescription: skill.shortDescription ?? null,
        defaultPrompt: skill.defaultPrompt ?? skill.name,
        brandColor: null,
        iconSmall: null,
        iconLarge: null,
        iconSmallUrl: null,
        iconLargeUrl: null,
      },
    }));
  }

  execute(command, input = [], invocation = {}) {
    const skill = this.skills.get(this.aliases.get(command));
    if (!skill) return `Unknown management command. Available skills: ${[...this.skills.keys()].join(", ")}.`;
    if (invocation.connection && skill.visible?.(invocation.connection) === false) {
      return "This skill is not available to the current SSH user.";
    }
    return skill.run(input, invocation);
  }

  resolveInput(input = []) {
    const texts = input
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text.replaceAll("&#x20;", " "));
    const candidates = [];
    for (const item of input) {
      if (typeof item?.name === "string") candidates.push(item.name);
      if (typeof item?.path === "string") {
        const pathName = item.path.match(/\/skills\/([^/]+)\/SKILL\.md(?:$|[?#])/i)?.[1];
        if (pathName) candidates.push(pathName);
      }
    }
    for (const text of texts) {
      for (const match of text.matchAll(/\[\$([^\]]+)\]\(([^)]+)\)/g)) {
        candidates.push(match[1]);
        const pathName = match[2].match(/\/skills\/([^/]+)\/SKILL\.md(?:$|[?#])/i)?.[1];
        if (pathName) candidates.push(pathName);
      }
      const mention = text.match(/(?:^|\s)\$([\w-]+)/)?.[1];
      if (mention) candidates.push(mention);
      const command = text.trim().split(/\s+/, 1)[0]?.replace(/^\$/, "");
      if (command) candidates.push(command);
    }
    const candidate = candidates.find((name) => this.aliases.has(name));
    if (!candidate) return null;
    const skill = this.skills?.get(this.aliases.get(candidate));
    return skill?.execution === "agent" ? null : candidate;
  }

  executeInput(input = [], invocation = {}) {
    return this.execute(this.resolveInput(input) ?? "", input, invocation);
  }

  renderEvolution() {
    const status = this.ctx.runtimePlugins.status();
    const active = status.active;
    const previous = status.previous;
    return [
      "HyperNode 策略演进状态：",
      `- 当前版本：${active?.revision ?? "无"}（${active?.status ?? "不可用"}）`,
      `- 上一版本：${previous?.revision ?? "无"}`,
      `- 当前代次：${status.generation}`,
      `- 切换状态：${status.transition ?? "空闲"}`,
      "候选代码只能通过已验证的发布清单升级；会话文本不能直接执行或启用代码。",
    ].join("\n");
  }

  seedSkillVfs(vfs, skill) {
    const directory = `${SKILL_ROOT}/${skill.name}`;
    vfs.remove(directory, true, true);
    vfs.createDirectory(directory);
    vfs.writeFile(`${directory}/SKILL.md`, utf8Encode(this.skillSource(skill)));
    for (const [relativePath, content] of this.skillResources(skill)) {
      const path = `${directory}/${relativePath}`;
      vfs.createDirectory(path.slice(0, path.lastIndexOf("/")));
      vfs.writeFile(path, utf8Encode(content));
    }
  }

  materializeForConnection(connection) {
    const identityId = connection?.identity?.id;
    const user = typeof identityId === "string" ? this.ctx.userDirectory.find(identityId) : null;
    if (!user?.username || !user?.homePath) return;
    this.ctx.virtualFilesystem.createDirectory(
      { path: PHYSICAL_SKILL_ROOT, recursive: true },
      user,
    );
    for (const skill of this.skills.values()) {
      if (skill.visible?.(connection) === false) continue;
      const source = this.skillSource(skill);
      const resources = this.skillResources(skill);
      const cacheKey = JSON.stringify([source, resources]);
      const materializationId = `${identityId}\0${skill.name}`;
      this.physicalSkillKeys ??= new Map();
      if (this.physicalSkillKeys.get(materializationId) === cacheKey) continue;
      const directory = `${PHYSICAL_SKILL_ROOT}/${skill.name}`;
      this.ctx.virtualFilesystem.remove(
        { path: directory, recursive: true, force: true },
        user,
      );
      this.ctx.virtualFilesystem.createDirectory(
        { path: directory, recursive: true },
        user,
      );
      this.ctx.virtualFilesystem.writeFile(
        { path: `${directory}/SKILL.md` },
        utf8Encode(source),
        user,
      );
      for (const [relativePath, content] of resources) {
        const path = `${directory}/${relativePath}`;
        this.ctx.virtualFilesystem.createDirectory(
          { path: path.slice(0, path.lastIndexOf("/")), recursive: true },
          user,
        );
        this.ctx.virtualFilesystem.writeFile({ path }, utf8Encode(content), user);
      }
      this.physicalSkillKeys.set(materializationId, cacheKey);
    }
  }

  skillSource(skill) {
    return skill.instructions ?? [
      "---",
      `name: ${skill.name}`,
      `description: ${skill.description}`,
      "---",
      "",
      `# ${skill.displayName ?? skill.name}`,
      "",
      "This is a synthetic Hypernode management skill backed by the in-memory VFS.",
      "",
    ].join("\n");
  }

  skillResources(skill) {
    const resources = [];
    for (const [relativePath, content] of Object.entries(skill.resources ?? {})) {
      if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
        throw new Error(`invalid virtual skill resource path: ${relativePath}`);
      }
      resources.push([relativePath, content]);
    }
    return resources;
  }
}

VirtualSkillService.inject = [
  "accountCatalog", "administrator", "appServer", "modelGateway", "runtimePlugins", "threadWriteLease", "userDirectory", "vfs",
  "virtualFilesystem", "workspaceFilesystem",
];
