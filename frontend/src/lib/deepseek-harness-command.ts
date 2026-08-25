import {
  DEEPSEEK_HARNESS_INSTALL_PAYLOAD_CHUNKS,
  DEEPSEEK_HARNESS_INSTALL_PAYLOAD_SHA256,
  DEEPSEEK_HARNESS_PROVIDER_HELPER_BASE64,
} from "@/lib/generated/deepseek-harness-runtime-assets";

export const DEEPSEEK_HARNESS_CN_PROVIDERS = [
  "deepseek",
  "minimax-cn",
  "moonshotai-cn",
  "qwen-token-plan-cn",
  "openrouter",
] as const;

export const DEEPSEEK_HARNESS_GLOBAL_PROVIDERS = [
  "deepseek",
  "minimax",
  "minimax-cn",
  "moonshotai",
  "moonshotai-cn",
  "openrouter",
  "anthropic",
  "groq",
  "openai",
] as const;

export type DeepSeekHarnessProviderID =
  | (typeof DEEPSEEK_HARNESS_GLOBAL_PROVIDERS)[number]
  | "qwen-token-plan-cn";
export type DeepSeekHarnessRegion = "cn" | "global";

export interface DeepSeekHarnessProvider {
  id: DeepSeekHarnessProviderID;
  displayName: string;
  configured: boolean;
  active: boolean;
  writable: boolean;
}

export interface DeepSeekHarnessStatus {
  installed: boolean;
  status: string;
  service_status: string;
  healthy: boolean;
}

export interface DeepSeekHarnessInstallation {
  task_id: string;
  status: "pending" | "running" | "succeeded" | "failed" | string;
  stage: string;
  progress: number;
  message: string;
  error?: string;
  updated_at: string;
}

export type DeepSeekHarnessExecDebugCommand = (
  botId: string,
  command: string,
  options?: { timeoutMs?: number },
) => Promise<{ status: string; exitCode: number; output: string }>;

interface DeepSeekHarnessCommandClientOptions {
  createTaskId?: () => string;
  createSecretId?: () => string;
  installPayload?: {
    chunks: readonly string[];
    sha256: string;
  };
  providerHelperBase64?: string;
  encryptSecret?: (publicKeyBase64: string, value: string) => Promise<string>;
}

const SERVICE = "deepseek-harness.service";
const TASK_ID_PATTERN = /^dshi-[0-9a-f]{32}$/;
const SECRET_ID_PATTERN = /^dshk-[0-9a-f]{32}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const INSTALL_UPLOAD_PREFIX = "/tmp/lightvela-dsh-upload-";
const INSTALLATION_STATE_DIR = "/var/lib/lightvela/dsh/installations";
const SECRET_TRANSPORT_DIR = "/home/agentuser/.dsh/.lightvela-secret-transport";
const ALL_PROVIDERS = new Set<string>([
  ...DEEPSEEK_HARNESS_CN_PROVIDERS,
  ...DEEPSEEK_HARNESS_GLOBAL_PROVIDERS,
]);

const STATUS_COMMAND = [
  `if sudo systemctl status ${SERVICE} --no-pager >/dev/null 2>&1; then`,
  `  printf '%s\\n' '{"installed":true,"status":"running","service_status":"active","healthy":true}'`,
  "elif sudo test -x /opt/lightvela/dsh/current/node_modules/.bin/dsh; then",
  `  printf '%s\\n' '{"installed":true,"status":"stopped","service_status":"inactive","healthy":false}'`,
  "else",
  `  printf '%s\\n' '{"installed":false,"status":"not-installed","service_status":"inactive","healthy":false}'`,
  "fi",
].join("\n");

const INSTALL_PAYLOAD_EXTRACTOR = [
  "import base64,gzip,hashlib,io,json,os,pathlib,sys",
  "source,target,expected=sys.argv[1:]",
  "def fail(message): raise ValueError(message)",
  "encoded_path=pathlib.Path(source)",
  "if encoded_path.stat().st_size>1048576: fail('encoded payload is too large')",
  "try: compressed=base64.b64decode(encoded_path.read_bytes(),validate=True)",
  "except Exception as exc: fail(f'invalid payload encoding: {exc}')",
  "if hashlib.sha256(compressed).hexdigest()!=expected: fail('payload checksum mismatch')",
  "try:",
  " with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as archive: decoded=archive.read(16777217)",
  "except Exception as exc: fail(f'invalid payload archive: {exc}')",
  "if len(decoded)>16777216: fail('payload is too large')",
  "try: payload=json.loads(decoded)",
  "except Exception as exc: fail(f'invalid payload manifest: {exc}')",
  "if not isinstance(payload,dict) or payload.get('schemaVersion')!=1: fail('unsupported payload schema')",
  "files=payload.get('files')",
  "if not isinstance(files,list) or not files or len(files)>256: fail('invalid payload file list')",
  "root=pathlib.Path(target)",
  "root.mkdir(parents=True,exist_ok=False)",
  "seen=set()",
  "total_size=0",
  "for item in files:",
  " if not isinstance(item,dict) or not isinstance(item.get('path'),str): fail('invalid payload file')",
  " relative=pathlib.PurePosixPath(item['path'])",
  " if relative.is_absolute() or '..' in relative.parts or not relative.parts: fail('unsafe payload path')",
  " if item['path'] in seen or item.get('mode') not in (420,493): fail('invalid payload metadata')",
  " try: content=base64.b64decode(item.get('content',''),validate=True)",
  " except Exception as exc: fail(f'invalid file content: {exc}')",
  " if len(content)>8388608: fail('payload file is too large')",
  " total_size+=len(content)",
  " if total_size>12582912: fail('payload contents are too large')",
  " seen.add(item['path'])",
  " destination=root.joinpath(*relative.parts)",
  " destination.parent.mkdir(parents=True,exist_ok=True)",
  " destination.write_bytes(content)",
  " os.chmod(destination,item['mode'])",
  "if 'installer/install-deepseek-harness.sh' not in seen: fail('installer is missing')",
].join("\n");

const INSTALL_TASK_STATUS_CHECKER = [
  "import json,pathlib,sys",
  "path,expected=sys.argv[1:]",
  "try: payload=json.loads(pathlib.Path(path).read_text(encoding='utf-8'))",
  "except Exception: sys.exit(1)",
  "sys.exit(0 if payload.get('status')==expected else 1)",
].join("\n");

const INSTALL_TASK_WRITER = [
  "import json,os,pathlib,sys,tempfile",
  "from datetime import datetime,timezone",
  "directory,task_id,status,stage,progress,message=sys.argv[1:]",
  "root=pathlib.Path(directory)",
  "root.mkdir(parents=True,exist_ok=True,mode=0o700)",
  "os.chmod(root,0o700)",
  "payload={'task_id':task_id,'status':status,'stage':stage,'progress':int(progress),'message':message,'updated_at':datetime.now(timezone.utc).isoformat().replace('+00:00','Z')}",
  "if status=='failed': payload['error']=message",
  "fd,temp_path=tempfile.mkstemp(prefix=f'{task_id}.',suffix='.tmp',dir=root)",
  "try:",
  " with os.fdopen(fd,'w',encoding='utf-8') as handle: json.dump(payload,handle,ensure_ascii=True,separators=(',',':')); handle.write('\\n')",
  " os.chmod(temp_path,0o600)",
  " os.replace(temp_path,root/f'{task_id}.json')",
  "except BaseException:",
  " try: os.unlink(temp_path)",
  " except FileNotFoundError: pass",
  " raise",
].join("\n");

const randomHexId = (prefix: string) => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
};

const defaultTaskId = () => randomHexId("dshi");
const defaultSecretId = () => randomHexId("dshk");

const encodeUtf8Base64 = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const encodeBytesBase64 = (value: Uint8Array) => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const decodeBase64Bytes = (value: string) => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const encryptDeepSeekHarnessSecret = async (publicKeyBase64: string, value: string) => {
  const plaintext = new TextEncoder().encode(value);
  if (plaintext.byteLength > 400) throw new Error("API key is too long");
  const publicKey = await globalThis.crypto.subtle.importKey(
    "spki",
    decodeBase64Bytes(publicKeyBase64),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    plaintext,
  );
  return encodeBytesBase64(new Uint8Array(encrypted));
};

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export const createDeepSeekHarnessInstallLaunchScript = () => {
  const extractorBase64 = encodeUtf8Base64(INSTALL_PAYLOAD_EXTRACTOR);
  const taskStatusCheckerBase64 = encodeUtf8Base64(INSTALL_TASK_STATUS_CHECKER);
  const taskWriterBase64 = encodeUtf8Base64(INSTALL_TASK_WRITER);
  return [
    "set -Eeuo pipefail",
    'upload_dir="$1"',
    'task_id="$2"',
    'expected_sha="$3"',
    'state_dir="$4"',
    "installer_started=0",
    'write_task_state() { python3 -c "import base64;exec(base64.b64decode(\''
      + taskWriterBase64
      + "'))\" \"$state_dir\" \"$task_id\" \"$1\" \"$2\" \"$3\" \"$4\"; }",
    'task_has_status() { python3 -c "import base64;exec(base64.b64decode(\''
      + taskStatusCheckerBase64
      + "'))\" \"$state_dir/$task_id.json\" \"$1\"; }",
    'cleanup_upload() { rm -rf -- "$upload_dir"; }',
    'on_exit() { rc=$?; trap - EXIT; if [ "$rc" -ne 0 ] && [ "$installer_started" -eq 0 ]; then write_task_state failed prepare 0 "Installation preparation failed" || true; fi; cleanup_upload; exit "$rc"; }',
    "trap on_exit EXIT",
    'install -d -m 0700 -- "$state_dir"',
    'write_task_state pending prepare 0 "Preparing installation"',
    `python3 -c "import base64;exec(base64.b64decode('${extractorBase64}'))" "$upload_dir/payload.b64" "$upload_dir/files" "$expected_sha"`,
    "installer_started=1",
    "set +e",
    'LIGHTVELA_DSH_ASSETS_DIR="$upload_dir/files/assets" "$upload_dir/files/installer/install-deepseek-harness.sh" install --task-id "$task_id"',
    "installer_rc=$?",
    "set -e",
    'if [ "$installer_rc" -ne 0 ]; then if ! task_has_status failed; then write_task_state failed install 0 "Installation failed before reporting status"; fi; exit "$installer_rc"; fi',
    'if ! task_has_status succeeded; then write_task_state failed install 0 "Installation finished without success status"; exit 1; fi',
  ].join("\n");
};

const parseJson = <T>(output: string, label: string): T => {
  try {
    return JSON.parse(output.trim()) as T;
  } catch {
    throw new Error(`Invalid DeepSeek Harness ${label} response`);
  }
};

const assertCommandSucceeded = (
  result: { exitCode: number; output: string },
  fallback: string,
) => {
  if (result.exitCode === 0) return;
  const detail = result.output
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
    ?.replace(/^(?:RuntimeError|ValueError):\s*/, "");
  throw new Error(detail || fallback);
};

const assertTaskId = (taskId: string) => {
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error("Invalid DeepSeek Harness task id");
};

const assertSecretId = (secretId: string) => {
  if (!SECRET_ID_PATTERN.test(secretId)) throw new Error("Invalid secret transport id");
};

const assertProvider = (provider: string): asserts provider is DeepSeekHarnessProviderID => {
  if (!ALL_PROVIDERS.has(provider)) throw new Error("Unsupported DeepSeek Harness provider");
};

export class DeepSeekHarnessCommandClient {
  private readonly createTaskId: () => string;
  private readonly createSecretId: () => string;
  private readonly installPayload: { chunks: readonly string[]; sha256: string };
  private readonly providerHelperBase64: string;
  private readonly encryptSecret: (publicKeyBase64: string, value: string) => Promise<string>;

  constructor(
    private readonly botId: string,
    private readonly execDebugCommand: DeepSeekHarnessExecDebugCommand,
    options: DeepSeekHarnessCommandClientOptions = {},
  ) {
    this.createTaskId = options.createTaskId ?? defaultTaskId;
    this.createSecretId = options.createSecretId ?? defaultSecretId;
    this.installPayload = options.installPayload ?? {
      chunks: DEEPSEEK_HARNESS_INSTALL_PAYLOAD_CHUNKS,
      sha256: DEEPSEEK_HARNESS_INSTALL_PAYLOAD_SHA256,
    };
    this.providerHelperBase64 = options.providerHelperBase64
      ?? DEEPSEEK_HARNESS_PROVIDER_HELPER_BASE64;
    this.encryptSecret = options.encryptSecret ?? encryptDeepSeekHarnessSecret;
  }

  async getStatus(): Promise<DeepSeekHarnessStatus> {
    const result = await this.execDebugCommand(this.botId, STATUS_COMMAND, { timeoutMs: 30_000 });
    return parseJson<DeepSeekHarnessStatus>(result.output, "status");
  }

  async startInstall(): Promise<{ task_id: string }> {
    const taskId = this.createTaskId();
    assertTaskId(taskId);
    if (!SHA256_PATTERN.test(this.installPayload.sha256) || this.installPayload.chunks.length === 0) {
      throw new Error("Invalid DeepSeek Harness installation payload");
    }
    const uploadDir = `${INSTALL_UPLOAD_PREFIX}${taskId}`;
    const payloadPath = `${uploadDir}/payload.b64`;
    const cleanupCommand = `rm -rf -- ${shellQuote(uploadDir)}`;
    let launchRequested = false;

    try {
      const prepareResult = await this.execDebugCommand(
        this.botId,
        `${cleanupCommand} && install -d -m 0700 -- ${shellQuote(uploadDir)} && : > ${shellQuote(payloadPath)}`,
        { timeoutMs: 30_000 },
      );
      assertCommandSucceeded(prepareResult, "DeepSeek Harness payload preparation failed");

      for (const chunk of this.installPayload.chunks) {
        const uploadResult = await this.execDebugCommand(
          this.botId,
          `printf '%s' ${shellQuote(chunk)} >> ${shellQuote(payloadPath)}`,
          { timeoutMs: 30_000 },
        );
        assertCommandSucceeded(uploadResult, "DeepSeek Harness payload upload failed");
      }

      const launchScript = createDeepSeekHarnessInstallLaunchScript();
      const launchUnit = `lightvela-dsh-install-${taskId}.service`;
      const launchCommand = [
        "sudo -n systemd-run",
        `--unit=${launchUnit}`,
        "--collect",
        "--property=Type=exec",
        "--",
        "/bin/bash",
        "-c",
        shellQuote(launchScript),
        "lightvela-dsh-install",
        shellQuote(uploadDir),
        taskId,
        this.installPayload.sha256,
        shellQuote(INSTALLATION_STATE_DIR),
      ].join(" ");
      launchRequested = true;
      const launchResult = await this.execDebugCommand(this.botId, launchCommand, {
        timeoutMs: 30_000,
      });
      if (launchResult.exitCode !== 0) {
        launchRequested = false;
        assertCommandSucceeded(launchResult, "DeepSeek Harness installation launch failed");
      }
      return { task_id: taskId };
    } catch (error) {
      if (launchRequested) {
        const taskPath = `${INSTALLATION_STATE_DIR}/${taskId}.json`;
        const reconcileCommand = [
          "for delay in 0 1 2 4; do",
          '  [ "$delay" -eq 0 ] || sleep "$delay"',
          `  if sudo -n test -s ${shellQuote(taskPath)}`,
          `  || [ "$(sudo -n systemctl show --property=LoadState --value lightvela-dsh-install-${taskId}.service 2>/dev/null)" = "loaded" ]; then`,
          "    exit 0",
          "  fi",
          "done",
          "exit 3",
        ].join("\n");
        try {
          const reconciliation = await this.execDebugCommand(
            this.botId,
            reconcileCommand,
            { timeoutMs: 30_000 },
          );
          if (reconciliation.exitCode === 0) return { task_id: taskId };
          if (reconciliation.exitCode !== 3) return { task_id: taskId };
        } catch {
          return { task_id: taskId };
        }
        await this.execDebugCommand(
          this.botId,
          cleanupCommand,
          { timeoutMs: 30_000 },
        ).catch(() => {});
        throw error;
      }
      await this.execDebugCommand(this.botId, cleanupCommand, { timeoutMs: 30_000 }).catch(() => {});
      throw error;
    }
  }

  async getInstallation(taskId: string): Promise<DeepSeekHarnessInstallation> {
    assertTaskId(taskId);
    const result = await this.execDebugCommand(this.botId, [
      "sudo -n cat",
      `/var/lib/lightvela/dsh/installations/${taskId}.json`,
    ].join(" "), { timeoutMs: 30_000 });
    assertCommandSucceeded(result, "DeepSeek Harness installation status failed");
    return parseJson<DeepSeekHarnessInstallation>(result.output, "installation");
  }

  async restart(): Promise<DeepSeekHarnessStatus> {
    await this.execDebugCommand(
      this.botId,
      `sudo systemctl restart ${SERVICE}`,
      { timeoutMs: 120_000 },
    );
    return this.getStatus();
  }

  async listProviders(region: DeepSeekHarnessRegion): Promise<DeepSeekHarnessProvider[]> {
    const result = await this.execDebugCommand(
      this.botId,
      `${this.providerHelperCommand()} providers --region ${region}`,
      { timeoutMs: 30_000 },
    );
    const payload = parseJson<{ providers: DeepSeekHarnessProvider[] }>(result.output, "providers");
    const allowed = new Set<string>(
      region === "cn" ? DEEPSEEK_HARNESS_CN_PROVIDERS : DEEPSEEK_HARNESS_GLOBAL_PROVIDERS,
    );
    return payload.providers.filter((provider) => allowed.has(provider.id));
  }

  async saveProvider(provider: DeepSeekHarnessProviderID, apiKey: string): Promise<void> {
    assertProvider(provider);
    const value = apiKey.trim();
    if (!value) throw new Error("API key is required");
    const secretId = this.createSecretId();
    assertSecretId(secretId);
    const keyPath = `${SECRET_TRANSPORT_DIR}/${secretId}.pem`;
    const createKeyCommand = [
      "set -Eeuo pipefail",
      "umask 077",
      `install -d -m 0700 -- ${shellQuote(SECRET_TRANSPORT_DIR)}`,
      `find ${shellQuote(SECRET_TRANSPORT_DIR)} -maxdepth 1 -type f -name 'dshk-*.pem' -mmin +15 -delete`,
      `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out ${shellQuote(keyPath)} 2>/dev/null`,
      `openssl pkey -in ${shellQuote(keyPath)} -pubout -outform DER 2>/dev/null | base64 | tr -d '\\n'`,
    ].join("\n");
    const keyResult = await this.execDebugCommand(this.botId, createKeyCommand, { timeoutMs: 30_000 });
    assertCommandSucceeded(keyResult, "DeepSeek Harness secret transport setup failed");
    let encrypted = "";
    try {
      encrypted = await this.encryptSecret(keyResult.output.trim(), value);
    } catch (error) {
      await this.execDebugCommand(
        this.botId,
        `rm -f -- ${shellQuote(keyPath)}`,
        { timeoutMs: 30_000 },
      ).catch(() => {});
      throw error;
    }
    if (!BASE64_PATTERN.test(encrypted)) throw new Error("Invalid encrypted API key");
    const command = [
      "set -Eeuo pipefail",
      `key_path=${shellQuote(keyPath)}`,
      'cleanup_secret_key() { rm -f -- "$key_path"; }',
      "trap cleanup_secret_key EXIT",
      `printf '%s' ${shellQuote(encrypted)}`,
      "| base64 --decode",
      '| openssl pkeyutl -decrypt -inkey "$key_path" -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256',
      `| ${this.providerHelperCommand()} configure --provider ${provider}`,
    ].join("\n");
    const result = await this.execDebugCommand(this.botId, command, { timeoutMs: 30_000 });
    assertCommandSucceeded(result, "DeepSeek Harness provider configuration failed");
  }

  async removeProvider(provider: DeepSeekHarnessProviderID): Promise<void> {
    assertProvider(provider);
    const result = await this.execDebugCommand(
      this.botId,
      `${this.providerHelperCommand()} remove-provider --provider ${provider}`,
      { timeoutMs: 30_000 },
    );
    assertCommandSucceeded(result, "DeepSeek Harness provider removal failed");
    parseJson<{ ok: boolean; provider: DeepSeekHarnessProviderID; configured: false }>(
      result.output,
      "provider removal",
    );
  }

  private providerHelperCommand() {
    return [
      "sudo -n -u agentuser -H env",
      "HOME=/home/agentuser",
      "DSH_HOME=/home/agentuser/.dsh",
      "python3 -c",
      `"import base64;exec(base64.b64decode('${this.providerHelperBase64}'))"`,
    ].join(" ");
  }
}
