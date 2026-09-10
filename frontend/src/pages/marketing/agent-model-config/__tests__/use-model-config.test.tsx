import { generateKeyPairSync } from "node:crypto";

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  HERMES_MODEL_CONFIG_JSON_END,
  HERMES_MODEL_CONFIG_JSON_START,
} from "../hermes-model-config-command";
import {
  type HermesConfiguredModel,
  type HermesModelConfigAction,
  type HermesModelConfigSnapshot,
} from "../model-config-client";
import { getHermesModelIdentity, useModelConfig } from "../use-model-config";

const model: HermesConfiguredModel = {
  id: "model-a",
  providerKey: "lightvela-a",
  providerName: "Provider A",
  baseUrl: "https://a.example.com/v1",
  apiMode: "chat_completions",
  keyEnv: "PROVIDER_A_KEY",
};

const initialSnapshot: HermesModelConfigSnapshot = {
  primary: null,
  fallbacks: [],
  configuredModels: [model],
};

it("preserves model ID case while normalizing provider and endpoint identity", () => {
  expect(getHermesModelIdentity(model)).not.toBe(getHermesModelIdentity({ ...model, id: model.id.toUpperCase() }));
  expect(getHermesModelIdentity(model)).toBe(getHermesModelIdentity({ ...model, providerKey: model.providerKey.toUpperCase(), baseUrl: `${model.baseUrl}/` }));
});
const { publicKey: testPublicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function output(snapshot: HermesModelConfigSnapshot) {
  return [
    HERMES_MODEL_CONFIG_JSON_START,
    JSON.stringify({ ok: true, snapshot }),
    HERMES_MODEL_CONFIG_JSON_END,
  ].join("\n");
}

function payloadOutput(payload: Record<string, unknown>) {
  return [
    HERMES_MODEL_CONFIG_JSON_START,
    JSON.stringify({ ok: true, ...payload }),
    HERMES_MODEL_CONFIG_JSON_END,
  ].join("\n");
}

function decodeAction(command: string): HermesModelConfigAction {
  const match = command.match(/\$HERMES_PYTHON" - "([A-Za-z0-9+/=]+)"/);
  const encodedAction = match?.[1];
  if (!encodedAction) throw new Error("Missing action payload");
  return JSON.parse(Buffer.from(encodedAction, "base64").toString("utf8")) as HermesModelConfigAction;
}

describe("useModelConfig", () => {
  it.each(["switch", "unmount"])("discards a pending append after %s", async (change) => {
    let finish!: (value: { status: string; exitCode: number; output: string }) => void;
    const pending = new Promise<{ status: string; exitCode: number; output: string }>((resolve) => { finish = resolve; });
    const execDebugCommand = vi.fn(async (_id: string, command: string) => {
      if (decodeAction(command).type === "appendProviderModel") return pending;
      return { status: "Succeeded", exitCode: 0, output: output(initialSnapshot) };
    });
    const { result, rerender, unmount } = renderHook(({ botId }) => useModelConfig({ botId, execDebugCommand }), { initialProps: { botId: "bot-1" } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let response!: Promise<unknown>;
    act(() => { response = result.current.append(model, "new-model"); });
    if (change === "unmount") unmount();
    else {
      rerender({ botId: "bot-2" });
      await waitFor(() => expect(result.current.loading).toBe(false));
    }
    await act(async () => {
      finish({ status: "Succeeded", exitCode: 0, output: output({ ...initialSnapshot, configuredModels: [{ ...model, id: "new-model" }] }) });
      expect(await response).toBeNull();
    });
    expect(execDebugCommand.mock.calls.filter(([, command]) => decodeAction(command).type === "appendProviderModel").map(([id]) => id)).toEqual(["bot-1"]);
    if (change === "switch") expect(result.current.snapshot).toEqual(initialSnapshot);
  });

  it("discards a cancelled saved-model check and allows the next operation", async () => {
    let finish: ((value: { status: string; exitCode: number; output: string }) => void) | undefined;
    const pending = new Promise<{ status: string; exitCode: number; output: string }>((resolve) => { finish = resolve; });
    const execDebugCommand = vi.fn(async (_id: string, command: string) => {
      const action = decodeAction(command);
      if (action.type === "probeConfiguredModel") return pending;
      return { status: "Succeeded", exitCode: 0, output: output(initialSnapshot) };
    });
    const { result } = renderHook(() => useModelConfig({ botId: "bot-1", execDebugCommand }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let response: Promise<unknown>;
    act(() => { response = result.current.testConnection({ anchor: model, modelId: "model-new" }); });
    expect(result.current.operation).toBe("configured-connectivity-probe");
    act(() => result.current.cancelProbe());
    expect(result.current.operation).toBeNull();
    await act(async () => {
      finish!({ status: "Succeeded", exitCode: 0, output: payloadOutput({connection: { success: true, provider: model.providerKey, model: "model-new", baseUrl: model.baseUrl }}) });
      expect(await response!).toBeNull();
    });
    expect(result.current.snapshot).toEqual(initialSnapshot);
    expect(result.current.operationError).toBeNull();
  });

  it("does not reload when only the execDebugCommand reference changes", async () => {
    const execDebugCommandA = vi.fn(async () => ({
      status: "Succeeded",
      exitCode: 0,
      output: output(initialSnapshot),
    }));
    const execDebugCommandB = vi.fn(async () => ({
      status: "Succeeded",
      exitCode: 0,
      output: output(initialSnapshot),
    }));

    function Harness({ execDebugCommand }: {
      execDebugCommand: typeof execDebugCommandA;
    }) {
      useModelConfig({ botId: "bot-1", execDebugCommand });
      return <span>ready</span>;
    }

    const { rerender } = render(<Harness execDebugCommand={execDebugCommandA} />);
    await waitFor(() => expect(execDebugCommandA).toHaveBeenCalledTimes(1));

    rerender(<Harness execDebugCommand={execDebugCommandB} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(execDebugCommandA).toHaveBeenCalledTimes(1);
    expect(execDebugCommandB).not.toHaveBeenCalled();
  });

  it("synchronously rejects overlapping mutations before React can render the busy state", async () => {
    let resolveMutation: ((value: { status: string; exitCode: number; output: string }) => void) | undefined;
    const pendingMutation = new Promise<{ status: string; exitCode: number; output: string }>((resolve) => {
      resolveMutation = resolve;
    });
    const actions: HermesModelConfigAction[] = [];
    const execDebugCommand = vi.fn(async (_botId: string, command: string) => {
      const action = decodeAction(command);
      actions.push(action);
      if (action.type === "assign") return pendingMutation;
      return { status: "Succeeded", exitCode: 0, output: output(initialSnapshot) };
    });

    function Harness() {
      const controller = useModelConfig({ botId: "bot-1", execDebugCommand });
      return (
        <button
          type="button"
          onClick={() => {
            void controller.assign(model, "fallback");
            void controller.assign(model, "primary");
          }}
        >
          run two mutations
        </button>
      );
    }

    render(<Harness />);
    const trigger = await screen.findByRole("button", { name: "run two mutations" });
    await waitFor(() => expect(actions.some((action) => action.type === "read")).toBe(true));
    await userEvent.click(trigger);

    expect(actions.filter((action) => action.type === "assign")).toEqual([{
      type: "assign",
      providerKey: model.providerKey,
      modelId: model.id,
      baseUrl: model.baseUrl,
      routeBaseUrl: model.baseUrl,
      purpose: "fallback",
    }]);

    await act(async () => {
      resolveMutation?.({
        status: "Succeeded",
        exitCode: 0,
        output: output({ ...initialSnapshot, fallbacks: [model] }),
      });
      await pendingMutation;
    });
  });

  it("removes one fallback by model identity", async () => {
    const actions: HermesModelConfigAction[] = [];
    const execDebugCommand = vi.fn(async (_botId: string, command: string) => {
      const action = decodeAction(command);
      actions.push(action);
      return { status: "Succeeded", exitCode: 0, output: output({ ...initialSnapshot, fallbacks: [model] }) };
    });

    function Harness() {
      const controller = useModelConfig({ botId: "bot-1", execDebugCommand });
      return <button type="button" onClick={() => void controller.removeFallback(model)}>remove fallback</button>;
    }

    render(<Harness />);
    await waitFor(() => expect(actions.some((action) => action.type === "read")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "remove fallback" }));

    await waitFor(() => expect(actions).toContainEqual({
      type: "removeFallback",
      providerKey: model.providerKey,
      modelId: model.id,
      baseUrl: model.baseUrl,
      routeBaseUrl: model.baseUrl,
    }));
  });

  it("tests the selected model connection without mutating the snapshot", async () => {
    const actions: HermesModelConfigAction[] = [];
    const execDebugCommand = vi.fn(async (_botId: string, command: string) => {
      const action = decodeAction(command);
      actions.push(action);
      if (action.type === "prepareCredentialEnvelope") {
        return {
          status: "Succeeded",
          exitCode: 0,
          output: payloadOutput({ credentialEnvelope: { token: "a".repeat(48), publicKey: testPublicKey } }),
        };
      }
      if (action.type === "connectivityProbe") {
        return {
          status: "Succeeded",
          exitCode: 0,
          output: payloadOutput({
            connection: {
              success: true,
              provider: model.providerKey,
              model: model.id,
              baseUrl: model.baseUrl,
              timeMs: 128,
            },
          }),
        };
      }
      return { status: "Succeeded", exitCode: 0, output: output(initialSnapshot) };
    });

    function Harness() {
      const controller = useModelConfig({ botId: "bot-1", execDebugCommand });
      const [result, setResult] = useState("none");
      return (
        <>
          <span>{result}</span>
          <button
            type="button"
            onClick={async () => {
              const connection = await controller.testConnection({ apiKey: "secret", model });
              setResult(connection?.success ? `${connection.timeMs} ms` : "failed");
            }}
          >
            test connection
          </button>
        </>
      );
    }

    render(<Harness />);
    await waitFor(() => expect(actions.some((action) => action.type === "read")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "test connection" }));

    expect(await screen.findByText("128 ms")).toBeInTheDocument();
    expect(actions).toContainEqual(expect.objectContaining({ type: "connectivityProbe", model }));
    expect(actions.some((action) => JSON.stringify(action).includes("secret"))).toBe(false);
  });
});
