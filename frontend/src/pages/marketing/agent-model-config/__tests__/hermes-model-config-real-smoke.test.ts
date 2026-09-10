import { exec, spawnSync } from "node:child_process";
import { constants, publicEncrypt } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { buildHermesModelConfigCommand, type HermesModelConfigAction } from "../hermes-model-config-command";
import { parseHermesConnectionProbeResponse, parseHermesCredentialEnvelopePreparation, parseHermesModelConfigResponse } from "../model-config-client";

const hermesSource = process.env.HERMES_AGENT_SOURCE;
const execAsync = promisify(exec);

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server) {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

type PlaintextAction =
  | Exclude<HermesModelConfigAction, Extract<HermesModelConfigAction, { type: "add" }>>
  | { type: "add"; apiKey: string; model: Extract<HermesModelConfigAction, { type: "add" }>["model"]; purpose: "primary" | "fallback" | "idle" };

function runCommand(source: string, home: string, action: HermesModelConfigAction) {
  const result = spawnSync(buildHermesModelConfigCommand(action), {
    cwd: source,
    encoding: "utf8",
    env: { ...process.env, HERMES_HOME: home, PYTHONPATH: source },
    shell: true,
  });
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0) throw new Error(`Hermes helper exited with ${result.status}: ${output}`);
  return output;
}

function runAction(source: string, home: string, input: PlaintextAction) {
  let action = input as HermesModelConfigAction;
  if (input.type === "add") {
    const preparation = parseHermesCredentialEnvelopePreparation(runCommand(source, home, { type: "prepareCredentialEnvelope" }));
    const ciphertext = publicEncrypt({
      key: preparation.publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    }, Buffer.from(input.apiKey)).toString("base64");
    action = {
      type: "add",
      credentialEnvelope: { token: preparation.token, ciphertext },
      model: input.model,
      purpose: input.purpose,
    };
  }
  return parseHermesModelConfigResponse(runCommand(source, home, action));
}

function readHermesConfig(source: string, home: string): Record<string, unknown> {
  const result = spawnSync("python3", ["-c", "import json; from hermes_cli.config import load_config; print(json.dumps(load_config()))"], {
    cwd: source,
    encoding: "utf8",
    env: { ...process.env, HERMES_HOME: home, PYTHONPATH: source },
  });
  if (result.status !== 0) throw new Error(`Hermes config read exited with ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe.skipIf(!hermesSource)("Hermes model configuration real-source smoke", () => {
  it.each(["chat_completions", "anthropic_messages", "codex_responses"])(
    "does not forward saved credentials across redirects using real Hermes transport (%s)", async (apiMode) => {
      const home = mkdtempSync(join(tmpdir(), "lightvela-hermes-redirect-"));
      const received: IncomingHttpHeaders[] = [];
      const initial: IncomingHttpHeaders[] = [];
      let status = 302;
      const destination = createServer((request, response) => {
        received.push(request.headers);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"id":"probe-response"}');
      });
      let destinationUrl = "";
      const origin = createServer((request, response) => {
        initial.push(request.headers);
        response.writeHead(status, { Location: `${destinationUrl}/redirected` });
        response.end();
      });
      try {
        destinationUrl = await listen(destination);
        const baseUrl = `${await listen(origin)}/v1`;
        const anchor = { id: "Model-A", providerKey: "redirect-test", providerName: "Redirect Test", baseUrl, apiMode, keyEnv: "REDIRECT_TEST_KEY" };
        const config = JSON.stringify({ providers: { [anchor.providerKey]: {
          name: anchor.providerName, base_url: baseUrl, model: anchor.id,
          transport: apiMode, key_env: anchor.keyEnv, extra_headers: { "X-Private-Token": "test-extra-secret" },
        } } });
        writeFileSync(join(home, "config.yaml"), config);
        writeFileSync(join(home, ".env"), "REDIRECT_TEST_KEY=test-redirect-secret\n");
        for (status of [301, 302, 303, 307, 308]) {
          initial.length = 0;
          received.length = 0;
          const result = await execAsync(buildHermesModelConfigCommand({ type: "probeConfiguredModel", anchor, modelId: "Model-B" }), {
            cwd: hermesSource!, timeout: 10_000,
            env: { ...process.env, HERMES_HOME: home, PYTHONPATH: hermesSource!, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
          });
          const output = result.stdout + result.stderr;
          const connection = parseHermesConnectionProbeResponse(output);
          expect(initial).toHaveLength(1);
          expect(initial[0]?.[apiMode === "anthropic_messages" ? "x-api-key" : "authorization"]).toContain("test-redirect-secret");
          expect(initial[0]?.["x-private-token"]).toBe("test-extra-secret");
          if (status === 307 || status === 308) {
            expect(connection.success).toBe(false);
            expect(received).toHaveLength(0);
          } else {
            expect(connection.success).toBe(true);
            expect(received).toHaveLength(1);
          }
          for (const headers of received) {
            expect(headers).not.toHaveProperty("authorization");
            expect(headers).not.toHaveProperty("x-api-key");
            expect(headers).not.toHaveProperty("x-private-token");
          }
          expect(output).not.toContain("test-redirect-secret");
          expect(output).not.toContain("test-extra-secret");
          expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(config);
        }
      } finally {
        await close(origin);
        await close(destination);
        rmSync(home, { force: true, recursive: true });
      }
    }, 60_000,
  );

  it("persists an ordered fallback chain and removes one fallback without leaking keys into config.yaml", () => {
    const home = mkdtempSync(join(tmpdir(), "lightvela-hermes-real-smoke-"));
    try {
      const legacyConfiguredModel = {
        id: "legacy-smoke-model",
        providerKey: "legacy-smoke-provider",
        providerName: "Legacy Smoke Provider",
        baseUrl: "https://legacy-smoke.invalid/v1",
        apiMode: "chat_completions",
        keyEnv: "LEGACY_SMOKE_API_KEY",
      };
      writeFileSync(join(home, "config.yaml"), JSON.stringify({
        lightvela: { model_config: { configured_models: [legacyConfiguredModel] } },
      }), "utf8");
      const primary = {
        id: "smoke-primary",
        providerKey: "smoke-primary-provider",
        providerName: "Smoke Primary",
        baseUrl: "https://primary.invalid/v1",
        apiMode: "chat_completions",
        keyEnv: "",
      };
      const fallback = {
        id: "smoke-fallback",
        providerKey: "smoke-fallback-provider",
        providerName: "Smoke Fallback",
        baseUrl: "https://fallback.invalid/v1",
        apiMode: "anthropic_messages",
        keyEnv: "",
      };
      const secondFallback = {
        id: "smoke-second-fallback",
        providerKey: "smoke-second-fallback-provider",
        providerName: "Smoke Second Fallback",
        baseUrl: "https://second-fallback.invalid/v1",
        apiMode: "chat_completions",
        keyEnv: "",
      };

      runAction(hermesSource!, home, { type: "read" });
      const afterPrimary = runAction(hermesSource!, home, {
        type: "add",
        apiKey: "smoke-primary-secret",
        model: primary,
        purpose: "primary",
      });
      expect(afterPrimary.primary?.id).toBe(primary.id);

      const afterFallback = runAction(hermesSource!, home, {
        type: "add",
        apiKey: "smoke-fallback-secret",
        model: fallback,
        purpose: "fallback",
      });
      expect(afterFallback.fallbacks.map((item) => item.id)).toEqual([fallback.id]);

      const afterSecondFallback = runAction(hermesSource!, home, {
        type: "add",
        apiKey: "smoke-second-fallback-secret",
        model: secondFallback,
        purpose: "fallback",
      });
      expect(afterSecondFallback.fallbacks.map((item) => item.id)).toEqual([fallback.id, secondFallback.id]);

      const configText = readFileSync(join(home, "config.yaml"), "utf8");
      expect(configText).not.toContain("smoke-primary-secret");
      expect(configText).not.toContain("smoke-fallback-secret");
      expect(configText).not.toContain("smoke-second-fallback-secret");
      expect(configText).toContain("fallback_providers:");
      expect(configText).not.toMatch(/^\s*fallback_model:/m);
      const persistedConfig = readHermesConfig(hermesSource!, home);
      expect((((persistedConfig.lightvela as Record<string, unknown>).model_config as Record<string, unknown>).configured_models))
        .toEqual([legacyConfiguredModel]);

      const envText = readFileSync(join(home, ".env"), "utf8");
      expect(envText).toContain("HERMES_CUSTOM_LIGHTVELA_SMOKE_PRIMARY_PROVIDER_API_KEY=");
      expect(envText).toContain("HERMES_CUSTOM_LIGHTVELA_SMOKE_FALLBACK_PROVIDER_API_KEY=");
      expect(envText).toContain("HERMES_CUSTOM_LIGHTVELA_SMOKE_SECOND_FALLBACK_PROVIDER_API_KEY=");

      const anchor = afterSecondFallback.primary!;
      const appended = runAction(hermesSource!, home, {
        type: "appendProviderModel", anchor, modelId: "smoke-additional-model",
      });
      expect(appended.primary).toEqual(afterSecondFallback.primary);
      expect(appended.fallbacks).toEqual(afterSecondFallback.fallbacks);
      expect(appended.configuredModels).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: primary.id }),
        expect.objectContaining({ id: "smoke-additional-model", providerKey: anchor.providerKey }),
      ]));
      const afterAppendConfig = readHermesConfig(hermesSource!, home);
      expect(afterAppendConfig.model).toEqual(persistedConfig.model);
      expect(afterAppendConfig.lightvela).toEqual(persistedConfig.lightvela);
      expect(readFileSync(join(home, ".env"), "utf8")).toBe(envText);
      expect(runAction(hermesSource!, home, { type: "read" }).configuredModels).toEqual(appended.configuredModels);

      const caseVariantId = primary.id.toUpperCase();
      const caseVariant = runAction(hermesSource!, home, { type: "appendProviderModel", anchor, modelId: caseVariantId });
      expect(caseVariant.configuredModels.filter((item) => item.providerKey === anchor.providerKey).map((item) => item.id))
        .toEqual(expect.arrayContaining([primary.id, caseVariantId]));
      const caseFallback = runAction(hermesSource!, home, { type: "assign", providerKey: anchor.providerKey, modelId: caseVariantId, purpose: "fallback" });
      expect(caseFallback.primary?.id).toBe(primary.id);
      expect(caseFallback.fallbacks.map((item) => item.id)).toContain(caseVariantId);
      const removedVariant = runAction(hermesSource!, home, { type: "remove", providerKey: anchor.providerKey, modelId: caseVariantId });
      expect(removedVariant.primary?.id).toBe(primary.id);
      expect(removedVariant.configuredModels.map((item) => item.id)).not.toContain(caseVariantId);

      const afterDetach = runAction(hermesSource!, home, {
        type: "removeFallback",
        providerKey: "lightvela-smoke-fallback-provider",
        modelId: fallback.id,
      });
      expect(afterDetach.fallbacks.map((item) => item.id)).toEqual([secondFallback.id]);

      const afterRemove = runAction(hermesSource!, home, {
        type: "remove",
        providerKey: "lightvela-smoke-fallback-provider",
        modelId: fallback.id,
      });
      expect(afterRemove.configuredModels).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: fallback.id }),
      ]));
      expect(afterRemove.fallbacks.map((item) => item.id)).toEqual([secondFallback.id]);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, 30_000);
});
