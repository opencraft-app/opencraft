import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AGENT_PROVIDERS,
  BUILTIN_CODEX_VERSION,
  builtinSource,
  externalSource,
} from "../../packages/agent-bridge-protocol/src/index.ts";
import { codexDeclaration } from "../../apps/agent-bridge-host/src/codex-declaration.ts";
import { ONBOARDING_AGENTS, ONBOARDING_AGENT_ENGINES } from "../../apps/local-agent-host/src/agent-onboarding.ts";

test("the builtin Codex is one source of the Codex provider, beside the user-installed one", () => {
  const codex = AGENT_PROVIDERS.find((provider) => provider.id === "codex")!;
  assert.deepEqual(
    codex.sources.map((source) => source.kind),
    ["builtin", "external"],
  );
  assert.equal(builtinSource(codex)?.nativeVersion, BUILTIN_CODEX_VERSION);
  assert.equal(externalSource(codex)?.installPackage, "@openai/codex");
  for (const provider of AGENT_PROVIDERS.filter((provider) => provider.id !== "codex")) {
    assert.equal(builtinSource(provider), null, `${provider.id} has no builtin source`);
  }
});

test("one pinned version: the packaged runtime, the catalog and the bridge declaration agree", async () => {
  const runtime = JSON.parse(await readFile(new URL("../../runtime/codex/package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(runtime.dependencies["@openai/codex"], BUILTIN_CODEX_VERSION);
  assert.equal(codexDeclaration.minNativeVersion, BUILTIN_CODEX_VERSION);
});

test("onboarding still sees exactly the user-installed agents it saw before", () => {
  assert.deepEqual(ONBOARDING_AGENT_ENGINES, {
    codex: "codex",
    cursor: "cursor",
    claude: "claude-code",
    codebuddy: "codebuddy",
  });
  assert.deepEqual(
    ONBOARDING_AGENTS.map((agent) => ({ ...agent })),
    [
      {
        id: "codex",
        name: "Codex",
        commands: ["codex"],
        versionArgs: ["--version"],
        statusArgs: ["login", "status"],
        signInArgs: ["login"],
        signInEnv: { BROWSER: "/usr/bin/true" },
        installPackage: "@openai/codex",
        installUrl: "https://developers.openai.com/codex/cli",
      },
      {
        id: "cursor",
        name: "Cursor",
        commands: ["cursor-agent"],
        versionArgs: ["--version"],
        statusArgs: ["status"],
        signInArgs: ["login"],
        signInEnv: { NO_OPEN_BROWSER: "1" },
        installPackage: null,
        installUrl: "https://cursor.com/docs/cli/installation",
      },
      {
        id: "claude",
        name: "Claude Code",
        commands: ["claude"],
        versionArgs: ["--version"],
        statusArgs: ["auth", "status"],
        signInArgs: ["auth", "login"],
        signInEnv: { BROWSER: "/usr/bin/true" },
        installPackage: null,
        installUrl: "https://code.claude.com/docs/en/setup",
      },
      {
        id: "codebuddy",
        name: "CodeBuddy",
        commands: ["codebuddy", "cbc"],
        versionArgs: ["--version"],
        statusArgs: ["--version"],
        signInArgs: ["auth", "login"],
        signInEnv: {},
        installPackage: "@tencent-ai/codebuddy-code",
        installUrl: "https://www.codebuddy.cn/cli/",
      },
    ],
  );
});
