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
