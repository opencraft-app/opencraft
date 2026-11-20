import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
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
test("npm-run's bundled Pi SDK and internal DSH runtime bins cannot shadow installed native CLIs", async () => {
  const bundled = resolve("node_modules/.bin"), bundledDsh = resolve("runtime/dsh/node_modules/.bin");
  const files = new Set([`${bundled}/pi`, `${bundledDsh}/dsh`, "/Users/me/.local/bin/pi", "/opt/homebrew/bin/dsh"]);
  const deps = { env: { PATH: `${bundled}:${bundledDsh}:/bin` }, homedir: "/Users/me", exists: async (file: string) => files.has(file), cursorVersions: async () => [] };
  assert.equal(await resolveExecutable(["pi"], deps), "/Users/me/.local/bin/pi");
  assert.equal(await resolveExecutable(["dsh"], deps), "/opt/homebrew/bin/dsh");
  files.delete("/Users/me/.local/bin/pi"); assert.equal(await resolveExecutable(["pi"], deps), null);
  files.delete("/opt/homebrew/bin/dsh"); assert.equal(await resolveExecutable(["dsh"], deps), null);
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
test("history Agent discovery never waits for version or login commands", async () => {
  const deps = fakeDeps(new Set(["/bin/pi", "/bin/claude", "/bin/codebuddy"]), new Map());
  deps.exec = async () => { throw new Error("History discovery must not execute a login or version probe"); };
  const service = new AgentOnboardingService(deps);
  try {
    const result = await service.historyStatus();
    assert.equal(result.agents.filter(agent => agent.installed && agent.historyImport).length, 3);
    assert.deepEqual(deps.spawned, []);
  } finally { service.close(); }
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
  assert.equal(connectedAgentModelId("pi"), "pi-cli:current");
  assert.equal(connectedAgentEngineId("pi-cli:provider:model"), "pi-cli");
  assert.equal(connectedAgentEngineId("picli_native"), "pi-cli");
  assert.equal(connectedAgentEngineId("pi_existing_durable"), null, "native CLI routing cannot take over the existing durable Pi engine");
  assert.equal(connectedAgentModelId("dsh"), "dsh-acp:current");
  assert.equal(connectedAgentEngineId("dsh-acp:deepseek-v4"), "dsh-acp");
  assert.equal(connectedAgentEngineId("dsh_acp_native"), "dsh-acp");
  assert.equal(connectedAgentModelId("gemini"), "gemini:current");
  assert.equal(connectedAgentEngineId("gemini:gemini-2.5-pro"), "gemini");
  assert.equal(connectedAgentEngineId("gemini_native_session"), "gemini");
});

test("Gemini macOS app helper agy is discovered and supports interactive OAuth code submission", async () => {
  const agyPath = "/Applications/Gemini.app/Contents/Helpers/agy";
  const files = new Set([agyPath]);
  const deps = { env: { PATH: "/usr/bin" }, homedir: "/Users/me", exists: async (file: string) => files.has(file), cursorVersions: async () => [] };
  assert.equal(await resolveExecutable(["agy", "gemini"], deps), agyPath);
  assert.deepEqual(interpretAuth("gemini", "", "Error: Please sign in to view available models.", 1), { authenticated: false, account: null });
  assert.deepEqual(interpretAuth("gemini", "gemini-2.5-pro\ngemini-2.5-flash\n", "", 0), { authenticated: true, account: null });

  let written = "";
  let finishExit: (res: { code: number | null }) => void = () => {};
  const onboardingDeps: OnboardingDeps = {
    ...deps,
    async exec(_cmd, args) {
      if (args[0] === "--version") return { stdout: "1.5.5\n", stderr: "", code: 0 };
      return written ? { stdout: "gemini-2.5-pro\n", stderr: "", code: 0 } : { stdout: "", stderr: "Error: Please sign in to view available models.", code: 1 };
    },
    spawn() {
      return {
        kill() {},
        write(input: string) { written += input; finishExit({ code: 0 }); },
        exited: new Promise(resolvePromise => { finishExit = resolvePromise; }),
        onOutput(listener) {
          listener("Open this link in a browser to log in with Google:\n  https://accounts.google.com/o/oauth2/auth?client_id=test\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n");
        },
      };
    },
  };
  const service = new AgentOnboardingService(onboardingDeps);
  try {
    const initial = (await service.status()).agents.find(a => a.id === "gemini")!;
    assert.equal(initial.installed, true);
    assert.equal(initial.version, "1.5.5");
    assert.equal(initial.authenticated, false);

    const signingIn = (await service.act({ id: "gemini", action: "sign-in" })).agents.find(a => a.id === "gemini")!;
    assert.equal(signingIn.activity?.awaitingCode, true);
    assert.equal(signingIn.activity?.url, "https://accounts.google.com/o/oauth2/auth?client_id=test");

    const completed = (await service.act({ id: "gemini", action: "submit-code", code: "4/0AdTestAuthCode" })).agents.find(a => a.id === "gemini")!;
    assert.equal(written, "4/0AdTestAuthCode\n");
    assert.equal(completed.authenticated, true);
  } finally {
    service.close();
  }
});

test("Pi native readiness and terminal setup are identical for local and Bash-enrolled Hosts", async () => {
  const table = "provider  model  context  max-out  thinking  images\nfixture  vision  1M  128K  yes  yes\n";
  assert.equal(interpretAuth("pi", table, "", 0).authenticated, true);
  assert.equal(interpretAuth("pi", "No models available", "", 0).authenticated, false);
  assert.equal(interpretAuth("pi", table, "failed", 1).authenticated, null);
  const deps = fakeDeps(new Set(["/bin/pi", "/bin/npm"]), new Map([
    ["/bin/pi --version", { stdout: "1.5.2" }], ["/bin/pi --list-models --offline", { stdout: table }],
  ]));
  const service = new AgentOnboardingService(deps);
  try {
    const pi = (await service.status()).agents.find(agent => agent.id === "pi")!;
    assert.equal(pi.installed, true); assert.equal(pi.authenticated, true);
    assert.equal(pi.engineId, "pi-cli"); assert.equal(pi.setupCommand, "pi");
    assert.equal(deps.spawned.length, 0, "checking readiness never installs or prompts");
    await assert.rejects(service.act({ id: "pi", action: "sign-in" }), /native agent client/);
    await service.act({ id: "pi", action: "install" });
    assert.deepEqual(deps.spawned, [["/bin/npm", "install", "-g", "@earendil-works/pi-coding-agent"]]);
  } finally { service.close(); }
});

test("package install uses the fixed package name", async () => {
  const deps = fakeDeps(new Set(["/bin/npm"]), new Map());
  const service = new AgentOnboardingService(deps);
  await service.act({ id: "codebuddy", action: "install" });
  assert.deepEqual(deps.spawned, [["/bin/npm", "install", "-g", "@tencent-ai/codebuddy-code"]]);
  service.close();
});
