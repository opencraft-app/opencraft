import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { BackendWire } from "../../../../packages/vela-chat-client/src";

register(
  new URL(
    "../../../../packages/vela-chat-web/tests/css-module-loader.mjs",
    import.meta.url,
  ),
);

test("desktop new session page renders setup controls by default", async () => {
  const { DesktopNewSessionPage } = await import("./DesktopNewSessionPage");
  const html = renderToStaticMarkup(
    <DesktopNewSessionPage
      backends={[codexBackend()]}
      defaultBackend="codex"
      defaultWorkingDirectory="/Users/example/project"
      preferredBackends={["codex", "acp", "pi"]}
      onDefaultBackendChange={() => undefined}
      onSubmit={() => undefined}
    />,
  );

  assert.match(html, /New session/);
  assert.match(html, /Workspace/);
  assert.ok(html.includes("/Users/example/project"));
  assert.match(html, /Codex/);
  assert.match(html, /GPT-5\.3 Codex Spark/);
  assert.match(html, /High/);
  assert.match(html, /Default permissions/);
  assert.match(html, /Create session/);
});

test("desktop new session exposes native folder picker only for local electron backends", async () => {
  const { DesktopNewSessionPage, canUseNativeWorkingDirectoryPicker } = await import(
    "./DesktopNewSessionPage"
  );

  assert.equal(canUseNativeWorkingDirectoryPicker("electron", codexBackend()), true);
  assert.equal(canUseNativeWorkingDirectoryPicker("web", codexBackend()), false);
  assert.equal(
    canUseNativeWorkingDirectoryPicker("electron", {
      ...codexBackend(),
      location: { kind: "remote", label: "Remote VM" },
    }),
    false,
  );

  const html = renderToStaticMarkup(
    <DesktopNewSessionPage
      backends={[codexBackend()]}
      defaultBackend="codex"
      defaultWorkingDirectory="/Users/example/project"
      preferredBackends={["codex"]}
      runtimeHostKind="electron"
      onDefaultBackendChange={() => undefined}
      onSelectWorkingDirectory={async () => "/Users/example/next"}
      onSubmit={() => undefined}
    />,
  );
  assert.match(html, /Choose workspace folder/);

  const webHtml = renderToStaticMarkup(
    <DesktopNewSessionPage
      backends={[codexBackend()]}
      defaultBackend="codex"
      defaultWorkingDirectory="/Users/example/project"
      preferredBackends={["codex"]}
      runtimeHostKind="web"
      onDefaultBackendChange={() => undefined}
      onSelectWorkingDirectory={async () => "/Users/example/next"}
      onSubmit={() => undefined}
    />,
  );
  assert.doesNotMatch(webHtml, /Choose workspace folder/);
});

function codexBackend(): BackendWire {
  return {
    kind: "codex",
    status: "available",
    display_name: "Codex",
    location: { kind: "local", label: "Local" },
    capabilities: {
      streaming: true,
      cancel: true,
      permission_requests: true,
      structured_diff: true,
      session_agent_config: true,
    },
    models: [
      {
        id: "gpt-5.3-codex-spark",
        label: "GPT-5.3 Codex Spark",
        is_default: true,
        reasoning_efforts: [{ id: "high", label: "High", is_default: true }],
      },
    ],
    permission_modes: [{ id: "auto", label: "Default permissions", is_default: true }],
    features: [],
  };
}
