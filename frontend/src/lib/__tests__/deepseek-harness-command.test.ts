import { createHash, webcrypto } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createDeepSeekHarnessInstallLaunchScript,
  DEEPSEEK_HARNESS_CN_PROVIDERS,
  DEEPSEEK_HARNESS_GLOBAL_PROVIDERS,
  DeepSeekHarnessCommandClient,
  encryptDeepSeekHarnessSecret,
} from "@/lib/deepseek-harness-command";

const success = (output = "") => ({ status: "SUCCESS", exitCode: 0, output });
const trustedBrowserHost = "ins-0123456789abcdef0123456789abcdef.dsh.lightvela.site";

const createFakeCurl = async (root: string, installer: string | null) => {
  const binDir = path.join(root, "bin");
  await mkdir(binDir);
  const curlPath = path.join(binDir, "curl");
  const sourcePath = path.join(root, "installer-source.sh");
  if (installer !== null) await writeFile(sourcePath, installer, "utf8");
  await writeFile(curlPath, installer === null
    ? "#!/usr/bin/env bash\nexit 22\n"
    : [
        "#!/usr/bin/env bash",
        "set -Eeuo pipefail",
        "output=''",
        "while [ \"$#\" -gt 0 ]; do",
        "  case \"$1\" in",
        "    --output) output=\"$2\"; shift 2 ;;",
        "    *) shift ;;",
        "  esac",
        "done",
        'cp -- "$TEST_INSTALLER_SOURCE" "$output"',
      ].join("\n"), "utf8");
  await chmod(curlPath, 0o755);
  return { binDir, sourcePath };
};

const paddedInstaller = (body: readonly string[]) => [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  ...body,
  `# ${"x".repeat(1100)}`,
  "",
].join("\n");

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

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
      expect.stringContaining("sudo -n systemctl status deepseek-harness.service --no-pager"),
      expect.any(Object),
    );
    const command = String(execDebugCommand.mock.calls[0]?.[1]);
    expect(command).toContain("sudo -n test -x /opt/lightvela/dsh/current/node_modules/.bin/dsh");
    expect(command).toContain("sudo -n test ! -x /opt/lightvela/dsh/current/node_modules/.bin/dsh");
    expect(command).toContain("http://127.0.0.1:3080/");
    expect(command).toContain('"status":"degraded"');
  });

  it("fails closed when non-interactive sudo is unavailable during status detection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lightvela-dsh-status-sudo-"));
    const binDir = path.join(root, "bin");
    await mkdir(binDir);
    await writeFile(path.join(binDir, "sudo"), "#!/usr/bin/env bash\nexit 1\n", "utf8");
    await chmod(path.join(binDir, "sudo"), 0o755);

    const execDebugCommand = vi.fn().mockImplementation(async (_botId: string, command: string) => {
      const result = spawnSync("/bin/bash", ["-c", command], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        encoding: "utf8",
      });
      return {
        status: result.status === 0 ? "SUCCESS" : "FAILED",
        exitCode: result.status ?? 1,
        output: result.stdout || result.stderr,
      };
    });
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand);

    await expect(client.getStatus()).rejects.toThrow();
  });

  it("reports an active service as degraded after automatic restarts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lightvela-dsh-status-restarts-"));
    const binDir = path.join(root, "bin");
    await mkdir(binDir);
    await writeFile(path.join(binDir, "sudo"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "[ \"${1:-}\" = \"-n\" ] && shift",
      "exec \"$@\"",
      "",
    ].join("\n"), "utf8");
    await writeFile(path.join(binDir, "systemctl"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [ \"${1:-}\" = \"status\" ]; then exit 0; fi",
      "if [ \"${1:-}\" = \"show\" ]; then printf '2\\n'; exit 0; fi",
      "exit 1",
      "",
    ].join("\n"), "utf8");
    await writeFile(path.join(binDir, "curl"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
    await Promise.all(["sudo", "systemctl", "curl"].map((name) => chmod(path.join(binDir, name), 0o755)));

    const execDebugCommand = vi.fn().mockImplementation(async (_botId: string, command: string) => {
      const result = spawnSync("/bin/bash", ["-c", command], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        encoding: "utf8",
      });
      return {
        status: result.status === 0 ? "SUCCESS" : "FAILED",
        exitCode: result.status ?? 1,
        output: result.stdout || result.stderr,
      };
    });
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand);

    await expect(client.getStatus()).resolves.toMatchObject({
      installed: true,
      status: "degraded",
      healthy: false,
    });
  });

  it("fails status detection when curl is unavailable even after automatic restarts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lightvela-dsh-status-curl-"));
    const binDir = path.join(root, "bin");
    await mkdir(binDir);
    await writeFile(path.join(binDir, "sudo"), [
      "#!/bin/bash",
      "set -euo pipefail",
      "[ \"${1:-}\" = \"-n\" ] && shift",
      "exec \"$@\"",
      "",
    ].join("\n"), "utf8");
    await writeFile(path.join(binDir, "systemctl"), [
      "#!/bin/bash",
      "set -euo pipefail",
      "if [ \"${1:-}\" = \"status\" ]; then exit 0; fi",
      "if [ \"${1:-}\" = \"show\" ]; then printf '2\\n'; exit 0; fi",
      "exit 1",
      "",
    ].join("\n"), "utf8");
    await Promise.all(["sudo", "systemctl"].map((name) => chmod(path.join(binDir, name), 0o755)));

    const execDebugCommand = vi.fn().mockImplementation(async (_botId: string, command: string) => {
      const result = spawnSync("/bin/bash", ["-c", command], {
        env: {
          ...process.env,
          PATH: binDir,
          HOME: root,
          BASH_ENV: "",
          ENV: "",
        },
        encoding: "utf8",
      });
      return {
        status: result.status === 0 ? "SUCCESS" : "FAILED",
        exitCode: result.status ?? 1,
        output: result.stdout || result.stderr,
      };
    });
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand);

    await expect(client.getStatus()).rejects.toThrow();
  });

  it("downloads the installer from the accelerated COS endpoint and polls its task file", async () => {
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success(JSON.stringify({
        task_id: "dshi-0123456789abcdef0123456789abcdef",
        status: "running",
        stage: "install_dsh",
        progress: 35,
        message: "installing",
        updated_at: "2026-08-21T00:00:00Z",
      })));
    const client = new DeepSeekHarnessCommandClient("ins-0123456789abcdef0123456789abcdef", execDebugCommand, {
      createTaskId: () => "dshi-0123456789abcdef0123456789abcdef",
      providerHelperBase64: "cHJpbnQoJ29rJyk=",
      region: "global",
    });

    const task = await client.startInstall();
    expect(task.task_id).toBe("dshi-0123456789abcdef0123456789abcdef");
    const installCommands = execDebugCommand.mock.calls.slice(0, 1).map((call) => String(call[1]));
    expect(installCommands.join("\n")).toContain("sudo -n systemd-run");
    expect(installCommands.join("\n")).toContain(
      "https://vela-installer-1388575217.cos.accelerate.myqcloud.com/dsh/install-deepseek-harness.sh",
    );
    expect(installCommands.join("\n")).toContain("--retry 5");
    expect(installCommands.join("\n")).toContain(
      '--trusted-browser-host "$trusted_browser_host"',
    );
    expect(installCommands.join("\n")).toContain(
      "'ins-0123456789abcdef0123456789abcdef.dsh.lightvela.site'",
    );
    expect(installCommands.join("\n")).toContain("bash -n");
    expect(installCommands.join("\n")).not.toContain("cos.ap-beijing.myqcloud.com");
    expect(installCommands.join("\n")).not.toContain("payload-part-a");
    expect(installCommands.join("\n")).not.toContain("payload-part-b");
    expect(installCommands.join("\n")).not.toContain("/usr/local/libexec/lightvela");
    expect(installCommands.every((command) => Buffer.byteLength(command) < 64 * 1024)).toBe(true);

    await expect(client.getInstallation(task.task_id)).resolves.toMatchObject({ progress: 35 });
    expect(execDebugCommand.mock.calls.at(-1)?.[1]).toBe(
      "sudo -n cat /var/lib/lightvela/dsh/installations/dshi-0123456789abcdef0123456789abcdef.json",
    );
  });

  it("passes the domestic WebUI hostname to the installer", async () => {
    const execDebugCommand = vi.fn().mockResolvedValue(success());
    const client = new DeepSeekHarnessCommandClient(
      "ins-0123456789abcdef0123456789abcdef",
      execDebugCommand,
      {
        createTaskId: () => "dshi-0123456789abcdef0123456789abcdef",
        region: "cn",
      },
    );

    await client.startInstall();

    const command = String(execDebugCommand.mock.calls[0]?.[1]);
    expect(command).toContain(
      "'ins-0123456789abcdef0123456789abcdef.dsh.lightvela.tech'",
    );
    expect(command).not.toContain(
      "'ins-0123456789abcdef0123456789abcdef.dsh.lightvela.site'",
    );
  });

  it("isolates the Web profile before an explicitly confirmed repair", async () => {
    const execDebugCommand = vi.fn().mockResolvedValue(success());
    const client = new DeepSeekHarnessCommandClient(
      "ins-0123456789abcdef0123456789abcdef",
      execDebugCommand,
      {
        createTaskId: () => "dshi-0123456789abcdef0123456789abcdef",
        region: "global",
      },
    );

    await client.startInstall("repair");

    const command = String(execDebugCommand.mock.calls[0]?.[1]);
    expect(command).toMatch(/ 'repair'$/);
    expect(command).toContain(".lightvela-repair-backup-$task_id");
    expect(command).toContain("restore_repair_profile");
    expect(command).not.toContain("--replace-web-profile");
    const embeddedSources = Array.from(
      createDeepSeekHarnessInstallLaunchScript().matchAll(/base64\.b64decode\('([^']+)'\)/g),
      (match) => {
        const payload = match[1];
        if (!payload) throw new Error("missing embedded launch helper");
        return Buffer.from(payload, "base64").toString("utf8");
      },
    );
    expect(embeddedSources.join("\n")).toContain("cordis.patch.yml");
  });

  it("keeps an indeterminate launch task when reconciliation is also unavailable", async () => {
    const execDebugCommand = vi.fn()
      .mockRejectedValueOnce(new Error("launch response lost"))
      .mockRejectedValueOnce(new Error("reconciliation unavailable"));
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand, {
      createTaskId: () => "dshi-0123456789abcdef0123456789abcdef",
    });

    await expect(client.startInstall()).resolves.toEqual({
      task_id: "dshi-0123456789abcdef0123456789abcdef",
    });
    expect(execDebugCommand).toHaveBeenCalledTimes(2);
    expect(String(execDebugCommand.mock.calls[1]?.[1])).toContain("systemctl show");
  });

  it("rejects when read-only reconciliation confirms no task was launched", async () => {
    const execDebugCommand = vi.fn()
      .mockRejectedValueOnce(new Error("launch response lost"))
      .mockResolvedValueOnce({ status: "Failed", exitCode: 3, output: "" });
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand, {
      createTaskId: () => "dshi-0123456789abcdef0123456789abcdef",
    });

    await expect(client.startInstall()).rejects.toThrow("launch response lost");
    expect(execDebugCommand).toHaveBeenCalledTimes(2);
  });

  it("keeps an indeterminate task when reconciliation returns an inconclusive result", async () => {
    const execDebugCommand = vi.fn()
      .mockRejectedValueOnce(new Error("launch response lost"))
      .mockResolvedValueOnce({ status: "Timeout", exitCode: -1, output: "" });
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand, {
      createTaskId: () => "dshi-0123456789abcdef0123456789abcdef",
    });

    await expect(client.startInstall()).resolves.toEqual({
      task_id: "dshi-0123456789abcdef0123456789abcdef",
    });
    expect(execDebugCommand).toHaveBeenCalledTimes(2);
  });

  it("publishes a failed task atomically when the installer download fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lightvela-dsh-launch-"));
    const stateDir = path.join(root, "tasks");
    const workDir = path.join(root, "work");
    const { binDir, sourcePath } = await createFakeCurl(root, null);

    const taskId = "dshi-0123456789abcdef0123456789abcdef";
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        createDeepSeekHarnessInstallLaunchScript(),
        "lightvela-dsh-install",
        taskId,
        stateDir,
        workDir,
        trustedBrowserHost,
      ],
      {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, TEST_INSTALLER_SOURCE: sourcePath },
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    const task = JSON.parse(await readFile(path.join(stateDir, `${taskId}.json`), "utf8")) as {
      status: string;
      stage: string;
    };
    expect(task).toMatchObject({ status: "failed", stage: "prepare" });
    await expect(access(workDir)).rejects.toThrow();
  });

  it("downloads a valid script, hands off to the installer, and removes its work directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lightvela-dsh-success-"));
    const stateDir = path.join(root, "tasks");
    const workDir = path.join(root, "work");
    const installer = paddedInstaller([
      'task_id="$3"',
      'printf \'{"task_id":"%s","status":"succeeded"}\\n\' "$task_id" > "$TEST_TASK_DIR/$task_id.json"',
    ]);
    const { binDir, sourcePath } = await createFakeCurl(root, installer);

    const taskId = "dshi-0123456789abcdef0123456789abcdef";
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        createDeepSeekHarnessInstallLaunchScript(undefined, sha256(installer)),
        "lightvela-dsh-install",
        taskId,
        stateDir,
        workDir,
        trustedBrowserHost,
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          TEST_INSTALLER_SOURCE: sourcePath,
          TEST_TASK_DIR: stateDir,
        },
        encoding: "utf8",
      },
    );

    const task = JSON.parse(await readFile(path.join(stateDir, `${taskId}.json`), "utf8")) as {
      status: string;
      message: string;
    };
    expect(result.status, `${JSON.stringify(task)}\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(task.status).toBe("succeeded");
    await expect(access(workDir)).rejects.toThrow();
  });

  it("replaces pending with failed when the downloaded installer exits before writing a task", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lightvela-dsh-installer-failure-"));
    const stateDir = path.join(root, "tasks");
    const workDir = path.join(root, "work");
    const installer = paddedInstaller(["exit 42"]);
    const { binDir, sourcePath } = await createFakeCurl(root, installer);

    const taskId = "dshi-0123456789abcdef0123456789abcdef";
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        createDeepSeekHarnessInstallLaunchScript(undefined, sha256(installer)),
        "lightvela-dsh-install",
        taskId,
        stateDir,
        workDir,
        trustedBrowserHost,
      ],
      {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, TEST_INSTALLER_SOURCE: sourcePath },
        encoding: "utf8",
      },
    );

    const task = JSON.parse(await readFile(path.join(stateDir, `${taskId}.json`), "utf8")) as {
      status: string;
      stage: string;
      message: string;
    };
    expect(result.status, `${JSON.stringify(task)}\n${result.stdout}\n${result.stderr}`).toBe(42);
    expect(task).toMatchObject({ status: "failed", stage: "install" });
  });

  it("rejects an oversized downloaded installer before executing it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lightvela-dsh-oversized-"));
    const stateDir = path.join(root, "tasks");
    const workDir = path.join(root, "work");
    const oversizedInstaller = "#!/usr/bin/env bash\n" + `# ${"x".repeat(1024 * 1024)}`;
    const { binDir, sourcePath } = await createFakeCurl(root, oversizedInstaller);

    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        createDeepSeekHarnessInstallLaunchScript(),
        "lightvela-dsh-install",
        "dshi-0123456789abcdef0123456789abcdef",
        stateDir,
        workDir,
        trustedBrowserHost,
      ],
      {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, TEST_INSTALLER_SOURCE: sourcePath },
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    const task = JSON.parse(await readFile(
      path.join(stateDir, "dshi-0123456789abcdef0123456789abcdef.json"),
      "utf8",
    )) as { status: string; message: string };
    expect(task).toMatchObject({ status: "failed", message: "Invalid installer size" });
  });

  it("rejects a syntactically valid installer whose checksum does not match", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lightvela-dsh-checksum-"));
    const stateDir = path.join(root, "tasks");
    const workDir = path.join(root, "work");
    const executedPath = path.join(root, "executed");
    const trustedInstaller = paddedInstaller(["exit 0"]);
    const tamperedInstaller = paddedInstaller(['touch "$TEST_EXECUTED_PATH"']);
    const { binDir, sourcePath } = await createFakeCurl(root, tamperedInstaller);
    const taskId = "dshi-0123456789abcdef0123456789abcdef";

    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        createDeepSeekHarnessInstallLaunchScript(undefined, sha256(trustedInstaller)),
        "lightvela-dsh-install",
        taskId,
        stateDir,
        workDir,
        trustedBrowserHost,
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          TEST_INSTALLER_SOURCE: sourcePath,
          TEST_EXECUTED_PATH: executedPath,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    const task = JSON.parse(await readFile(path.join(stateDir, `${taskId}.json`), "utf8")) as {
      status: string;
      stage: string;
      message: string;
    };
    expect(task).toMatchObject({
      status: "failed",
      stage: "verify_installer",
      message: "Installer checksum mismatch",
    });
    await expect(access(executedPath)).rejects.toThrow();
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
    expect(execDebugCommand.mock.calls[0]?.[1]).toBe("sudo -n systemctl restart deepseek-harness.service");
    expect(execDebugCommand.mock.calls[1]?.[1]).toContain("sudo -n systemctl status deepseek-harness.service --no-pager");
  });

  it("rejects a failed restart without reporting the old healthy process as restarted", async () => {
    const execDebugCommand = vi.fn()
      .mockResolvedValueOnce({ status: "FAILED", exitCode: 1, output: "restart denied" })
      .mockResolvedValueOnce(success(JSON.stringify({
        installed: true,
        status: "running",
        service_status: "active",
        healthy: true,
      })));
    const client = new DeepSeekHarnessCommandClient("bot-1", execDebugCommand);

    await expect(client.restart()).rejects.toThrow("restart denied");
    expect(execDebugCommand).toHaveBeenCalledTimes(1);
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
    expect(keyCommand).toContain("-mmin +14 -delete");
    expect(keyCommand).toContain("sudo -n systemd-run");
    expect(keyCommand).toContain("--on-active=15m");
    expect(keyCommand).toContain("lightvela-dsh-secret-dshk-0123456789abcdef0123456789abcdef");
    const keySyntaxCheck = spawnSync("/bin/bash", ["-n", "-c", keyCommand], { encoding: "utf8" });
    expect(keySyntaxCheck.status, keySyntaxCheck.stderr).toBe(0);
    const saveCommand = String(execDebugCommand.mock.calls[2]?.[1]);
    expect(saveCommand).toContain("configure --provider deepseek");
    expect(saveCommand).not.toContain("sk-sensitive-value");
    expect(saveCommand).not.toContain(btoa("sk-sensitive-value"));
    expect(saveCommand).toContain("ZW5jcnlwdGVkLXNlY3JldA==");
    expect(saveCommand).toContain("rsa_padding_mode:oaep");
    expect(saveCommand).toContain('trap cleanup_secret_key EXIT');
    const syntaxCheck = spawnSync("/bin/bash", ["-n", "-c", saveCommand], { encoding: "utf8" });
    expect(syntaxCheck.status, syntaxCheck.stderr).toBe(0);
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
