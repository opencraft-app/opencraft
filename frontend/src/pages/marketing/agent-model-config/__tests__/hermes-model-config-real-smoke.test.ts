import { spawnSync } from "node:child_process";
import { constants, publicEncrypt } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildHermesModelConfigCommand, type HermesModelConfigAction } from "../hermes-model-config-command";
import { parseHermesCredentialEnvelopePreparation, parseHermesModelConfigResponse } from "../model-config-client";

const hermesSource = process.env.HERMES_AGENT_SOURCE;

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

describe.skipIf(!hermesSource)("Hermes model configuration real-source smoke", () => {
  it("persists an ordered fallback chain and removes one fallback without leaking keys into config.yaml", () => {
    const home = mkdtempSync(join(tmpdir(), "lightvela-hermes-real-smoke-"));
    try {
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

      const envText = readFileSync(join(home, ".env"), "utf8");
      expect(envText).toContain("HERMES_CUSTOM_LIGHTVELA_SMOKE_PRIMARY_PROVIDER_API_KEY=");
      expect(envText).toContain("HERMES_CUSTOM_LIGHTVELA_SMOKE_FALLBACK_PROVIDER_API_KEY=");
      expect(envText).toContain("HERMES_CUSTOM_LIGHTVELA_SMOKE_SECOND_FALLBACK_PROVIDER_API_KEY=");

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
