import assert from "node:assert/strict";
import test from "node:test";
import { connectedAgentCatalogEntry, connectedAgentEngineId, connectedAgentModelId } from "../../apps/local-agent-host/src/connected-agents.ts";
import {
  AgentOnboardingService,
  firstVersionLine,
  interpretAuth,
  parseSignInOutput,
  redactSecrets,
  resolveExecutable,
  type ManagedProcess,
  type OnboardingDeps,
} from "../../apps/local-agent-host/src/agent-onboarding.ts";

test("sign-in output keeps the URL and device code, and drops terminal decoration", () => {
  const parsed = parseSignInOutput("\u001b]8;;https://auth.example/device\u0007open\u001b]8;;\u0007\r\ncode ABCD-EFGH\u001b[0m");
  assert.equal(parsed.url, "https://auth.example/device");
  assert.equal(parsed.userCode, "ABCD-EFGH");
  assert.equal(firstVersionLine("\u001b[32mcodex-cli 0.1\u001b[0m\nextra"), "codex-cli 0.1");
});

test("auth status recognizes each agent without treating an unknown failure as signed in", () => {
  assert.deepEqual(interpretAuth("codex", "Logged in using ChatGPT\n", "", 0), { authenticated: true, account: null });
  assert.deepEqual(interpretAuth("cursor", "✓ Logged in as dev@example.com\n", "", 0), { authenticated: true, account: "dev@example.com" });
  assert.deepEqual(interpretAuth("claude", 'prefix {"loggedIn":false,"authMethod":"none"}\n', "", 0), { authenticated: false, account: null });
  assert.deepEqual(interpretAuth("codebuddy", "", "not signed in", 1), { authenticated: false, account: null });
  assert.deepEqual(interpretAuth("cursor", "", "authentication required", 1), { authenticated: false, account: null });
  assert.deepEqual(interpretAuth("cursor", "unknown output", "", 1), { authenticated: null, account: null });
  assert.deepEqual(interpretAuth("cursor", "", "", 1), { authenticated: null, account: null });
});

test("secrets in command output are not returned", () => {
  assert.equal(redactSecrets("key sk-live-secretvalue and api_key=abc"), "key [redacted] and api_key=[redacted]");
});

test("executable lookup uses PATH, then known install locations", async () => {
  const files = new Set(["/opt/homebrew/bin/codex", "/Users/me/.local/share/cursor-agent/versions/2026.11.05/cursor-agent"]);
  const deps = { env: { PATH: "/usr/bin" }, homedir: "/Users/me", exists: async (file: string) => files.has(file), cursorVersions: async () => ["2026.11.05"] };
  assert.equal(await resolveExecutable(["codex"], deps), "/opt/homebrew/bin/codex");
  assert.equal(await resolveExecutable(["cursor-agent"], deps), "/Users/me/.local/share/cursor-agent/versions/2026.11.05/cursor-agent");
  assert.equal(await resolveExecutable(["missing"], deps), null);
});

function fakeDeps(files: Set<string>, replies: Map<string, { stdout?: string; stderr?: string; code?: number }>): OnboardingDeps & { spawned: string[][] } {
  const spawned: string[][] = [];
  const deps: OnboardingDeps & { spawned: string[][] } = {
    spawned,
    env: { PATH: "/bin" },
    homedir: "/Users/me",
    exists: async file => files.has(file),
    cursorVersions: async () => [],
    async exec(command, args) {
      const reply = replies.get(`${command} ${args.join(" ")}`);
      if (!reply) return { stdout: "", stderr: "", code: 1 };
      return { stdout: reply.stdout ?? "", stderr: reply.stderr ?? "", code: reply.code ?? 0 };
    },
    spawn(command, args) {
      spawned.push([command, ...args]);
      let listener: ((chunk: string) => void) | null = null;
      const process: ManagedProcess = {
        kill() {},
        exited: new Promise(() => undefined),
        onOutput(next) { listener = next; listener("https://auth.example/start\ncode WXYZ-1234\n"); },
      };
      return process;
    },
  };
  return deps;
}

test("status reports installed agents and does not invent a signed-in session", async () => {
  const codex = "/bin/codex";
  const deps = fakeDeps(new Set([codex, "/bin/npm"]), new Map([
    [`${codex} --version`, { stdout: "codex-cli 1.2.3\n" }],
    [`${codex} login status`, { stdout: "Logged in using ChatGPT\n" }],
  ]));
  const service = new AgentOnboardingService(deps);
  const snapshot = await service.status();
  const found = snapshot.agents.find(agent => agent.id === "codex");
  assert.equal(found?.installed, true);
  assert.equal(found?.engineId, connectedAgentCatalogEntry("codex").agentId);
  assert.equal(snapshot.agents.find(agent => agent.id === "claude")?.engineId, connectedAgentCatalogEntry("claude-code").agentId);
  assert.equal(found?.version, "codex-cli 1.2.3");
  assert.equal(found?.authenticated, true);
  assert.equal(snapshot.agents.find(agent => agent.id === "claude")?.installed, false);
  service.close();
});

test("actions only run the pinned command for a known agent", async () => {
  const deps = fakeDeps(new Set(["/bin/codex", "/bin/npm"]), new Map());
  const service = new AgentOnboardingService(deps);
  await assert.rejects(service.act({ id: "bash", action: "sign-in" }), /Unknown agent/);
  await assert.rejects(service.act({ id: "codex", action: "rm" }), /Unknown onboarding action/);
  assert.equal(deps.spawned.length, 0);
  const snapshot = await service.act({ id: "codex", action: "sign-in" });
  assert.deepEqual(deps.spawned, [["/bin/codex", "login"]]);
  const activity = snapshot.agents.find(agent => agent.id === "codex")?.activity;
  assert.equal(activity?.kind, "sign-in");
  assert.equal(activity?.url, "https://auth.example/start");
  assert.equal(activity?.userCode, "WXYZ-1234");
  await assert.rejects(service.act({ id: "claude", action: "install" }), /installed from its own site/);
  service.close();
});

test("a signed-in agent becomes a selectable model and owns its later threads", () => {
  assert.equal(connectedAgentModelId("cursor"), "cursor:current");
  assert.equal(connectedAgentModelId("claude"), "claude-code:current");
  assert.equal(connectedAgentEngineId("cursor:current"), "cursor");
  assert.equal(connectedAgentEngineId("claude_thread"), "claude-code");
  assert.equal(connectedAgentEngineId("dsh-model:deepseek:v4"), null);
  assert.equal(connectedAgentCatalogEntry("codex").displayName, "Codex");
  assert.equal(connectedAgentCatalogEntry("codex").groupLabel, "Codex");
});

test("package install uses the fixed package name", async () => {
  const deps = fakeDeps(new Set(["/bin/npm"]), new Map());
  const service = new AgentOnboardingService(deps);
  await service.act({ id: "codebuddy", action: "install" });
  assert.deepEqual(deps.spawned, [["/bin/npm", "install", "-g", "@tencent-ai/codebuddy-code"]]);
  service.close();
});


test("desktop discovery finds a user's NVM installation when the GUI PATH is minimal", async () => {
  const deps = {env:{PATH:'/usr/bin'},homedir:'/home/person',exists:async (p:string)=>p==='/home/person/.nvm/versions/node/v24/bin/codebuddy',cursorVersions:async()=>[],nodeBinDirectories:async()=>['/home/person/.nvm/versions/node/v24/bin']};
  assert.equal(await resolveExecutable(['codebuddy'],deps),'/home/person/.nvm/versions/node/v24/bin/codebuddy');
});


test("a discovered Node-owned CLI also receives a working interpreter PATH",async()=>{
 const {localAgentEnvironment}=await import('../../apps/local-agent-host/src/agent-onboarding.js');
 const env=await localAgentEnvironment({env:{PATH:'/usr/bin'},homedir:'/home/person',nodeBinDirectories:async()=>['/home/person/.nvm/versions/node/v24/bin']},'/home/person/.local/bin/codebuddy');
 assert.ok(env.PATH?.split(':').includes('/home/person/.nvm/versions/node/v24/bin'));
});

test("readLocalCodexAuth and readLocalCursorAuth recognize local credential files", async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readLocalCodexAuth, readLocalCursorAuth } = await import("../../apps/local-agent-host/src/agent-onboarding.js");
  const root = await mkdtemp(join(tmpdir(), "oc-local-auth-"));
  try {
    assert.deepEqual(await readLocalCodexAuth({ OPENAI_API_KEY: "sk-test" }, root), { authenticated: true, account: null });
    const codexDir = join(root, ".codex");
    await mkdir(codexDir, { recursive: true });
    const jwtPayload = Buffer.from(JSON.stringify({ email: "dev@example.com" })).toString("base64url");
    await writeFile(join(codexDir, "auth.json"), JSON.stringify({ tokens: { access_token: "tok", id_token: `h.${jwtPayload}.s` } }));
    assert.deepEqual(await readLocalCodexAuth({}, root), { authenticated: true, account: "dev@example.com" });

    const cursorDir = join(root, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    await writeFile(join(cursorDir, "cli-config.json"), JSON.stringify({ authInfo: { accessToken: "cur-tok", email: "cur@example.com" } }));
    assert.deepEqual(await readLocalCursorAuth({}, root), { authenticated: true, account: "cur@example.com" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS ChatGPT.app codex-package layout is discovered and injects sibling codex-path into PATH", async () => {
  const { delimiter } = await import("node:path");
  const { localAgentEnvironment } = await import("../../apps/local-agent-host/src/agent-onboarding.js");
  const appCodex = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
  const appRg = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-path/rg";
  const files = new Set([appCodex, appRg, "/usr/local/bin/npx"]);
  const deps = {
    env: { PATH: "/usr/bin" },
    homedir: "/Users/me",
    exists: async (file: string) => files.has(file),
    cursorVersions: async () => [],
  };
  assert.equal(await resolveExecutable(["codex"], deps), appCodex);
  const env = await localAgentEnvironment(deps, "/usr/local/bin/npx", [appCodex]);
  const parts = (env.PATH ?? "").split(delimiter);
  assert.ok(parts.includes("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin"));
  assert.ok(parts.includes("/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-path"));
});

test("persisted fingerprint probe cache skips redundant CLI spawns across service instances", async () => {
  const codex = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
  let execCount = 0;
  let savedCache: string | null = null;
  const makeService = () => new AgentOnboardingService({
    env: { PATH: "/usr/bin" },
    homedir: "/Users/test-nonexistent",
    dataDirectory: "/virtual/data",
    exists: async file => file === codex,
    cursorVersions: async () => [],
    statFile: async file => file === codex ? { realpath: codex, size: 1024, mtimeMs: 1700000000000, ino: 42 } : null,
    readTextFile: async () => savedCache,
    writeTextFile: async (_file, content) => { savedCache = content; },
    exec: async (_cmd, args) => {
      execCount++;
      return args[0] === "--version"
        ? { stdout: "codex-cli 0.171.0\n", stderr: "", code: 0 }
        : { stdout: "Logged in using ChatGPT\n", stderr: "", code: 0 };
    },
    spawn: () => { throw new Error("unexpected spawn"); },
  });
  const first = makeService();
  const s1 = (await first.status()).agents.find(a => a.id === "codex");
  assert.equal(s1?.version, "codex-cli 0.171.0");
  assert.equal(s1?.authenticated, true);
  assert.equal(execCount, 2);
  first.close();

  const second = makeService();
  const s2 = (await second.status()).agents.find(a => a.id === "codex");
  assert.equal(s2?.version, "codex-cli 0.171.0");
  assert.equal(s2?.authenticated, true);
  assert.equal(execCount, 2, "second instance reused fingerprint cache with zero child spawns");
  second.close();
});

test("readNativeCodexModelsCache projects visible priority-ordered models without cold spawning ACP", async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readNativeCodexModelsCache } = await import("../../apps/local-agent-host/src/connected-agents.js");
  const root = await mkdtemp(join(tmpdir(), "oc-codex-models-"));
  try {
    const codexDir = join(root, ".codex");
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, "config.toml"), 'model = "gpt-6.2-astra"\n');
    await writeFile(join(codexDir, "models_cache.json"), JSON.stringify({
      models: [
        { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide", priority: 1 },
        { slug: "gpt-6.2-astra", display_name: "GPT-6.2-Astra", visibility: "list", priority: 3, default_reasoning_level: "medium", additional_speed_tiers: ["fast"], input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "medium", description: "Balanced" }] },
        { slug: "gpt-6.2-sol", display_name: "GPT-6.2-Sol", visibility: "list", priority: 2, default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low", description: "Fast" }] },
      ],
    }));
    const models = await readNativeCodexModelsCache({}, root);
    assert.deepEqual(models.map(m => m.id), ["codex:gpt-6.2-sol", "codex:gpt-6.2-astra"]);
    assert.equal(models[0]?.isDefault, false);
    assert.equal(models[1]?.isDefault, true);
    assert.deepEqual(models[1]?.inputModalities, ["text", "image"]);
    assert.equal(models[1]?.serviceTiers[0]?.id, "fast");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime auth expiration overrides stale status until sign-in completes", async () => {
  const codex = "/bin/codex";
  let resolveExit: (value: { code: number | null }) => void = () => undefined;
  const signedIn: string[] = [];
  const deps = fakeDeps(new Set([codex]), new Map([
    [`${codex} --version`, { stdout: "codex-cli 1.2.3\n" }],
    [`${codex} login status`, { stdout: "Logged in using ChatGPT\n" }],
  ]));
  deps.spawn = () => ({
    kill() {},
    exited: new Promise(resolve => { resolveExit = resolve; }),
    onOutput(next) { next("https://auth.example/reauth\n"); },
  });
  const service = new AgentOnboardingService(deps, id => signedIn.push(id));
  assert.equal((await service.status()).agents.find(a => a.id === "codex")?.authenticated, true);

  service.markAuthenticationExpired("codex");
  assert.equal((await service.status()).agents.find(a => a.id === "codex")?.authenticated, false);

  await service.act({ id: "codex", action: "sign-in" });
  resolveExit({ code: 0 });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(signedIn, ["codex"]);
  assert.equal((await service.status()).agents.find(a => a.id === "codex")?.authenticated, true);
  service.close();
});
