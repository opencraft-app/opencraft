import { createHash, webcrypto } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import {
  createDeepSeekHarnessInstallLaunchScript,
  DEEPSEEK_HARNESS_CN_PROVIDERS,
  DEEPSEEK_HARNESS_GLOBAL_PROVIDERS,
  DeepSeekHarnessCommandClient,
  encryptDeepSeekHarnessSecret,
} from "@/lib/deepseek-harness-command";

const success = (output = "") => ({ status: "SUCCESS", exitCode: 0, output });

describe("DeepSeekHarnessCommandClient", () => {
  it("checks the system service through debug/exec", async () => {
    const execDebugCommand = vi.fn().mockResolvedValue(success(JSON.stringify({
      installed: true,
      status: "running",
      service_status: "active",
      healthy: true,
    })));
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand);

    await expect(client.getStatus()).resolves.toMatchObject({ installed: true, status: "running" });
    expect(execDebugCommand).toHaveBeenCalledWith(
      "bot-1",
      expect.stringContaining("sudo systemctl status deepseek-harness.service --no-pager"),
      expect.any(Object),
    );
  });

  it("uploads the installation payload in real time and polls its task file", async () => {
    const execDebugCommand = vi.fn()
      .mockResolvedValue(success())
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success(JSON.stringify({
        task_id: "dshi-0123456789abcdef0123456789abcdef",
        status: "running",
        stage: "install_dsh",
        progress: 35,
        message: "installing",
        updated_at: "2026-08-21T00:00:00Z",
      })));
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand, {
      createTaskId: () => "dshi-0123456789abcdef0123456789abcdef",
      installPayload: {
        chunks: ["payload-part-a", "payload-part-b"],
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
      providerHelperBase64: "cHJpbnQoJ29rJyk=",
    });

    const task = await client.startInstall();
    expect(task.task_id).toBe("dshi-0123456789abcdef0123456789abcdef");
    const installCommands = execDebugCommand.mock.calls.slice(0, 4).map((call) => String(call[1]));
    expect(installCommands[0]).toContain("/tmp/lightvela-dsh-upload-dshi-0123456789abcdef0123456789abcdef");
    expect(installCommands[1]).toContain("payload-part-a");
    expect(installCommands[2]).toContain("payload-part-b");
    expect(installCommands[3]).toContain("sudo -n systemd-run");
    expect(installCommands[3]).toContain("LIGHTVELA_DSH_ASSETS_DIR");
    expect(installCommands[3]).toContain("install-deepseek-harness.sh");
    expect(installCommands.join("\n")).not.toContain("/usr/local/libexec/lightvela");
    expect(installCommands.every((command) => Buffer.byteLength(command) < 64 * 1024)).toBe(true);

    await expect(client.getInstallation(task.task_id)).resolves.toMatchObject({ progress: 35 });
    expect(execDebugCommand.mock.calls[4]?.[1]).toBe(
      "sudo -n cat /var/lib/lightvela/dsh/installations/dshi-0123456789abcdef0123456789abcdef.json",
    );
  });

  it("keeps an indeterminate launch task when reconciliation is also unavailable", async () => {
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success())
      .mockRejectedValueOnce(new Error("launch response lost"))
      .mockRejectedValueOnce(new Error("reconciliation unavailable"));
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand, {
      createTaskId: () => "dshi-0123456789abcdef0123456789abcdef",
      installPayload: {
        chunks: ["payload-part-a"],
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    });

    await expect(client.startInstall()).resolves.toEqual({
      task_id: "dshi-0123456789abcdef0123456789abcdef",
    });
    expect(execDebugCommand).toHaveBeenCalledTimes(4);
    expect(String(execDebugCommand.mock.calls[3]?.[1])).toContain("systemctl show");
    expect(String(execDebugCommand.mock.calls[3]?.[1])).not.toContain("rm -rf");
  });

  it("cleans an upload only after read-only reconciliation confirms no task was launched", async () => {
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success())
      .mockRejectedValueOnce(new Error("launch response lost"))
      .mockResolvedValueOnce({ status: "Failed", exitCode: 3, output: "" })
      .mockResolvedValueOnce(success());
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand, {
      createTaskId: () => "dshi-0123456789abcdef0123456789abcdef",
      installPayload: {
        chunks: ["payload-part-a"],
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    });

    await expect(client.startInstall()).rejects.toThrow("launch response lost");
    expect(execDebugCommand).toHaveBeenCalledTimes(5);
    expect(String(execDebugCommand.mock.calls[3]?.[1])).not.toContain("rm -rf");
    expect(execDebugCommand.mock.calls[4]?.[1]).toBe(
      "rm -rf -- '/tmp/lightvela-dsh-upload-dshi-0123456789abcdef0123456789abcdef'",
    );
  });

  it("keeps an upload when reconciliation returns an inconclusive nonzero result", async () => {
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success())
      .mockRejectedValueOnce(new Error("launch response lost"))
      .mockResolvedValueOnce({ status: "Timeout", exitCode: -1, output: "" });
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand, {
      createTaskId: () => "dshi-0123456789abcdef0123456789abcdef",
      installPayload: {
        chunks: ["payload-part-a"],
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    });

    await expect(client.startInstall()).resolves.toEqual({
      task_id: "dshi-0123456789abcdef0123456789abcdef",
    });
    expect(execDebugCommand).toHaveBeenCalledTimes(4);
  });

  it("publishes a failed task atomically when payload extraction fails before installation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lightvela-dsh-launch-"));
    const uploadDir = path.join(root, "upload");
    const stateDir = path.join(root, "tasks");
    await writeFile(path.join(root, "placeholder"), "", "utf8");
    await mkdir(uploadDir);
    await writeFile(path.join(uploadDir, "payload.b64"), Buffer.from("invalid").toString("base64"));

    const taskId = "dshi-0123456789abcdef0123456789abcdef";
    const launchScript = createDeepSeekHarnessInstallLaunchScript();
    expect(() => execFileSync(
      "/bin/bash",
      ["-c", launchScript, "lightvela-dsh-install", uploadDir, taskId, "0".repeat(64), stateDir],
      { env: { ...process.env, PYTHONOPTIMIZE: "2" }, stdio: "pipe" },
    )).toThrow();

    const task = JSON.parse(await readFile(path.join(stateDir, `${taskId}.json`), "utf8")) as {
      status: string;
      stage: string;
    };
    expect(task).toMatchObject({ status: "failed", stage: "prepare" });
    await expect(access(uploadDir)).rejects.toThrow();
  });

  it("rejects traversal paths while really executing the payload extractor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lightvela-dsh-traversal-"));
    const uploadDir = path.join(root, "upload");
    const stateDir = path.join(root, "tasks");
    await mkdir(uploadDir);
    const compressed = gzipSync(Buffer.from(JSON.stringify({
      schemaVersion: 1,
      files: [{ path: "../escaped", mode: 0o755, content: Buffer.from("bad").toString("base64") }],
    })));
    await writeFile(path.join(uploadDir, "payload.b64"), compressed.toString("base64"));

    const taskId = "dshi-0123456789abcdef0123456789abcdef";
    expect(() => execFileSync(
      "/bin/bash",
      [
        "-c",
        createDeepSeekHarnessInstallLaunchScript(),
        "lightvela-dsh-install",
        uploadDir,
        taskId,
        createHash("sha256").update(compressed).digest("hex"),
        stateDir,
      ],
      { env: { ...process.env, PYTHONOPTIMIZE: "2" }, stdio: "pipe" },
    )).toThrow();

    await expect(access(path.join(root, "escaped"))).rejects.toThrow();
    const task = JSON.parse(await readFile(path.join(stateDir, `${taskId}.json`), "utf8")) as {
      status: string;
    };
    expect(task.status).toBe("failed");
  });

  it("extracts a valid payload, hands off to its installer, and removes the upload", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lightvela-dsh-success-"));
    const uploadDir = path.join(root, "upload");
    const stateDir = path.join(root, "tasks");
    await mkdir(uploadDir);
    const installer = [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      'task_id="$3"',
      'printf \'{"task_id":"%s","status":"succeeded"}\\n\' "$task_id" > "$TEST_TASK_DIR/$task_id.json"',
    ].join("\n");
    const compressed = gzipSync(Buffer.from(JSON.stringify({
      schemaVersion: 1,
      files: [{
        path: "installer/install-deepseek-harness.sh",
        mode: 0o755,
        content: Buffer.from(installer).toString("base64"),
      }],
    })));
    await writeFile(path.join(uploadDir, "payload.b64"), compressed.toString("base64"));

    const taskId = "dshi-0123456789abcdef0123456789abcdef";
    execFileSync(
      "/bin/bash",
      [
        "-c",
        createDeepSeekHarnessInstallLaunchScript(),
        "lightvela-dsh-install",
        uploadDir,
        taskId,
        createHash("sha256").update(compressed).digest("hex"),
        stateDir,
      ],
      { env: { ...process.env, TEST_TASK_DIR: stateDir }, stdio: "pipe" },
    );

    const task = JSON.parse(await readFile(path.join(stateDir, `${taskId}.json`), "utf8")) as {
      status: string;
    };
    expect(task.status).toBe("succeeded");
    await expect(access(uploadDir)).rejects.toThrow();
  });

  it("replaces pending with failed when the extracted installer exits before writing a task", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lightvela-dsh-installer-failure-"));
    const uploadDir = path.join(root, "upload");
    const stateDir = path.join(root, "tasks");
    await mkdir(uploadDir);
    const compressed = gzipSync(Buffer.from(JSON.stringify({
      schemaVersion: 1,
      files: [{
        path: "installer/install-deepseek-harness.sh",
        mode: 0o755,
        content: Buffer.from("#!/usr/bin/env bash\nexit 42\n").toString("base64"),
      }],
    })));
    await writeFile(path.join(uploadDir, "payload.b64"), compressed.toString("base64"));

    const taskId = "dshi-0123456789abcdef0123456789abcdef";
    expect(() => execFileSync(
      "/bin/bash",
      [
        "-c",
        createDeepSeekHarnessInstallLaunchScript(),
        "lightvela-dsh-install",
        uploadDir,
        taskId,
        createHash("sha256").update(compressed).digest("hex"),
        stateDir,
      ],
      { stdio: "pipe" },
    )).toThrow();

    const task = JSON.parse(await readFile(path.join(stateDir, `${taskId}.json`), "utf8")) as {
      status: string;
      stage: string;
    };
    expect(task).toMatchObject({ status: "failed", stage: "install" });
  });

  it("rejects an oversized encoded payload before attempting decompression", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lightvela-dsh-oversized-"));
    const uploadDir = path.join(root, "upload");
    const stateDir = path.join(root, "tasks");
    await mkdir(uploadDir);
    await writeFile(path.join(uploadDir, "payload.b64"), "A".repeat(1024 * 1024 + 4));

    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        createDeepSeekHarnessInstallLaunchScript(),
        "lightvela-dsh-install",
        uploadDir,
        "dshi-0123456789abcdef0123456789abcdef",
        "0".repeat(64),
        stateDir,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("encoded payload is too large");
  });

  it("restarts the system service and refreshes status through debug/exec", async () => {
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success(JSON.stringify({
        installed: true,
        status: "running",
        service_status: "active",
        healthy: true,
      })));
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand);

    await expect(client.restart()).resolves.toMatchObject({ healthy: true });
    expect(execDebugCommand.mock.calls[0]?.[1]).toBe("sudo systemctl restart deepseek-harness.service");
    expect(execDebugCommand.mock.calls[1]?.[1]).toContain("sudo systemctl status deepseek-harness.service --no-pager");
  });

  it("loads providers and saves an encrypted API key through inline management scripts", async () => {
    const providers = [{
      id: "deepseek",
      displayName: "DeepSeek",
      configured: false,
      active: true,
      writable: true,
    }];
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(success(JSON.stringify({ providers })))
      .mockResolvedValueOnce(success("test-public-key"))
      .mockResolvedValueOnce(success(JSON.stringify({ ok: true, provider: "deepseek", configured: true })));
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand, {
      providerHelperBase64: "cHJpbnQoJ29rJyk=",
      createSecretId: () => "dshk-0123456789abcdef0123456789abcdef",
      encryptSecret: vi.fn().mockResolvedValue("ZW5jcnlwdGVkLXNlY3JldA=="),
    });

    await expect(client.listProviders("cn")).resolves.toEqual(providers);
    const listCommand = String(execDebugCommand.mock.calls[0]?.[1]);
    expect(listCommand).toContain("sudo -n -u agentuser");
    expect(listCommand).toContain("python3 -c");
    expect(listCommand).toContain("providers --region cn");
    expect(listCommand).not.toContain("/usr/local/libexec/lightvela");

    await client.saveProvider("deepseek", "sk-sensitive-value");
    const keyCommand = String(execDebugCommand.mock.calls[1]?.[1]);
    expect(keyCommand).toContain("openssl genpkey");
    expect(keyCommand).toContain("dshk-0123456789abcdef0123456789abcdef.pem");
    const saveCommand = String(execDebugCommand.mock.calls[2]?.[1]);
    expect(saveCommand).toContain("configure --provider deepseek");
    expect(saveCommand).not.toContain("sk-sensitive-value");
    expect(saveCommand).not.toContain(btoa("sk-sensitive-value"));
    expect(saveCommand).toContain("ZW5jcnlwdGVkLXNlY3JldA==");
    expect(saveCommand).toContain("rsa_padding_mode:oaep");
    expect(saveCommand).toContain("rm -f");
    expect([keyCommand, saveCommand].every((command) => Buffer.byteLength(command) < 64 * 1024))
      .toBe(true);
  });

  it("encrypts provider secrets with RSA-OAEP before they enter a command", async () => {
    const keys = await webcrypto.subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["encrypt", "decrypt"],
    );
    const publicKey = Buffer.from(await webcrypto.subtle.exportKey("spki", keys.publicKey)).toString("base64");

    const encrypted = await encryptDeepSeekHarnessSecret(publicKey, "sk-sensitive-value");
    const decrypted = await webcrypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      keys.privateKey,
      Buffer.from(encrypted, "base64"),
    );

    expect(Buffer.from(decrypted).toString("utf8")).toBe("sk-sensitive-value");
    expect(encrypted).not.toContain(btoa("sk-sensitive-value"));
  });

  it("removes an allowlisted provider through the inline management script", async () => {
    const execDebugCommand = vi.fn().mockResolvedValue(success(JSON.stringify({
      ok: true,
      provider: "deepseek",
      configured: false,
    })));
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand, {
      providerHelperBase64: "cHJpbnQoJ29rJyk=",
    });

    await client.removeProvider("deepseek");

    const command = String(execDebugCommand.mock.calls[0]?.[1]);
    expect(command).toContain("sudo -n -u agentuser");
    expect(command).toContain("python3 -c");
    expect(command).toContain("remove-provider --provider deepseek");
    expect(command).not.toContain("/usr/local/libexec/lightvela");
  });

  it("surfaces a failed provider removal instead of pretending it succeeded", async () => {
    const execDebugCommand = vi.fn().mockResolvedValue({
      status: "Failed",
      exitCode: 1,
      output: "DeepSeek credential is managed by the runtime environment and cannot be removed here",
    });
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand);

    await expect(client.removeProvider("deepseek")).rejects.toThrow("managed by the runtime environment");
  });

  it("keeps the exact regional provider allowlists", () => {
    expect(DEEPSEEK_HARNESS_CN_PROVIDERS).toEqual([
      "deepseek",
      "minimax-cn",
      "moonshotai-cn",
      "qwen-token-plan-cn",
      "openrouter",
    ]);
    expect(DEEPSEEK_HARNESS_GLOBAL_PROVIDERS).toEqual([
      "deepseek",
      "minimax",
      "minimax-cn",
      "moonshotai",
      "moonshotai-cn",
      "openrouter",
      "anthropic",
      "groq",
      "openai",
    ]);
  });

  it("rejects task ids and providers outside the fixed allowlists", async () => {
    const execDebugCommand = vi.fn();
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand);

    await expect(client.getInstallation("../../task")).rejects.toThrow("Invalid DeepSeek Harness task id");
    await expect(client.saveProvider("unknown" as "deepseek", "key")).rejects.toThrow("Unsupported DeepSeek Harness provider");
    await expect(client.removeProvider("unknown" as "deepseek")).rejects.toThrow("Unsupported DeepSeek Harness provider");
    expect(execDebugCommand).not.toHaveBeenCalled();
  });
});
