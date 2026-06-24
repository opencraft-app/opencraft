import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

register(new URL("./css-module-loader.mjs", import.meta.url));

test("new session surface renders the setup controls before session creation", async () => {
  const { NewSessionSurface } = await import("../src/new-session");
  const html = renderToStaticMarkup(
    <NewSessionSurface
      agentConfig={{
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "high",
        permission_mode: "auto",
      }}
      backendOptions={[{ id: "codex", label: "Codex" }]}
      initialPrompt=""
      modelOptions={[{ id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" }]}
      permissionModeOptions={[{ id: "auto", label: "Default permissions" }]}
      reasoningEffortOptions={[{ id: "high", label: "High" }]}
      selectedBackend="codex"
      selectedModel="gpt-5.3-codex-spark"
      selectedPermissionMode="auto"
      selectedReasoningEffort="high"
      workingDirectory="/Users/example/project"
      onBackendChange={() => undefined}
      onInitialPromptChange={() => undefined}
      onModelChange={() => undefined}
      onPermissionModeChange={() => undefined}
      onReasoningEffortChange={() => undefined}
      onSubmit={() => undefined}
      onWorkingDirectoryChange={() => undefined}
    />,
  );

  assert.match(html, /New session/);
  assert.match(html, /Workspace/);
  assert.match(html, /Codex/);
  assert.match(html, /GPT-5\.3 Codex Spark/);
  assert.match(html, /Default permissions/);
  assert.match(html, /Create session/);
});

test("new session surface disables submit until a workspace is selected", async () => {
  const { NewSessionSurface } = await import("../src/new-session");
  const html = renderToStaticMarkup(
    <NewSessionSurface
      agentConfig={{ model: "gpt-5.3-codex-spark" }}
      backendOptions={[{ id: "codex", label: "Codex" }]}
      initialPrompt=""
      modelOptions={[{ id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" }]}
      permissionModeOptions={[{ id: "auto", label: "Default permissions" }]}
      reasoningEffortOptions={[]}
      selectedBackend="codex"
      selectedModel="gpt-5.3-codex-spark"
      selectedPermissionMode="auto"
      selectedReasoningEffort=""
      workingDirectory=""
      onBackendChange={() => undefined}
      onInitialPromptChange={() => undefined}
      onModelChange={() => undefined}
      onPermissionModeChange={() => undefined}
      onReasoningEffortChange={() => undefined}
      onSubmit={() => undefined}
      onWorkingDirectoryChange={() => undefined}
    />,
  );

  assert.match(html, /disabled=""/);
});

test("new session surface shows backend status errors", async () => {
  const { NewSessionSurface } = await import("../src/new-session");
  const html = renderToStaticMarkup(
    <NewSessionSurface
      agentConfig={{}}
      backendOptions={[{ id: "codex", label: "Codex (error)", disabled: true }]}
      backendStatusMessage="model discovery failed: invalid Codex config"
      initialPrompt=""
      modelOptions={[]}
      permissionModeOptions={[]}
      reasoningEffortOptions={[]}
      selectedBackend=""
      selectedModel=""
      selectedPermissionMode=""
      selectedReasoningEffort=""
      workingDirectory="/Users/example/project"
      onBackendChange={() => undefined}
      onInitialPromptChange={() => undefined}
      onModelChange={() => undefined}
      onPermissionModeChange={() => undefined}
      onReasoningEffortChange={() => undefined}
      onSubmit={() => undefined}
      onWorkingDirectoryChange={() => undefined}
    />,
  );

  assert.match(html, /model discovery failed: invalid Codex config/);
  assert.match(html, /disabled=""/);
});
