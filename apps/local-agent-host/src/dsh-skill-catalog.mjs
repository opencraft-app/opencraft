import { isAbsolute, join, resolve } from "node:path";

/** Engine-private composition. Scope and filesystem provider APIs never cross AppServer. */
export async function createDshSkillCatalog(ctx, config) {
  const { createScope } = await import(new URL("../../dsh-scope/lib/index.js", config.toolsModuleUrl).href);
  const { FileSystemSkillProvider } = await import(new URL("../../dsh-skill-filesystem/lib/index.js", config.toolsModuleUrl).href);
  const { standingMountFor } = await import(new URL("../../dsh-agent-presets/lib/index.js", config.toolsModuleUrl).href);
  const discoveryKey = {};
  const discovery = createScope(ctx, discoveryKey);
  const mounts = new Set();
  const agents = new Map();
  const compositions = new Map();
  const globalKey = {};
  let reconciling = false;
  let changed = false;

  class OpenCraftSkillProvider extends FileSystemSkillProvider {
    async roots(cwd) {
      const roots = await super.roots(cwd);
      for (const root of roots) if (root.source === "custom") root.source = "user-opencraft";
      if (typeof cwd === "string" && isAbsolute(cwd)) roots.push({
        path: join(resolve(cwd), ".opencraft", "skills"),
        projectRoot: resolve(cwd), source: "project-opencraft", rank: 150,
      });
      return roots;
    }
  }
  function mount(scope, includeDefaultRoots) {
    const owner = scope.ctx;
    let provider, control;
    const stop = owner.skills.registerProvider(value => {
      control = value;
      provider = new OpenCraftSkillProvider(owner, value, {
        providerName: "opencraft-filesystem", includeDefaultRoots,
        customSkillDirs: [config.persistentSkillsRoot, config.taskSkillsRoot, process.env.OPENCRAFT_OFFICIAL_SKILLS_ROOT].filter(value => typeof value === "string"),
      });
      return provider;
    });
    let closing;
    const entry = { control, close: () => closing ??= (async () => {
      stop();
      await provider.dispose();
      await scope.dispose();
      mounts.delete(entry);
    })() };
    mounts.add(entry);
    return entry;
  }
  mount(discovery, true);
  function prepare(agent) {
    const standing = standingMountFor(agent.ctx);
    const key = standing?.key ?? globalKey;
    if (agents.get(agent) === key) return;
    void release(agent)?.catch(() => ctx.logger.warn("OpenCraft Skill provider disposal failed"));
    let composition = compositions.get(key);
    if (!composition) {
      // Inherit this plugin's declared dependencies, not the Agent core's API.
      // Register alongside native filesystem providers in the standing preset:
      // putting a user root in the child layer would override project ranks.
      const scope = standing ? createScope(ctx, key) : { ctx, dispose: async () => {} };
      composition = { entry: mount(scope, false), users: new Set() };
      compositions.set(key, composition);
    }
    composition.users.add(agent);
    agents.set(agent, key);
  }
  function release(agent) {
    const key = agents.get(agent);
    agents.delete(agent);
    const composition = compositions.get(key);
    if (!composition) return;
    composition.users.delete(agent);
    if (composition.users.size > 0) return;
    compositions.delete(key);
    return composition.entry.close();
  }
  ctx.on("agent/created", ({ agent }) => prepare(agent));
  ctx.on("agent/disposed", ({ agent }) => release(agent));
  ctx.on("skills/change", () => { if (!reconciling) changed = true; });
  function invalidate() {
    // One native registry revision invalidates all scope/cwd cache entries.
    for (const { control } of mounts) if (!control.signal.aborted) { control.invalidate(); break; }
  }
  ctx.on("agent/pre-step", async ({ agent }, next) => {
    prepare(agent);
    // Watchers accelerate UI invalidation, but cannot guarantee immediate read
    // after external edits or missing-directory creation. Native collect owns
    // deduplication and incomplete-snapshot handling after this reconciliation.
    reconciling = true;
    try { invalidate(); } finally { reconciling = false; }
    return next();
  });
  ctx.effect(() => async () => {
    await Promise.all([...mounts].map(entry => entry.close()));
    agents.clear();
    compositions.clear();
  });
  return {
    invalidate,
    prepare,
    takeChanged() { const result = changed; changed = false; return result; },
    discoveryKey,
  };
}
