import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";

register(new URL("../../../packages/vela-chat-web/tests/css-module-loader.mjs", import.meta.url));

const {
  DesktopSettingsPage,
  DesktopSettingsSidebar,
} = await import("./DesktopSettingsPage");

function codexBackend() {
  return {
    kind: "codex" as const,
    status: "available" as const,
    display_name: "Codex",
    location: { kind: "local" as const, label: "Local" },
    capabilities: {
      streaming: true,
      cancel: true,
      permission_requests: true,
      structured_diff: true,
      session_agent_config: true,
    },
    models: [],
    permission_modes: [],
    features: [],
  };
}

function testClient() {
  return {
    getBackendSettings: async () => ({
      schema: "velad.backend_settings.v1",
      backend: "vela_engine",
      settings: { endpoint: "", api_key_set: false, model: "" },
      status: "unconfigured",
      missing_fields: ["endpoint", "api_key", "model"],
      updated_at: null,
    }),
    updateBackendSettings: async () => ({
      schema: "velad.backend_settings.v1",
      backend: "vela_engine",
      settings: { endpoint: "", api_key_set: false, model: "" },
      status: "unconfigured",
      missing_fields: ["endpoint", "api_key", "model"],
      updated_at: null,
    }),
    getNodeProviders: async () => ({
      schema: "velad.node_providers.v1",
      providers: [
        {
          id: "ssh",
          display_name: "SSH",
          kind: "ssh",
          auth_methods: ["password"],
          secret_storage: "local_os_keyring",
          capabilities: {},
          target_constraints: { os: ["linux", "darwin"], arch: ["x86_64", "amd64"] },
        },
      ],
    }),
    listNodes: async () => ({
      schema: "velad.nodes.v1",
      nodes: [],
    }),
    createNode: async () => ({
      schema: "velad.nodes.v1",
      node: {
        id: "node_1",
        provider: "ssh",
        display_name: "Remote dev",
        ssh: { host: "dev.example.com", port: 22, username: "root" },
        target: { os: "linux", arch: "x86_64" },
        auth: { method: "password", password_configured: true },
        created_at: "2026-06-26T00:00:00Z",
        updated_at: "2026-06-26T00:00:00Z",
      },
    }),
    getRuntimeTargets: async () => ({
      schema: "velad.runtime_targets.v1",
      targets: [
        {
          id: "local",
          kind: "local",
          provider: "local",
          display_name: "本机 velad",
          status: "ready",
          transport: { kind: "local" },
        },
      ],
    }),
    connectRuntimeTarget: async (targetId: string) => ({
      schema: "velad.runtime_targets.v1",
      target: {
        id: targetId,
        kind: "remote",
        provider: "ssh",
        node_id: "node_1",
        display_name: "Remote dev",
        status: "ready",
        transport: {
          kind: "ssh",
          api_base_url: "http://127.0.0.1:49200/api/v1",
          remote_listen_addr: "127.0.0.1:0",
        },
      },
    }),
    disconnectRuntimeTarget: async (targetId: string) => ({
      schema: "velad.runtime_targets.v1",
      target: {
        id: targetId,
        kind: "remote",
        provider: "ssh",
        node_id: "node_1",
        display_name: "Remote dev",
        status: "disconnected",
        transport: { kind: "ssh" },
      },
    }),
  } as any;
}

test("desktop engine settings render in their own sidebar tab", () => {
  const html = renderToStaticMarkup(
    <DesktopSettingsPage
      apiBaseUrl="/api/v1"
      backends={[codexBackend()]}
      client={testClient()}
      hostLabel="Browser preview"
      appVersion="0.0.1"
      activePanel="engine"
      selectedBackend="codex"
      onSelectedBackendChange={() => {}}
    />,
  );

  assert.match(html, /aria-label="Engine settings"/);
  assert.match(html, />引擎</);
  assert.match(html, />默认 backend</);
  assert.match(html, /当前可用：Codex/);
  assert.match(html, />Vela 内置引擎</);
  assert.match(html, />Vela 内置引擎 Endpoint</);
  assert.match(html, />Vela 内置引擎 Key</);
  assert.match(html, />Vela 内置引擎 Model</);
  assert.match(html, />velad API</);
  assert.match(html, />\/api\/v1</);
  assert.doesNotMatch(html, />工作模式</);
  assert.doesNotMatch(html, />默认打开目标</);
});

test("desktop settings sidebar exposes return and navigation inside shell chrome", () => {
  const html = renderToStaticMarkup(
    <DesktopSettingsSidebar
      activePanel="engine"
      showTrafficLights
      onClose={() => {}}
      onPanelChange={() => {}}
    />,
  );

  assert.match(html, /class="[^"]*vela-settings-sidebar/);
  assert.match(html, />返回应用</);
  assert.match(html, /placeholder="搜索设置\.\.\."/);
  assert.doesNotMatch(html, />常规</);
  assert.match(html, />引擎</);
  assert.match(html, />节点</);
  assert.match(html, />关于 LightVela</);
  assert.match(html, />已归档对话</);
  assert.doesNotMatch(html, />个人资料</);
  assert.doesNotMatch(html, />MCP 服务器</);
  assert.doesNotMatch(html, />工作树</);
});

test("desktop nodes settings render ssh runtime target entry", () => {
  const html = renderToStaticMarkup(
    <DesktopSettingsPage
      apiBaseUrl="/api/v1"
      appVersion="0.0.1"
      activePanel="nodes"
      backends={[codexBackend()]}
      client={testClient()}
      hostLabel="Browser preview"
      selectedBackend="codex"
      onSelectedBackendChange={() => {}}
    />,
  );

  assert.match(html, /aria-label="Node settings"/);
  assert.match(html, />节点</);
  assert.match(html, />SSH 主机</);
  assert.match(html, />新增并连接</);
  assert.match(html, />Runtime targets</);
  assert.match(html, /aria-label="SSH Host"/);
  assert.match(html, /aria-label="SSH Password"/);
});

test("desktop settings renders about panel with current version", () => {
  const html = renderToStaticMarkup(
    <DesktopSettingsPage
      apiBaseUrl="/api/v1"
      appVersion="0.0.7"
      activePanel="about"
      backends={[]}
      client={testClient()}
      hostLabel="Browser preview"
      selectedBackend=""
      onSelectedBackendChange={() => {}}
    />,
  );

  assert.match(html, />关于 LightVela</);
  assert.match(html, />当前版本</);
  assert.match(html, />0\.0\.7</);
  assert.match(html, /云端专属个人 Agent/);
  assert.match(html, /https:\/\/lightvela\.com/);
  assert.doesNotMatch(html, />Backend</);
});

test("desktop nodes settings create and connect ssh node", async () => {
  const dom = installDomRuntime();
  try {
    const createInputs: unknown[] = [];
    const connectIds: string[] = [];
    let createdNode: Record<string, unknown> | null = null;
    const client = {
      ...testClient(),
      listNodes: async () => ({
        schema: "velad.nodes.v1",
        nodes: createdNode ? [createdNode] : [],
      }),
      getRuntimeTargets: async () => ({
        schema: "velad.runtime_targets.v1",
        targets: createdNode
          ? [
              {
                id: "target:node_1",
                kind: "remote",
                provider: "ssh",
                node_id: "node_1",
                display_name: "Dev box",
                status: connectIds.length > 0 ? "ready" : "disconnected",
                transport: {
                  kind: "ssh",
                  api_base_url: "http://127.0.0.1:49200/api/v1",
                  remote_listen_addr: "127.0.0.1:0",
                },
              },
            ]
          : [],
      }),
      createNode: async (input: unknown) => {
        createInputs.push(input);
        createdNode = {
          id: "node_1",
          provider: "ssh",
          display_name: "Dev box",
          ssh: { host: "192.168.50.10", port: 22, username: "root" },
          target: { os: "linux", arch: "x86_64" },
          auth: { method: "password", password_configured: true },
          created_at: "2026-06-26T00:00:00Z",
          updated_at: "2026-06-26T00:00:00Z",
        };
        return { schema: "velad.nodes.v1", node: createdNode };
      },
      connectRuntimeTarget: async (targetId: string) => {
        connectIds.push(targetId);
        return {
          schema: "velad.runtime_targets.v1",
          target: {
            id: targetId,
            kind: "remote",
            provider: "ssh",
            node_id: "node_1",
            display_name: "Dev box",
            status: "ready",
            transport: {
              kind: "ssh",
              api_base_url: "http://127.0.0.1:49200/api/v1",
              remote_listen_addr: "127.0.0.1:0",
            },
          },
        };
      },
    } as any;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <DesktopSettingsPage
          apiBaseUrl="/api/v1"
          appVersion="0.0.1"
          activePanel="nodes"
          backends={[codexBackend()]}
          client={client}
          hostLabel="Browser preview"
          selectedBackend="codex"
          onSelectedBackendChange={() => {}}
        />,
      );
    });
    await flushDom();

    const name = document.querySelector<HTMLInputElement>('input[aria-label="SSH 节点名称"]');
    const host = document.querySelector<HTMLInputElement>('input[aria-label="SSH Host"]');
    const username = document.querySelector<HTMLInputElement>('input[aria-label="SSH Username"]');
    const password = document.querySelector<HTMLInputElement>('input[aria-label="SSH Password"]');
    assert.notEqual(name, null);
    assert.notEqual(host, null);
    assert.notEqual(username, null);
    assert.notEqual(password, null);

    await changeInput(name!, "Dev box");
    await changeInput(host!, "192.168.50.10");
    await changeInput(username!, "root");
    await changeInput(password!, "pw");

    const submit = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("新增并连接"),
    );
    assert.notEqual(submit, undefined);

    await act(async () => {
      submit!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushDom();

    assert.deepEqual(createInputs, [
      {
        auth: { method: "password", password: "pw" },
        displayName: "Dev box",
        provider: "ssh",
        ssh: { host: "192.168.50.10", port: 22, username: "root" },
        target: { arch: "x86_64", os: "linux" },
      },
    ]);
    assert.deepEqual(connectIds, ["target:node_1"]);
    assert.equal(password!.value, "");

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("desktop engine text settings keep focus and save on blur", async () => {
  const dom = installDomRuntime();
  try {
    const updates: Array<Record<string, string>> = [];
    let refreshCount = 0;
    const client = {
      getBackendSettings: async () => ({
        schema: "velad.backend_settings.v1",
        backend: "vela_engine",
        settings: { endpoint: "", api_key_set: false, model: "" },
        status: "unconfigured",
        missing_fields: ["endpoint", "api_key", "model"],
        updated_at: null,
      }),
      updateBackendSettings: async (_backend: string, patch: Record<string, string>) => {
        updates.push(patch);
        return {
          schema: "velad.backend_settings.v1",
          backend: "vela_engine",
          settings: { endpoint: patch.endpoint ?? "", api_key_set: Boolean(patch.api_key), model: patch.model ?? "" },
          status: "configured",
          missing_fields: [],
          updated_at: "2026-06-25T00:00:00Z",
        };
      },
    } as any;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <DesktopSettingsPage
          apiBaseUrl="/api/v1"
          appVersion="0.0.1"
          activePanel="engine"
          backends={[codexBackend()]}
          client={client}
          hostLabel="Browser preview"
          selectedBackend="codex"
          onBackendSettingsChange={() => {
            refreshCount += 1;
          }}
          onSelectedBackendChange={() => {}}
        />,
      );
    });
    await flushDom();

    const endpoint = document.querySelector<HTMLInputElement>(
      'input[aria-label="Vela 内置引擎 Endpoint"]',
    );
    const apiKey = document.querySelector<HTMLInputElement>(
      'input[aria-label="Vela 内置引擎 Key"]',
    );
    assert.notEqual(endpoint, null);
    assert.notEqual(apiKey, null);

    endpoint!.focus();
    await changeInput(endpoint!, "https://example.test/v1");
    assert.equal(document.activeElement, endpoint);
    assert.deepEqual(updates, []);
    assert.equal(refreshCount, 0);
    assert.equal(endpoint!.value, "https://example.test/v1");

    await blurInput(endpoint!);
    assert.deepEqual(updates, [{ endpoint: "https://example.test/v1" }]);
    assert.equal(refreshCount, 1);

    apiKey!.focus();
    await changeInput(apiKey!, "secret");
    assert.equal(document.activeElement, apiKey);
    assert.deepEqual(updates, [{ endpoint: "https://example.test/v1" }]);
    assert.equal(refreshCount, 1);
    assert.equal(apiKey!.value, "secret");

    await blurInput(apiKey!);
    assert.deepEqual(updates, [
      { endpoint: "https://example.test/v1" },
      { api_key: "secret" },
    ]);
    assert.equal(refreshCount, 2);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

function installDomRuntime() {
  const window = new Window({ url: "http://127.0.0.1:5173/settings" });
  const previous = {
    document: globalThis.document,
    Event: globalThis.Event,
    FocusEvent: globalThis.FocusEvent,
    HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    InputEvent: globalThis.InputEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
    window: globalThis.window,
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: window.document,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: window.navigator,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: window.HTMLElement,
  });
  Object.defineProperty(globalThis, "HTMLInputElement", {
    configurable: true,
    value: window.HTMLInputElement,
  });
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    value: window.Node,
  });
  Object.defineProperty(globalThis, "Event", {
    configurable: true,
    value: window.Event,
  });
  Object.defineProperty(globalThis, "InputEvent", {
    configurable: true,
    value: window.InputEvent,
  });
  Object.defineProperty(globalThis, "FocusEvent", {
    configurable: true,
    value: window.FocusEvent,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });

  return {
    restore() {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previous.window,
      });
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previous.document,
      });
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: previous.navigator,
      });
      Object.defineProperty(globalThis, "HTMLElement", {
        configurable: true,
        value: previous.HTMLElement,
      });
      Object.defineProperty(globalThis, "HTMLInputElement", {
        configurable: true,
        value: previous.HTMLInputElement,
      });
      Object.defineProperty(globalThis, "Node", {
        configurable: true,
        value: previous.Node,
      });
      Object.defineProperty(globalThis, "Event", {
        configurable: true,
        value: previous.Event,
      });
      Object.defineProperty(globalThis, "InputEvent", {
        configurable: true,
        value: previous.InputEvent,
      });
      Object.defineProperty(globalThis, "FocusEvent", {
        configurable: true,
        value: previous.FocusEvent,
      });
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        configurable: true,
        value: previous.IS_REACT_ACT_ENVIRONMENT,
      });
    },
  };
}

async function flushDom() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function blurInput(input: HTMLInputElement) {
  await act(async () => {
    input.blur();
    await Promise.resolve();
  });
}
