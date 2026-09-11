// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createHermesModelConfigClient,
  type HermesConnectionProbeResult,
  type HermesConfiguredModel,
  type HermesModelConfigExecDebugCommand,
  type HermesModelConfigSnapshot,
} from "./model-config-client";

type ModelPurpose = "primary" | "fallback" | "idle";

export type ModelConfigOperation =
  | "probe"
  | "configured-probe"
  | "append"
  | "connectivity-probe"
  | "configured-connectivity-probe"
  | "add"
  | "assign-primary"
  | "assign-fallback"
  | "remove-fallback"
  | "remove";

export type HermesModelIdentityInput = Pick<
  HermesConfiguredModel,
  "providerKey" | "id" | "baseUrl" | "routeBaseUrl"
>;

export function getHermesModelIdentity(model: HermesModelIdentityInput) {
  return JSON.stringify([
    model.providerKey.trim().replace(/\/+$/, "").toLowerCase(),
    model.id.trim(),
    (model.routeBaseUrl ?? model.baseUrl).trim().replace(/\/+$/, "").toLowerCase(),
  ]);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useModelConfig({
  botId,
  profileId,
  execDebugCommand,
}: {
  botId: string;
  profileId?: string;
  execDebugCommand: HermesModelConfigExecDebugCommand;
}) {
  const execDebugCommandRef = useRef(execDebugCommand);
  execDebugCommandRef.current = execDebugCommand;
  const client = useMemo(
    () => createHermesModelConfigClient(
      (targetBotId, command, options) => execDebugCommandRef.current(targetBotId, command, options),
      botId,
      profileId,
    ),
    [botId, profileId],
  );
  const requestRevision = useRef(0);
  const probeRevision = useRef(0);
  const activeOperation = useRef<{ token: symbol; kind: ModelConfigOperation } | null>(null);
  const [snapshot, setSnapshot] = useState<HermesModelConfigSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operation, setOperation] = useState<ModelConfigOperation | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operationErrorOperation, setOperationErrorOperation] = useState<ModelConfigOperation | null>(null);

  const reload = useCallback(async () => {
    const revision = ++requestRevision.current;
    setLoading(true);
    setLoadError(null);
    try {
      const nextSnapshot = await client.read();
      if (revision === requestRevision.current) setSnapshot(nextSnapshot);
    } catch (error) {
      if (revision === requestRevision.current) setLoadError(getErrorMessage(error));
    } finally {
      if (revision === requestRevision.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    activeOperation.current = null;
    setSnapshot(null);
    setOperation(null);
    setOperationError(null);
    setOperationErrorOperation(null);
    void reload();
    return () => {
      activeOperation.current = null;
      requestRevision.current += 1;
      probeRevision.current += 1;
    };
  }, [reload]);

  const runMutation = useCallback(async (
    nextOperation: ModelConfigOperation,
    mutate: () => Promise<HermesModelConfigSnapshot>,
  ) => {
    if (activeOperation.current) return null;
    const token = Symbol(nextOperation);
    activeOperation.current = { token, kind: nextOperation };
    setOperation(nextOperation);
    setOperationError(null);
    setOperationErrorOperation(null);
    try {
      const nextSnapshot = await mutate();
      if (activeOperation.current?.token !== token) return null;
      setSnapshot(nextSnapshot);
      return nextSnapshot;
    } catch (error) {
      if (activeOperation.current?.token !== token) return null;
      setOperationError(getErrorMessage(error));
      setOperationErrorOperation(nextOperation);
      return null;
    } finally {
      if (activeOperation.current?.token === token) {
        activeOperation.current = null;
        setOperation(null);
      }
    }
  }, []);

  const probe = useCallback(async (input: { apiKey: string; baseUrl: string; apiMode: string } | { anchor: HermesConfiguredModel }) => {
    if (activeOperation.current) return null;
    const kind = "anchor" in input ? "configured-probe" : "probe";
    const token = Symbol(kind);
    activeOperation.current = { token, kind };
    const revision = ++probeRevision.current;
    setOperation(kind);
    setOperationError(null);
    setOperationErrorOperation(null);
    try {
      const result = "anchor" in input ? await client.probeConfigured(input.anchor) : await client.probe(input);
      return revision === probeRevision.current && activeOperation.current?.token === token ? result : null;
    } catch (error) {
      if (revision === probeRevision.current && activeOperation.current?.token === token) {
        setOperationError(getErrorMessage(error));
        setOperationErrorOperation(kind);
      }
      return null;
    } finally {
      if (revision === probeRevision.current && activeOperation.current?.token === token) {
        activeOperation.current = null;
        setOperation(null);
      }
    }
  }, [client]);

  const testConnection = useCallback(async (input: {
    apiKey: string;
    model: HermesConfiguredModel;
    strategy?: "model_list" | "model_request";
  } | { anchor: HermesConfiguredModel; modelId: string }): Promise<HermesConnectionProbeResult | null> => {
    if (activeOperation.current) return null;
    const kind = "anchor" in input ? "configured-connectivity-probe" : "connectivity-probe";
    const token = Symbol(kind);
    activeOperation.current = { token, kind };
    setOperation(kind);
    setOperationError(null);
    setOperationErrorOperation(null);
    try {
      const result = "anchor" in input ? await client.testConfiguredConnection(input.anchor, input.modelId) : await client.testConnection(input);
      return activeOperation.current?.token === token ? result : null;
    } catch (error) {
      if (activeOperation.current?.token === token) {
        setOperationError(getErrorMessage(error));
        setOperationErrorOperation(kind);
      }
      return null;
    } finally {
      if (activeOperation.current?.token === token) {
        activeOperation.current = null;
        setOperation(null);
      }
    }
  }, [client]);

  const cancelProbe = useCallback(() => {
    probeRevision.current += 1;
    if (["probe", "configured-probe", "configured-connectivity-probe"].includes(activeOperation.current?.kind ?? "")) activeOperation.current = null;
    setOperation((current) => current === "probe" || current === "configured-probe" || current === "configured-connectivity-probe" ? null : current);
    setOperationErrorOperation((current) => {
      if (current === "probe" || current === "configured-probe" || current === "configured-connectivity-probe") {
        setOperationError(null);
        return null;
      }
      return current;
    });
  }, []);

  const clearOperationError = useCallback(() => {
    setOperationError(null);
    setOperationErrorOperation(null);
  }, []);

  const add = useCallback((input: {
    apiKey: string;
    model: HermesConfiguredModel;
    purpose: ModelPurpose;
    discoverModels?: boolean;
  }) => runMutation("add", () => client.add(input)), [client, runMutation]);

  const append = useCallback((model: HermesConfiguredModel, modelId: string) =>
    runMutation("append", () => client.append(model, modelId)), [client, runMutation]);

  const assign = useCallback((model: HermesConfiguredModel, purpose: "primary" | "fallback") =>
    runMutation(
      purpose === "primary" ? "assign-primary" : "assign-fallback",
      () => client.assign({
        providerKey: model.providerKey,
        modelId: model.id,
        baseUrl: model.baseUrl,
        routeBaseUrl: model.routeBaseUrl ?? model.baseUrl,
        purpose,
      }),
    ), [client, runMutation]);

  const removeFallback = useCallback((model: HermesConfiguredModel) =>
    runMutation(
      "remove-fallback",
      () => client.removeFallback({
        providerKey: model.providerKey,
        modelId: model.id,
        baseUrl: model.baseUrl,
        routeBaseUrl: model.routeBaseUrl ?? model.baseUrl,
      }),
    ), [client, runMutation]);

  const remove = useCallback((model: HermesConfiguredModel) =>
    runMutation(
      "remove",
      () => client.remove({
        providerKey: model.providerKey,
        modelId: model.id,
        baseUrl: model.baseUrl,
        routeBaseUrl: model.routeBaseUrl ?? model.baseUrl,
      }),
    ), [client, runMutation]);

  return {
    snapshot,
    loading,
    loadError,
    operation,
    operationError,
    operationErrorOperation,
    reload,
    probe,
    testConnection,
    cancelProbe,
    clearOperationError,
    add,
    append,
    assign,
    removeFallback,
    remove,
  };
}
