// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import {
  DEFAULT_HERMES_AGENT_ID,
  getHermesProfileRootCommand,
} from "../../../lib/hermes-agent-command";

export const HERMES_MODEL_CONFIG_JSON_START = "__LIGHTVELA_HERMES_MODEL_CONFIG_JSON_START__";
export const HERMES_MODEL_CONFIG_JSON_END = "__LIGHTVELA_HERMES_MODEL_CONFIG_JSON_END__";

export type HermesCanonicalApiMode = "chat_completions" | "codex_responses" | "anthropic_messages" | "bedrock_converse";
export type HermesConnectionProbeStrategy = "model_list" | "model_request";
export type ModelDiscoveryStrategy = "live" | "catalog";

export interface HermesConfiguredModel {
  id: string;
  providerKey: string;
  providerName: string;
  baseUrl: string;
  routeBaseUrl?: string;
  apiMode: string;
  keyEnv: string;
  canDelete?: boolean;
  requiresSetup?: boolean;
}

export interface HermesModelConfigSnapshot {
  primary: HermesConfiguredModel | null;
  fallbacks: HermesConfiguredModel[];
  configuredModels: HermesConfiguredModel[];
  probedModels?: string[];
  probeSucceeded?: boolean;
}

export interface HermesModelProbeResult {
  models: string[];
  succeeded: boolean;
}

export interface HermesCredentialEnvelope {
  token: string;
  ciphertext: string;
}

export interface HermesCredentialEnvelopePreparation {
  token: string;
  publicKey: string;
}

export interface HermesConnectionProbeResult {
  success: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  timeMs?: number;
  errorCode?: string | number;
  errorMessage?: string;
}

export interface ModelProviderOption {
  providerKey: string;
  providerName: string;
  category: "coding_plan" | "api";
  baseUrl: string;
  apiMode: HermesCanonicalApiMode;
  discoveryStrategy: ModelDiscoveryStrategy;
  supportsLiveModelRefresh: boolean;
  description?: string;
  apiKeyUrl?: string;
  catalogModels?: Array<{ id: string; name: string }>;
  fixedModelSelection?: boolean;
}

export type HermesModelConfigAction =
  | { type: "prepareCredentialEnvelope" }
  | { type: "read" }
  | { type: "probeConfiguredProvider"; anchor: HermesConfiguredModel }
  | { type: "probeConfiguredModel"; anchor: HermesConfiguredModel; modelId: string }
  | { type: "appendProviderModel"; anchor: HermesConfiguredModel; modelId: string }
  | { type: "probe"; credentialEnvelope: HermesCredentialEnvelope; baseUrl: string; apiMode?: string }
  | { type: "connectivityProbe"; credentialEnvelope: HermesCredentialEnvelope; model: HermesConfiguredModel; strategy?: HermesConnectionProbeStrategy }
  | { type: "add"; credentialEnvelope: HermesCredentialEnvelope; model: HermesConfiguredModel; purpose: "primary" | "fallback" | "idle"; discoverModels?: boolean }
  | { type: "assign"; providerKey: string; modelId: string; baseUrl?: string; routeBaseUrl?: string; purpose: "primary" | "fallback" | "idle" }
  | { type: "removeFallback"; providerKey: string; modelId: string; baseUrl?: string; routeBaseUrl?: string }
  | { type: "remove"; providerKey: string; modelId: string; baseUrl?: string; routeBaseUrl?: string };

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const PYTHON_HELPER = String.raw`import base64
import copy
import fcntl
import inspect
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from hermes_cli import config as hermes_config
from hermes_cli import models as hermes_models

try:
    from hermes_cli.urllib_security import open_credentialed_url
except ImportError:
    open_credentialed_url = None

try:
    from hermes_cli import credential_lifecycle as credential_lifecycle
except ImportError:
    credential_lifecycle = None

try:
    from hermes_cli import fallback_config as fallback_config
except ImportError:
    fallback_config = None

try:
    from hermes_cli import auth as hermes_auth
except Exception:
    hermes_auth = None

try:
    from agent.backend_identity import BackendIdentity as HermesBackendIdentity
    from agent.backend_identity import same_deployment as hermes_same_deployment
except ImportError:
    HermesBackendIdentity = None
    hermes_same_deployment = None

load_config = hermes_config.load_config
save_config = hermes_config.save_config

START = "${HERMES_MODEL_CONFIG_JSON_START}"
END = "${HERMES_MODEL_CONFIG_JSON_END}"
CANONICAL_MODES = {
    "chat_completions": "chat_completions", "openai": "chat_completions", "openai_chat": "chat_completions",
    "codex_responses": "codex_responses", "codex": "codex_responses", "responses": "codex_responses",
    "anthropic_messages": "anthropic_messages", "anthropic": "anthropic_messages",
    "bedrock_converse": "bedrock_converse", "bedrock": "bedrock_converse",
}
TRANSPORTS = {
    "chat_completions": "openai_chat", "codex_responses": "codex_responses",
    "anthropic_messages": "anthropic_messages", "bedrock_converse": "bedrock_converse",
}
ENVELOPE_TTL_SECONDS = 600
MAX_MODEL_ID_LENGTH = 512
ASCII_CONTROL_CHARACTER_LIMIT = 32
MODEL_DISCOVERY_TIMEOUT_SECONDS = 30
MAX_MODEL_DISCOVERY_RESPONSE_BYTES = 2 * 1024 * 1024

class ConfigurationRollbackError(RuntimeError):
    pass

class ProviderOperationError(RuntimeError):
    pass

def log_provider_discovery_failure(error):
    # 只保留本 helper 的堆栈行号；异常原文、源码行、路径与局部变量可能含凭据。
    helper_lines = []
    frame = error.__traceback__
    while frame is not None and len(helper_lines) < 20:
        if frame.tb_frame.f_code.co_filename == "<stdin>":
            helper_lines.append(frame.tb_lineno)
        frame = frame.tb_next
    try:
        sys.stderr.write("LIGHTVELA_MODEL_DIAGNOSTIC " + json.dumps({
            "operation": "probe_saved_provider", "code": "discovery_failed", "helperLines": helper_lines,
        }) + "\n")
    except Exception:
        pass

def envelope_directory():
    root = os.environ.get("HERMES_HOME") or os.environ.get("HERMES_ROOT") or os.path.expanduser("~/.hermes")
    directory = os.path.join(root, ".lightvela-credential-envelopes")
    os.makedirs(directory, mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    return directory

def prepare_credential_envelope():
    directory = envelope_directory()
    now = time.time()
    for name in os.listdir(directory):
        path = os.path.join(directory, name)
        try:
            if name.endswith(".pem") and now - os.path.getmtime(path) > ENVELOPE_TTL_SECONDS: os.remove(path)
        except OSError:
            pass
    token = secrets.token_hex(24)
    private_path = os.path.join(directory, token + ".pem")
    try:
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        private_bytes = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        descriptor = os.open(private_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle: handle.write(private_bytes)
        public_key = private_key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("ascii")
        return {"token": token, "publicKey": public_key}
    except Exception:
        try: os.remove(private_path)
        except OSError: pass
        raise

def decrypt_credential(value):
    value = as_dict(value, "credentialEnvelope")
    token = text(value.get("token"), "credentialEnvelope.token")
    if not re.fullmatch(r"[a-f0-9]{48}", token): raise ValueError("credential envelope token is invalid")
    private_path = os.path.join(envelope_directory(), token + ".pem")
    if not os.path.isfile(private_path): raise ValueError("credential envelope is unavailable")
    try:
        if time.time() - os.path.getmtime(private_path) > ENVELOPE_TTL_SECONDS: raise ValueError("credential envelope expired")
        chunks = text(value.get("ciphertext"), "credentialEnvelope.ciphertext").split(".")
        if not chunks or len(chunks) > 64: raise ValueError("credential envelope is invalid")
        with open(private_path, "rb") as handle:
            private_key = serialization.load_pem_private_key(handle.read(), password=None)
        plaintext = []
        for chunk in chunks:
            encrypted = base64.b64decode(chunk, validate=True)
            decrypted = private_key.decrypt(
                encrypted,
                padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
            )
            plaintext.append(decrypted)
        credential = b"".join(plaintext).decode("utf-8")
        if not credential.strip(): raise ValueError("credential is empty")
        return credential
    finally:
        try: os.remove(private_path)
        except OSError: pass

def custom_endpoint_key_env(identity):
    helper = getattr(hermes_config, "custom_endpoint_key_env", None)
    if callable(helper): return helper(identity)
    slug = re.sub(r"[^A-Z0-9]+", "_", str(identity or "").upper()).strip("_")
    return "HERMES_CUSTOM_" + slug + "_API_KEY" if slug else "HERMES_CUSTOM_API_KEY"

def load_env():
    helper = getattr(hermes_config, "load_env", None)
    if callable(helper): return helper()
    values = {}
    root = os.environ.get("HERMES_HOME") or os.environ.get("HERMES_ROOT") or os.path.expanduser("~/.hermes")
    try:
        with open(os.path.join(root, ".env"), encoding="utf-8-sig", errors="replace") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if line.startswith("export "): line = line[7:].lstrip()
                if not line or line.startswith("#") or "=" not in line: continue
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return values

def save_provider_env_credential(key, value):
    helper = getattr(credential_lifecycle, "save_provider_env_credential", None) if credential_lifecycle else None
    if callable(helper): return helper(key, value)
    helper = getattr(hermes_config, "save_env_value", None)
    if not callable(helper): raise RuntimeError("Hermes credential writer is unavailable")
    return helper(key, value)

def remove_provider_env_credential(key):
    helper = getattr(credential_lifecycle, "remove_provider_env_credential", None) if credential_lifecycle else None
    if callable(helper): return helper(key)
    helper = getattr(hermes_config, "remove_env_value", None)
    if not callable(helper): raise RuntimeError("Hermes credential remover is unavailable")
    return helper(key)

def remove_env_credential_only(key):
    helper = getattr(hermes_config, "remove_env_value", None)
    if not callable(helper): raise RuntimeError("Hermes environment credential remover is unavailable")
    return helper(key)

def get_fallback_chain(config):
    helper = getattr(fallback_config, "get_fallback_chain", None) if fallback_config else None
    if callable(helper): return helper(config)
    return [entry for entry in raw_fallback_routes(config) if isinstance(entry, dict)]

def probe_api_models(api_key, base_url, timeout, mode):
    helper = getattr(hermes_models, "probe_api_models", None)
    if callable(helper):
        try: return helper(api_key, base_url, timeout=timeout, api_mode=mode)
        except TypeError: return helper(api_key, base_url, timeout=timeout)
    helper = getattr(hermes_models, "fetch_api_models", None)
    if not callable(helper): raise RuntimeError("Hermes model probe is unavailable")
    try: models = helper(api_key, base_url, timeout=timeout, api_mode=mode)
    except TypeError: models = helper(api_key, base_url, timeout=timeout)
    return {"models": models or []}

def sanitize_probe_error(value, credential):
    message = str(value or "").replace(credential, "[REDACTED]").strip()
    return message[:300] if message else "Model connectivity check failed"

def probed_model_ids(value):
    models = []
    raw_models = value.get("models") if isinstance(value, dict) else None
    for item in (raw_models if isinstance(raw_models, list) else []):
        model_id = str(item or "").strip()
        if model_id and model_id not in models: models.append(model_id)
    return models

def model_request_url(model):
    base_url = model["baseUrl"].rstrip("/")
    mode = model["apiMode"]
    if mode == "anthropic_messages":
        return (base_url if base_url.endswith("/v1") else base_url + "/v1") + "/messages"
    if mode == "chat_completions":
        return base_url + "/chat/completions"
    if mode == "codex_responses":
        return base_url + "/responses"
    raise ValueError("Model request probe is unavailable for this API mode")

def probe_model_request(credential, model, fallback, started_at, extra_headers=None):
    mode = model["apiMode"]
    headers = {"Content-Type": "application/json", "User-Agent": "lightvela-model-config"}
    if mode == "anthropic_messages":
        headers.update({"x-api-key": credential, "anthropic-version": "2023-06-01"})
    else:
        headers["Authorization"] = "Bearer " + credential
    headers.update(extra_headers or {})
    payload = {
        "model": model["id"],
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "ping"}],
    }
    if mode == "codex_responses":
        payload = {"model": model["id"], "input": "ping", "max_output_tokens": 16}
    request = urllib.request.Request(
        model_request_url(model),
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        if not callable(open_credentialed_url):
            raise RuntimeError("Hermes credential-safe HTTP transport is unavailable")
        # 安全传输会清除跨来源重定向中的凭据；不可回退到 urllib.request.urlopen。
        with open_credentialed_url(request, timeout=60) as response:
            status = int(getattr(response, "status", 200))
            if status < 200 or status >= 300:
                raise RuntimeError("Model endpoint returned HTTP " + str(status))
        return {
            "success": True,
            "provider": model["providerKey"],
            "model": model["id"],
            "baseUrl": model["baseUrl"],
            "timeMs": int((time.time() - started_at) * 1000),
        }
    except urllib.error.HTTPError as error:
        fallback["errorCode"] = error.code
        if error.code in (401, 403): fallback["errorMessage"] = "Model credential was rejected"
        elif error.code == 404: fallback["errorMessage"] = "Model endpoint is unavailable"
        elif error.code == 429: fallback["errorMessage"] = "Model request was rate limited"
        else: fallback["errorMessage"] = "Model endpoint returned HTTP " + str(error.code)
        return fallback

def probe_model_connection(credential, model, strategy="model_list"):
    provider = model["providerKey"]
    model_id = model["id"]
    base_url = model["baseUrl"]
    fallback = {
        "success": False,
        "provider": provider,
        "model": model_id,
        "baseUrl": base_url,
        "errorMessage": "Model connectivity check failed",
    }
    started_at = time.time()
    try:
        if strategy == "model_request":
            return probe_model_request(credential, model, fallback, started_at)
        if strategy != "model_list": raise ValueError("Model connectivity strategy is invalid")
        result = probe_api_models(credential, base_url, timeout=60, mode=model["apiMode"])
        models = probed_model_ids(result)
        if not models: return fallback
        if model_id not in models:
            fallback["errorMessage"] = "Selected model is unavailable"
            return fallback
        return {
            "success": True,
            "provider": provider,
            "model": model_id,
            "baseUrl": base_url,
            "timeMs": int((time.time() - started_at) * 1000),
        }
    except Exception as error:
        fallback["errorMessage"] = sanitize_probe_error(error, credential)
        return fallback

def provider_schema_supported(config):
    if callable(getattr(hermes_config, "providers_dict_to_custom_providers", None)): return True
    try:
        from hermes_cli import runtime_provider
        return 'config.get("providers")' in inspect.getsource(runtime_provider)
    except Exception:
        return False

def fail(message="Model configuration operation failed", code=None):
    print(START)
    print(json.dumps({"ok": False, "error": message, **({"errorCode": code} if code else {})}))
    print(END)

def as_dict(value, field):
    if not isinstance(value, dict): raise ValueError(field + " must be an object")
    return value

def text(value, field, required=True):
    result = str(value or "").strip()
    if required and not result: raise ValueError(field + " is required")
    return result

def api_mode(value, field):
    normalized = CANONICAL_MODES.get(text(value, field).lower())
    if not normalized: raise ValueError(field + " is unsupported")
    return normalized

def new_product_key(value):
    slug = re.sub(r"[^a-z0-9]+", "-", text(value, "providerKey").lower()).strip("-")
    return slug if slug.startswith("lightvela-") else "lightvela-" + slug

def normalized_model(value, field="model", product_key=False):
    value = as_dict(value, field)
    key = text(value.get("providerKey"), field + ".providerKey")
    base_url = text(value.get("baseUrl"), field + ".baseUrl")
    route_base_url = value.get("routeBaseUrl") if "routeBaseUrl" in value else base_url
    model = {
        "id": text(value.get("id"), field + ".id"),
        "providerKey": new_product_key(key) if product_key else key,
        "providerName": text(value.get("providerName"), field + ".providerName"),
        "baseUrl": base_url,
        "routeBaseUrl": text(route_base_url, field + ".routeBaseUrl", required=False),
        "apiMode": api_mode(value.get("apiMode"), field + ".apiMode"),
        "keyEnv": text(value.get("keyEnv"), field + ".keyEnv", required=False),
    }
    if value.get("requiresSetup") is True: model["requiresSetup"] = True
    return model

def provider_mode(provider, route):
    raw = route.get("api_mode") or provider.get("api_mode") or provider.get("transport") or "chat_completions"
    return api_mode(raw, "apiMode")

def model_from_route(config, route):
    route = as_dict(route, "route")
    provider_key = text(route.get("provider"), "route.provider", required=False)
    model_id = text(route.get("model") or route.get("default"), "route.model", required=False)
    if not provider_key or not model_id: return None
    providers = config.get("providers") if isinstance(config.get("providers"), dict) else {}
    provider = providers.get(provider_key) if isinstance(providers.get(provider_key), dict) else {}
    route_base_url = text(route.get("base_url"), "route.base_url", required=False)
    return {
        "id": model_id,
        "providerKey": provider_key,
        "providerName": text(provider.get("name") or provider.get("display_name") or provider_key, "providerName"),
        "baseUrl": text(route_base_url or provider.get("api") or provider.get("base_url"), "baseUrl", required=False),
        "routeBaseUrl": route_base_url,
        "apiMode": provider_mode(provider, route),
        "keyEnv": text(provider.get("key_env") or provider.get("api_key_env"), "keyEnv", required=False),
    }

def provider_base_url(provider):
    for key in ("base_url", "url", "api"):
        value = text(provider.get(key), "provider." + key, required=False)
        if value: return value
    return ""

def provider_model_id(provider):
    return text(provider.get("model") or provider.get("default_model"), "provider.model", required=False)

def provider_catalog_model_ids(provider):
    values = provider.get("models")
    if isinstance(values, dict):
        return [
            str(key).strip() for key in values.keys()
            if str(key).strip() and key != "__discovered_model_catalog__"
        ]
    if isinstance(values, list):
        result = []
        for value in values:
            if isinstance(value, str): model_id = value.strip()
            elif isinstance(value, dict): model_id = text(value.get("id"), "provider.models.id", required=False)
            else: model_id = ""
            if model_id: result.append(model_id)
        return result
    if isinstance(values, str) and values.strip(): return [values.strip()]
    return []

def provider_catalog_is_authoritative(provider, credential_state):
    values = provider.get("models")
    discovered = provider.get("models_discovered") is True or (
        isinstance(values, dict) and values.get("__discovered_model_catalog__") is True
    )
    if discovered: return False
    discover_models = provider.get("discover_models", True)
    if isinstance(discover_models, str):
        discover_models = discover_models.strip().lower() not in ("false", "no", "0")
    if discover_models is False: return bool(provider_catalog_model_ids(provider))
    return (
        credential_state is False
        and isinstance(values, (list, str))
        and bool(provider_catalog_model_ids(provider))
    )

def provider_credential_pool_state(provider_key, provider):
    helper = getattr(hermes_auth, "read_credential_pool", None) if hermes_auth else None
    if not callable(helper): return None
    try:
        pool = helper(None)
        if not isinstance(pool, dict): return False
        provider_name = text(provider.get("name") or provider.get("display_name") or provider_key, "provider.name", required=False)
        custom_pool_key = "custom:" + provider_name.strip().lower().replace(" ", "-") if provider_name else ""
        normalized_provider_key = provider_key.strip().lower()
        return any(
            isinstance(pool.get(key), list) and bool(pool[key])
            for key in (normalized_provider_key, custom_pool_key)
            if key
        )
    except Exception:
        return None

def idle_provider_is_usable(provider_key, provider, model_id=None):
    model_id = model_id or provider_model_id(provider)
    key_env = text(provider.get("key_env") or provider.get("api_key_env"), "provider.key_env", required=False)
    key_cmd = text(provider.get("key_cmd"), "provider.key_cmd", required=False)
    inline_key = text(provider.get("api_key"), "provider.api_key", required=False)
    credential_declared = bool(key_env or "api_key" in provider or "key_cmd" in provider)
    credential_state = True if key_cmd or inline_key else False
    env_read_failed = False
    if credential_state is False and key_env:
        try:
            env_values = load_env()
            credential_state = bool(
                (isinstance(env_values, dict) and str(env_values.get(key_env) or "").strip())
                or str(os.environ.get(key_env) or "").strip()
            )
        except Exception:
            env_read_failed = True
    pool_state = provider_credential_pool_state(provider_key, provider)
    if pool_state is True: credential_state = True
    elif credential_declared and (pool_state is None or env_read_failed) and credential_state is False:
        credential_state = None

    catalog = provider_catalog_model_ids(provider)
    if provider_catalog_is_authoritative(provider, credential_state) and model_id not in catalog: return False
    if credential_declared and credential_state is False: return False
    return True

def model_from_provider(provider_key, provider, model_id=None):
    if not isinstance(provider, dict): return None
    if provider.get("enabled") is False: return None
    model_id = model_id or provider_model_id(provider)
    if not model_id: return None
    return {
        "id": model_id,
        "providerKey": text(provider_key, "providerKey"),
        "providerName": text(provider.get("name") or provider.get("display_name") or provider_key, "providerName"),
        "baseUrl": provider_base_url(provider),
        "routeBaseUrl": "",
        "apiMode": provider_mode(provider, {}),
        "keyEnv": text(provider.get("key_env") or provider.get("api_key_env"), "keyEnv", required=False),
    }

def custom_provider_key(entry):
    explicit = text(entry.get("provider_key") or entry.get("provider"), "customProvider.provider", required=False)
    if explicit: return explicit
    name = text(entry.get("name"), "customProvider.name")
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "custom"

def model_from_custom_provider(entry):
    if not isinstance(entry, dict) or entry.get("enabled") is False: return None
    model_id = provider_model_id(entry)
    if not model_id: return None
    return {
        "id": model_id,
        "providerKey": custom_provider_key(entry),
        "providerName": text(entry.get("name"), "customProvider.name"),
        "baseUrl": provider_base_url(entry),
        "routeBaseUrl": "",
        "apiMode": provider_mode(entry, {}),
        "keyEnv": text(entry.get("key_env") or entry.get("api_key_env"), "keyEnv", required=False),
    }

def normalized_route_base_url(value):
    return str(value or "").strip().rstrip("/").lower()

def route_identity(model):
    if not model: return ("", "", "")
    route_base_url = model.get("routeBaseUrl") if "routeBaseUrl" in model else model.get("baseUrl")
    return (
        str(model.get("providerKey") or "").strip().lower(),
        str(model.get("id") or "").strip(),
        normalized_route_base_url(route_base_url),
    )

def same_route(left, right):
    return bool(left and right and route_identity(left) == route_identity(right))

def same_runtime_deployment(left, right):
    if not left or not right: return False
    # 配置管理保留模型 ID 大小写，避免运行时的宽松身份归一化合并不同模型。
    if route_identity(left)[1] != route_identity(right)[1]: return False
    left_base_url = left.get("routeBaseUrl") or left.get("baseUrl")
    right_base_url = right.get("routeBaseUrl") or right.get("baseUrl")
    if HermesBackendIdentity and callable(hermes_same_deployment):
        return hermes_same_deployment(
            HermesBackendIdentity.build(provider=left.get("providerKey"), model=left.get("id"), base_url=left_base_url),
            HermesBackendIdentity.build(provider=right.get("providerKey"), model=right.get("id"), base_url=right_base_url),
        )
    left_provider, left_model = route_identity(left)[:2]
    right_provider, right_model = route_identity(right)[:2]
    left_url = normalized_route_base_url(left_base_url)
    right_url = normalized_route_base_url(right_base_url)
    if left_provider != right_provider:
        if not (left_url and left_url == right_url and left_model and left_model == right_model): return False
        try:
            from hermes_cli.auth import PROVIDER_REGISTRY
            if left_provider in PROVIDER_REGISTRY and right_provider in PROVIDER_REGISTRY: return False
        except Exception:
            pass
        return True
    if not left_provider or not left_model or left_model != right_model: return False
    return not (left_url and right_url and left_url != right_url)

def same_configured_deployment(left, right, provider_keys):
    if not same_runtime_deployment(left, right): return False
    left_provider = route_identity(left)[0]
    right_provider = route_identity(right)[0]
    # A shared endpoint can still be an independent fallback route when its configured credential differs.
    if left_provider != right_provider and left_provider in provider_keys and right_provider in provider_keys:
        left_key_env = str(left.get("keyEnv") or "").strip()
        right_key_env = str(right.get("keyEnv") or "").strip()
        if left_key_env and right_key_env and left_key_env != right_key_env: return False
    return True

def configured_provider_keys(config):
    providers = config.get("providers") if isinstance(config.get("providers"), dict) else {}
    return {str(provider_key).strip().lower() for provider_key in providers}

def model_config(config):
    lightvela = config.get("lightvela") if isinstance(config.get("lightvela"), dict) else {}
    managed = lightvela.get("model_config") if isinstance(lightvela.get("model_config"), dict) else {}
    return managed

def configured_models(config):
    managed = model_config(config)
    values = []
    for entry in managed.get("configured_models", []):
        try:
            model = normalized_model(entry, "configuredModels")
            values.append(model)
        except ValueError: continue
    return values

def write_configured_models(config, values):
    lightvela = config.get("lightvela")
    if not isinstance(lightvela, dict): return
    managed = lightvela.get("model_config")
    if not isinstance(managed, dict): return
    managed["configured_models"] = values

def remove_legacy_configured_model(config, model):
    managed = model_config(config)
    raw_values = managed.get("configured_models") if isinstance(managed.get("configured_models"), list) else []
    retained = []
    removed = False
    for raw in raw_values:
        try: candidate = normalized_model(raw, "configuredModels")
        except ValueError:
            retained.append(raw)
            continue
        if same_runtime_deployment(candidate, model): removed = True
        else: retained.append(raw)
    if removed: write_configured_models(config, retained)

def remove_legacy_custom_provider(config, model):
    raw_values = config.get("custom_providers") if isinstance(config.get("custom_providers"), list) else []
    retained = []
    removed = False
    for raw in raw_values:
        try: candidate = model_from_custom_provider(raw)
        except (KeyError, TypeError, ValueError):
            retained.append(raw)
            continue
        if candidate and same_runtime_deployment(candidate, model): removed = True
        else: retained.append(raw)
    if removed:
        if retained: config["custom_providers"] = retained
        else: config.pop("custom_providers", None)

def fallback_models(config):
    values = []
    provider_keys = configured_provider_keys(config)
    for route in get_fallback_chain(config) or []:
        try: model = model_from_route(config, route)
        except (TypeError, ValueError): continue
        if model and not any(same_configured_deployment(model, saved, provider_keys) for saved in values): values.append(model)
    return values

def append_projected(values, candidate, provider_keys):
    if not candidate: return
    for current in values:
        if not same_configured_deployment(current, candidate, provider_keys): continue
        for field in ("providerName", "baseUrl", "routeBaseUrl", "apiMode", "keyEnv"):
            if not current.get(field) and candidate.get(field): current[field] = candidate[field]
        if not candidate.get("requiresSetup"): current.pop("requiresSetup", None)
        return
    values.append(dict(candidate))

def read_snapshot(config):
    primary = model_from_route(config, config.get("model") if isinstance(config.get("model"), dict) else {})
    fallbacks = fallback_models(config)
    providers = config.get("providers") if isinstance(config.get("providers"), dict) else {}
    provider_keys = configured_provider_keys(config)
    projected = []

    for provider_key, provider in providers.items():
        provider_models = provider.get("models") if isinstance(provider, dict) else None
        discover_models = provider.get("discover_models", True) if isinstance(provider, dict) else True
        if isinstance(discover_models, str):
            discover_models = discover_models.strip().lower() not in ("false", "no", "0")
        managed_models = (
            isinstance(provider_models, dict)
            and provider_models.get("__discovered_model_catalog__") is not True
            and provider.get("models_discovered") is not True
            and discover_models is False
        )
        model_ids = provider_catalog_model_ids(provider) if managed_models else [
            model_id for model_id, metadata in (provider_models.items() if isinstance(provider_models, dict) else [])
            if isinstance(metadata, dict) and metadata.get("lightvela_configured") is True
        ]
        projected_model_id = provider_model_id(provider) or (model_ids[0] if model_ids else "")
        try:
            candidate = model_from_provider(str(provider_key), provider, projected_model_id)
            if candidate and not idle_provider_is_usable(str(provider_key), provider, projected_model_id): candidate = None
        except (KeyError, TypeError, ValueError): candidate = None
        append_projected(projected, candidate, provider_keys)
        if candidate:
            for model_id in model_ids:
                configured = dict(candidate)
                configured["id"] = model_id
                append_projected(projected, configured, provider_keys)

    custom_providers = config.get("custom_providers") if isinstance(config.get("custom_providers"), list) else []
    for provider in custom_providers:
        try: candidate = model_from_custom_provider(provider)
        except (KeyError, TypeError, ValueError): candidate = None
        append_projected(projected, candidate, provider_keys)

    for candidate in configured_models(config): append_projected(projected, candidate, provider_keys)
    append_projected(projected, primary, provider_keys)
    for candidate in fallbacks: append_projected(projected, candidate, provider_keys)
    # 有效备用链可能已被运行时去重，仍保留原始配置中的其他模型供精确管理。
    for route in raw_fallback_routes(config):
        if not isinstance(route, dict): continue
        try: candidate = model_from_route(config, route)
        except (TypeError, ValueError): continue
        # 只补充遗漏模型，不用备用别名的显式端点覆盖既有的继承端点身份。
        if candidate and not any(same_configured_deployment(candidate, current, provider_keys) for current in projected):
            projected.append(dict(candidate))
    return {"primary": primary, "fallbacks": fallbacks, "configuredModels": projected}

def find_configured(config, provider_key, model_id, base_url=None, route_base_url=None):
    matches = [
        model for model in read_snapshot(config)["configuredModels"]
        if model["providerKey"].strip().lower() == provider_key.strip().lower()
        and model["id"].strip() == model_id.strip()
    ]
    if route_base_url is not None:
        target_url = normalized_route_base_url(route_base_url)
        matches = [model for model in matches if route_identity(model)[2] == target_url]
    elif base_url:
        target_url = normalized_route_base_url(base_url)
        matches = [model for model in matches if normalized_route_base_url(model.get("baseUrl")) == target_url]
    if len(matches) == 1: return matches[0]
    if len(matches) > 1: raise ValueError("model identity is ambiguous")
    raise ValueError("model is not saved")

def find_assignable(config, provider_key, model_id, base_url=None, route_base_url=None):
    try:
        return find_configured(config, provider_key, model_id, base_url, route_base_url)
    except ValueError as error:
        if str(error) != "model is not saved": raise
    matches = [
        model for model in read_snapshot(config)["configuredModels"]
        if model["providerKey"].strip().lower() == provider_key.strip().lower()
    ]
    if route_base_url is not None:
        target_url = normalized_route_base_url(route_base_url)
        matches = [model for model in matches if route_identity(model)[2] == target_url]
    elif base_url:
        target_url = normalized_route_base_url(base_url)
        matches = [model for model in matches if normalized_route_base_url(model.get("baseUrl")) == target_url]
    identities = {
        (
            normalized_route_base_url(model.get("routeBaseUrl") or model.get("baseUrl")),
            str(model.get("apiMode") or "").strip().lower(),
            str(model.get("keyEnv") or "").strip(),
        )
        for model in matches
    }
    if not matches: raise ValueError("model is not saved")
    if len(identities) != 1: raise ValueError("provider identity is ambiguous")
    model = dict(matches[0])
    model["id"] = model_id
    return model

def save_and_reload(config):
    save_config(config)
    saved = load_config() or {}
    if not isinstance(saved, dict): raise ValueError("saved config is invalid")
    return saved

def save_validate_or_rollback(original_config, config, validator):
    try:
        saved = save_and_reload(config)
        expect_fallback_config_saved(saved, config)
        return validator(saved)
    except Exception:
        try:
            save_config(original_config)
        except Exception as rollback_error:
            raise ConfigurationRollbackError("configuration rollback failed") from rollback_error
        raise

def current_credential(key):
    try:
        value = load_env().get(key)
        return value if isinstance(value, str) else None
    except Exception:
        return None

def restore_credential(key, previous):
    try:
        if previous is None: remove_env_credential_only(key)
        else: save_provider_env_credential(key, previous)
    except Exception:
        pass

def model_entry_id(value):
    if isinstance(value, str): return value.strip()
    if isinstance(value, dict): return text(value.get("id"), "provider.models.id", required=False)
    return ""

def add_provider_model(provider, model_id):
    existing = provider.get("models")
    if isinstance(existing, dict):
        models = dict(existing)
    elif isinstance(existing, list):
        models = {}
        for item in existing:
            item_id = model_entry_id(item)
            if not item_id: continue
            metadata = {key: value for key, value in item.items() if key not in ("id", "name")} if isinstance(item, dict) else {}
            models[item_id] = metadata
    else:
        models = {}
    models.setdefault(model_id, {})
    provider["models"] = models

def ensure_provider_model(config, model, discover_models=None, preserve_credentials=False):
    providers = config.get("providers") if isinstance(config.get("providers"), dict) else {}
    existing = providers.get(model["providerKey"])
    provider = dict(existing) if isinstance(existing, dict) else {}
    existing_declares_credentials = isinstance(existing, dict) and any(
        key in existing for key in ("api_key", "key_env", "api_key_env", "key_cmd")
    )
    aliases = ["display_name", "api", "url", "api_mode"]
    if not preserve_credentials: aliases.extend(["api_key", "api_key_env"])
    for alias in aliases:
        provider.pop(alias, None)
    provider["name"] = model["providerName"]
    if model.get("baseUrl"): provider["base_url"] = model["baseUrl"]
    previous_model = provider_model_id(provider)
    if previous_model:
        mark_provider_model(provider, previous_model)
    provider["model"] = model["id"]
    provider.pop("default_model", None)
    provider["transport"] = TRANSPORTS[model["apiMode"]]
    if isinstance(discover_models, bool): provider["discover_models"] = discover_models
    else: provider.setdefault("discover_models", True)
    if model.get("keyEnv") and (not preserve_credentials or not existing_declares_credentials):
        provider["key_env"] = model["keyEnv"]
    mark_provider_model(provider, model["id"])
    providers[model["providerKey"]] = provider
    config["providers"] = providers
    return provider

def mark_provider_model(provider, model_id):
    add_provider_model(provider, model_id)
    metadata = provider["models"].get(model_id)
    provider["models"][model_id] = {**(metadata if isinstance(metadata, dict) else {}), "lightvela_configured": True}

def saved_provider_target(config, action):
    anchor = as_dict(action.get("anchor"), "anchor")
    try:
        model = find_configured(config, text(anchor.get("providerKey"), "providerKey"), text(anchor.get("id"), "id"),
            text(anchor.get("baseUrl"), "baseUrl", False), anchor.get("routeBaseUrl"))
    except ValueError:
        raise ProviderOperationError("provider_changed")
    if any(str(model.get(key) or "") != str(anchor.get(key) or "") for key in ("apiMode", "keyEnv")):
        raise ProviderOperationError("provider_changed")
    if normalized_route_base_url(model.get("baseUrl")) != normalized_route_base_url(anchor.get("baseUrl")):
        raise ProviderOperationError("provider_changed")
    related = [item for item in read_snapshot(config)["configuredModels"]
        if item["providerKey"] == model["providerKey"] and route_identity(item)[2] == route_identity(model)[2]]
    if len({(item["apiMode"], item["keyEnv"]) for item in related}) != 1:
        raise ProviderOperationError("provider_ambiguous")
    if model.get("requiresSetup") or not model.get("baseUrl"):
        raise ProviderOperationError("provider_unsupported")
    return model

def append_saved_provider_model(config, action):
    model = saved_provider_target(config, action)
    model_id = text(action.get("modelId"), "modelId")
    if len(model_id) > MAX_MODEL_ID_LENGTH or any(ord(char) < ASCII_CONTROL_CHARACTER_LIMIT for char in model_id):
        raise ProviderOperationError("invalid_model")
    if any(item["providerKey"] == model["providerKey"]
        and route_identity(item)[2] == route_identity(model)[2]
        and item["id"].strip() == model_id
        for item in read_snapshot(config)["configuredModels"]):
        return {"snapshot": read_snapshot(config)}
    if not provider_schema_supported(config): raise ProviderOperationError("provider_unsupported")
    original = copy.deepcopy(config)
    providers = config.get("providers") if isinstance(config.get("providers"), dict) else {}
    provider = providers.get(model["providerKey"])
    if not isinstance(provider, dict):
        # Legacy entries are normalized only after resolving an exact saved anchor.
        legacy = [entry for entry in config.get("custom_providers", [])
            if isinstance(entry, dict) and same_runtime_deployment(model_from_custom_provider(entry), model)]
        if len(legacy) > 1: raise ProviderOperationError("provider_ambiguous")
        if legacy:
            providers[model["providerKey"]] = copy.deepcopy(legacy[0])
            config["providers"] = providers
        provider = ensure_provider_model(config, model, preserve_credentials=True)
        remove_legacy_configured_model(config, model)
        remove_legacy_custom_provider(config, model)
    elif normalized_route_base_url(provider_base_url(provider)) != normalized_route_base_url(model["baseUrl"]):
        raise ProviderOperationError("provider_ambiguous")
    else:
        provider = copy.deepcopy(provider)
        config["providers"][model["providerKey"]] = provider
    previous_model = provider_model_id(provider)
    if previous_model: mark_provider_model(provider, previous_model)
    mark_provider_model(provider, model_id)
    def validate(saved):
        if saved != config: raise ValueError("saved configuration differs")
        result = read_snapshot(saved)
        if not any(item["providerKey"] == model["providerKey"] and item["id"] == model_id for item in result["configuredModels"]):
            raise ValueError("model was not saved")
        return result
    if (load_config() or {}) != original: raise ProviderOperationError("provider_changed")
    try:
        return {"snapshot": save_validate_or_rollback(original, config, validate)}
    except ConfigurationRollbackError:
        raise
    except Exception:
        raise ProviderOperationError("save_failed")

def saved_provider_connection(config, action):
    model = saved_provider_target(config, action)
    mode = model["apiMode"]
    if mode not in ("chat_completions", "codex_responses", "anthropic_messages"):
        raise ProviderOperationError("discovery_unsupported")
    provider = (config.get("providers") or {}).get(model["providerKey"])
    if not isinstance(provider, dict):
        legacy = [entry for entry in config.get("custom_providers", [])
            if isinstance(entry, dict) and same_runtime_deployment(model_from_custom_provider(entry), model)]
        if len(legacy) > 1: raise ProviderOperationError("provider_ambiguous")
        if not legacy: raise ProviderOperationError("provider_unsupported")
        provider = legacy[0]
    credential = str(provider.get("api_key") or "").strip()
    key_env = model.get("keyEnv")
    if key_env and not credential: credential = str(load_env().get(key_env) or os.environ.get(key_env) or "").strip()
    headers = provider.get("extra_headers") or {}
    if not isinstance(headers, dict): raise ProviderOperationError("discovery_unsupported")
    if provider.get("key_cmd") or provider_credential_pool_state(model["providerKey"], provider):
        try:
            from hermes_cli.runtime_provider import _resolve_named_custom_runtime
            runtime = _resolve_named_custom_runtime(requested_provider=model["providerKey"], target_model=model["id"])
            if not runtime or normalized_route_base_url(runtime.get("base_url")) != normalized_route_base_url(model["baseUrl"]):
                raise ProviderOperationError("provider_ambiguous")
            credential = runtime.get("api_key")
            if callable(credential): credential = credential()
            headers = runtime.get("extra_headers") or headers
        except ProviderOperationError:
            raise
        except Exception:
            raise ProviderOperationError("credential_unavailable")
    if not credential or credential == "no-key-required":
        if key_env or "api_key" in provider or provider.get("key_cmd"):
            raise ProviderOperationError("credential_unavailable")
        credential = ""
    endpoint = model["baseUrl"].rstrip("/")
    if model.get("routeBaseUrl") and normalized_route_base_url(model["routeBaseUrl"]) != normalized_route_base_url(endpoint):
        raise ProviderOperationError("provider_ambiguous")
    return model, credential, headers

def probe_saved_model(config, action):
    model, credential, headers = saved_provider_connection(config, action)
    model = {**model, "id": text(action.get("modelId"), "modelId")}
    if len(model["id"]) > MAX_MODEL_ID_LENGTH or any(ord(char) < ASCII_CONTROL_CHARACTER_LIMIT for char in model["id"]):
        raise ProviderOperationError("invalid_model")
    fallback = {"success": False, "provider": model["providerKey"], "model": model["id"],
        "baseUrl": model["baseUrl"], "errorMessage": "Model connectivity check failed"}
    try:
        return {"connection": probe_model_request(credential, model, fallback, time.time(), headers)}
    except Exception:
        return {"connection": fallback}

def probe_saved_provider(config, action):
    model, credential, headers = saved_provider_connection(config, action)
    mode = model["apiMode"]
    endpoint = model["baseUrl"].rstrip("/")
    request_headers = {"Accept": "application/json"}
    if credential:
        request_headers.update({"x-api-key": credential, "anthropic-version": "2023-06-01"} if mode == "anthropic_messages" else {"Authorization": "Bearer " + credential})
    request_headers.update(headers)
    # 凭据不得随重定向发送到其他来源。
    if open_credentialed_url is None: raise ProviderOperationError("discovery_unsupported")
    try:
        request = urllib.request.Request(endpoint + "/models", headers=request_headers)
        with open_credentialed_url(request, timeout=MODEL_DISCOVERY_TIMEOUT_SECONDS) as response:
            data = json.loads(response.read(MAX_MODEL_DISCOVERY_RESPONSE_BYTES).decode("utf-8"))
        items = data.get("data") if isinstance(data, dict) else None
        if not isinstance(items, list): raise ProviderOperationError("discovery_unsupported")
        models = list(dict.fromkeys(item["id"].strip() for item in items
            if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"].strip()))
        snapshot = read_snapshot(config)
        return {"snapshot": {**snapshot, "probedModels": models, "probeSucceeded": True}}
    except urllib.error.HTTPError as error:
        raise ProviderOperationError("credential_rejected" if error.code in (401, 403) else "discovery_unsupported" if error.code in (404, 405) else "discovery_failed")
    except TimeoutError:
        raise ProviderOperationError("discovery_timeout")
    except urllib.error.URLError as error:
        if isinstance(error.reason, TimeoutError):
            raise ProviderOperationError("discovery_timeout")
        log_provider_discovery_failure(error)
        raise ProviderOperationError("discovery_failed")
    except ProviderOperationError:
        raise
    except Exception as error:
        log_provider_discovery_failure(error)
        raise ProviderOperationError("discovery_failed")

def remove_provider_model(provider, model_id):
    existing = provider.get("models")
    if isinstance(existing, dict): provider["models"] = {key: value for key, value in existing.items() if key != model_id}
    elif isinstance(existing, list): provider["models"] = [item for item in existing if model_entry_id(item) != model_id]
    else: provider["models"] = []

def snapshot_models(config):
    snapshot = read_snapshot(config)
    return [snapshot["primary"]] + snapshot["fallbacks"] + snapshot["configuredModels"]

def provider_referenced(config, provider_key):
    target = provider_key.strip().lower()
    return any(
        candidate and candidate["providerKey"].strip().lower() == target
        for candidate in snapshot_models(config)
    )

def credential_key_referenced(value, target):
    if isinstance(value, dict):
        for key, nested in value.items():
            if key in ("key_env", "api_key_env", "keyEnv") and isinstance(nested, str) and nested == target: return True
            if credential_key_referenced(nested, target): return True
    elif isinstance(value, list):
        return any(credential_key_referenced(item, target) for item in value)
    return False

def apply_primary(config, model):
    current = config.get("model") if isinstance(config.get("model"), dict) else {}
    current.pop("api_key", None)
    current.pop("api", None)
    current.update({"provider": model["providerKey"], "default": model["id"], "api_mode": model["apiMode"]})
    route_base_url = model.get("routeBaseUrl") if "routeBaseUrl" in model else model.get("baseUrl")
    if route_base_url: current["base_url"] = route_base_url
    else: current.pop("base_url", None)
    config["model"] = current

def fallback_entry(model):
    entry = {"provider": model["providerKey"], "model": model["id"], "api_mode": model["apiMode"]}
    route_base_url = model.get("routeBaseUrl") if "routeBaseUrl" in model else model.get("baseUrl")
    if route_base_url: entry["base_url"] = route_base_url
    return entry

def raw_fallback_routes(config):
    # 写操作必须读取原始条目，不能用 Hermes 已按小写去重的有效链覆盖配置。
    entries = []
    for key in ("fallback_providers", "fallback_model"):
        value = config.get(key)
        if value is None: continue
        for entry in value if isinstance(value, list) else [value]:
            if isinstance(entry, str) and entry.strip():
                primary = config.get("model") if isinstance(config.get("model"), dict) else {}
                entries.append({"provider": primary.get("provider"), "model": entry.strip()})
            else:
                entries.append(copy.deepcopy(entry))
    return entries

def expect_fallback_config_saved(saved, expected):
    # Hermes 会为缺省备用链补空列表；比较完整条目，兼容空值的序列化差异。
    if raw_fallback_routes(saved) != raw_fallback_routes(expected):
        raise ValueError("fallback configuration differs after save")

def write_fallback_routes(config, entries):
    if entries: config["fallback_providers"] = entries
    else: config.pop("fallback_providers", None)
    config.pop("fallback_model", None)

def apply_fallback(config, model):
    entries = []
    matched = False
    provider_keys = configured_provider_keys(config)
    for entry in raw_fallback_routes(config):
        try: candidate = model_from_route(config, entry) if isinstance(entry, dict) else None
        except (TypeError, ValueError): candidate = None
        if same_configured_deployment(candidate, model, provider_keys):
            if not matched: entries.append(entry)
            matched = True
        else: entries.append(entry)
    if not matched: entries.append(fallback_entry(model))
    write_fallback_routes(config, entries)

def remove_fallback(config, model, *, all_runtime_aliases=False):
    retained = []
    provider_keys = configured_provider_keys(config)
    for entry in raw_fallback_routes(config):
        try: candidate = model_from_route(config, entry) if isinstance(entry, dict) else None
        except (TypeError, ValueError): candidate = None
        matches = same_runtime_deployment(candidate, model) if all_runtime_aliases else same_configured_deployment(candidate, model, provider_keys)
        if not matches: retained.append(entry)
    write_fallback_routes(config, retained)

def is_fallback(config, snapshot, model):
    provider_keys = configured_provider_keys(config)
    return any(same_configured_deployment(item, model, provider_keys) for item in snapshot["fallbacks"])

def expect_role(saved, purpose, model):
    snapshot = read_snapshot(saved)
    if purpose == "primary" and not same_route(snapshot["primary"], model): raise ValueError("primary was not saved")
    if purpose == "fallback" and not is_fallback(saved, snapshot, model): raise ValueError("fallback was not saved")
    if purpose == "idle" and (same_route(snapshot["primary"], model) or is_fallback(saved, snapshot, model)): raise ValueError("idle role was not saved")
    return snapshot

def expect_fallback_removed(saved, model):
    snapshot = read_snapshot(saved)
    if is_fallback(saved, snapshot, model): raise ValueError("fallback was not removed")
    return snapshot

def execute_unlocked(action):
    action = as_dict(action, "action")
    kind = text(action.get("type"), "type")
    if kind == "prepareCredentialEnvelope": return {"credentialEnvelope": prepare_credential_envelope()}
    credential = decrypt_credential(action.get("credentialEnvelope")) if kind in ("probe", "connectivityProbe", "add") else None
    config = load_config() or {}
    if not isinstance(config, dict): raise ValueError("Hermes config must be an object")
    if kind == "read": return {"snapshot": read_snapshot(config)}
    if kind == "appendProviderModel": return append_saved_provider_model(config, action)
    if kind == "probeConfiguredProvider": return probe_saved_provider(config, action)
    if kind == "probeConfiguredModel": return probe_saved_model(config, action)
    if kind == "probe":
        result = probe_api_models(credential, text(action.get("baseUrl"), "baseUrl"), timeout=90, mode=api_mode(action.get("apiMode") or "chat_completions", "apiMode"))
        models = probed_model_ids(result)
        snapshot = read_snapshot(config)
        snapshot["probedModels"] = models
        snapshot["probeSucceeded"] = isinstance(result, dict) and isinstance(result.get("models"), list)
        return {"snapshot": snapshot}
    if kind == "connectivityProbe":
        model = normalized_model(action.get("model"))
        strategy = str(action.get("strategy") or "model_list").strip()
        return {"connection": probe_model_connection(credential, model, strategy)}
    if kind == "add":
        model = normalized_model(action.get("model"), product_key=True)
        purpose = text(action.get("purpose"), "purpose")
        if purpose not in ("primary", "fallback", "idle"): raise ValueError("purpose is invalid")
        original_config = copy.deepcopy(config)
        before = read_snapshot(config)
        if purpose == "fallback" and same_runtime_deployment(before["primary"], model): raise ValueError("role conflict")
        if not provider_schema_supported(config): raise ValueError("Hermes provider schema is unavailable")
        model["keyEnv"] = custom_endpoint_key_env(model["providerKey"])
        previous_credential = current_credential(model["keyEnv"])
        try:
            save_provider_env_credential(model["keyEnv"], credential)
        except Exception:
            restore_credential(model["keyEnv"], previous_credential)
            raise
        try:
            config = load_config() or {}
            if not isinstance(config, dict): raise ValueError("Hermes config must be an object")
            before = read_snapshot(config)
            if purpose == "fallback" and same_runtime_deployment(before["primary"], model): raise ValueError("role conflict")
            ensure_provider_model(config, model, action.get("discoverModels"))
            if purpose == "primary":
                apply_primary(config, model)
                remove_fallback(config, model, all_runtime_aliases=True)
            elif purpose == "fallback": apply_fallback(config, model)
            else: remove_fallback(config, model)
            save_config(config)
            saved = load_config() or {}
            if not isinstance(saved, dict): raise ValueError("saved config is invalid")
            expect_fallback_config_saved(saved, config)
            return {"snapshot": expect_role(saved, purpose, model)}
        except Exception:
            try: save_config(original_config)
            except Exception: pass
            restore_credential(model["keyEnv"], previous_credential)
            raise
    if kind == "assign":
        original_config = copy.deepcopy(config)
        route_base_url = text(action.get("routeBaseUrl"), "routeBaseUrl", required=False) if "routeBaseUrl" in action else None
        model = find_assignable(config, text(action.get("providerKey"), "providerKey"), text(action.get("modelId"), "modelId"), text(action.get("baseUrl"), "baseUrl", required=False), route_base_url)
        purpose = text(action.get("purpose"), "purpose")
        before = read_snapshot(config)
        if purpose == "fallback" and same_runtime_deployment(before["primary"], model): raise ValueError("role conflict")
        if purpose == "idle" and same_route(before["primary"], model): raise ValueError("cannot idle primary")
        if model.get("requiresSetup"): raise ValueError("model setup is incomplete")
        if not provider_schema_supported(config): raise ValueError("Hermes provider schema is unavailable")
        ensure_provider_model(config, model, preserve_credentials=True)
        remove_legacy_configured_model(config, model)
        remove_legacy_custom_provider(config, model)
        if purpose == "primary":
            apply_primary(config, model)
            remove_fallback(config, model, all_runtime_aliases=True)
        elif purpose == "fallback": apply_fallback(config, model)
        elif purpose == "idle":
            if is_fallback(config, before, model): remove_fallback(config, model)
            else: pass
        elif purpose != "idle": raise ValueError("purpose is invalid")
        snapshot = save_validate_or_rollback(original_config, config, lambda saved: expect_role(saved, purpose, model))
        return {"snapshot": snapshot}
    if kind == "removeFallback":
        original_config = copy.deepcopy(config)
        route_base_url = text(action.get("routeBaseUrl"), "routeBaseUrl", required=False) if "routeBaseUrl" in action else None
        model = find_configured(config, text(action.get("providerKey"), "providerKey"), text(action.get("modelId"), "modelId"), text(action.get("baseUrl"), "baseUrl", required=False), route_base_url)
        if model.get("requiresSetup"): raise ValueError("model setup is incomplete")
        if not provider_schema_supported(config): raise ValueError("Hermes provider schema is unavailable")
        ensure_provider_model(config, model, preserve_credentials=True)
        remove_legacy_configured_model(config, model)
        remove_legacy_custom_provider(config, model)
        remove_fallback(config, model)
        snapshot = save_validate_or_rollback(original_config, config, lambda saved: expect_fallback_removed(saved, model))
        return {"snapshot": snapshot}
    if kind == "remove":
        original_config = copy.deepcopy(config)
        route_base_url = text(action.get("routeBaseUrl"), "routeBaseUrl", required=False) if "routeBaseUrl" in action else None
        model = find_configured(config, text(action.get("providerKey"), "providerKey"), text(action.get("modelId"), "modelId"), text(action.get("baseUrl"), "baseUrl", required=False), route_base_url)
        before = read_snapshot(config)
        if same_route(before["primary"], model): raise ValueError("cannot remove primary")
        remove_fallback(config, model)
        remove_legacy_configured_model(config, model)
        remove_legacy_custom_provider(config, model)
        providers = config.get("providers") if isinstance(config.get("providers"), dict) else {}
        provider = providers.get(model["providerKey"]) if isinstance(providers.get(model["providerKey"]), dict) else None
        remove_key = model["keyEnv"]
        if provider is not None:
            provider = dict(provider)
            remove_key = model["keyEnv"] or text(provider.get("key_env") or provider.get("api_key_env"), "keyEnv", required=False) or custom_endpoint_key_env(model["providerKey"])
            if provider_model_id(provider).strip() == model["id"].strip():
                provider.pop("model", None)
                provider.pop("default_model", None)
            remove_provider_model(provider, model["id"])
            providers[model["providerKey"]] = provider
            config["providers"] = providers
            if not provider.get("models") and not provider_referenced(config, model["providerKey"]):
                providers.pop(model["providerKey"], None)
        config["providers"] = providers
        previous_credential = current_credential(remove_key) if remove_key else None
        try:
            saved = save_and_reload(config)
            expect_fallback_config_saved(saved, config)
            if any(same_route(item, model) for item in read_snapshot(saved)["configuredModels"]): raise ValueError("model was not removed")
            if remove_key and not credential_key_referenced(saved, remove_key):
                remove_provider_env_credential(remove_key)
            return {"snapshot": read_snapshot(saved)}
        except Exception:
            try: save_config(original_config)
            except Exception: pass
            if previous_credential is not None: restore_credential(remove_key, previous_credential)
            raise
    raise ValueError("unsupported action")

def execute(action):
    if action.get("type") not in ("add", "assign", "removeFallback", "remove", "appendProviderModel"):
        return execute_unlocked(action)
    root = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    os.makedirs(root, exist_ok=True)
    with open(os.path.join(root, ".lightvela-model-config.lock"), "a") as lock:
        started = time.monotonic()
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() - started > 5: raise ProviderOperationError("configuration_busy")
                time.sleep(0.05)
        return execute_unlocked(action)

try:
    payload = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
    result = execute(payload)
    print(START)
    print(json.dumps({"ok": True, **result}, ensure_ascii=False))
    print(END)
except ConfigurationRollbackError:
    fail("Model configuration rollback failed", "rollback_failed" if payload.get("type") == "appendProviderModel" else None)
except ProviderOperationError as error:
    fail("Model configuration operation failed", str(error))
except Exception:
    fail()
`;

export function buildHermesModelConfigCommand(
  action: HermesModelConfigAction,
  profileId: string = DEFAULT_HERMES_AGENT_ID,
): string {
  const payload = encodeBase64(JSON.stringify(action));
  return [
    "set -e",
    'HERMES_ROOT="${HERMES_HOME:-$HOME/.hermes}"',
    "export HERMES_ROOT",
    getHermesProfileRootCommand(profileId),
    'export HERMES_HOME="$HERMES_PROFILE_ROOT"',
    'HERMES_PYTHON="$HERMES_ROOT/hermes-agent/venv/bin/python"',
    'if [ ! -x "$HERMES_PYTHON" ]; then HERMES_PYTHON="python3"; fi',
    `"$HERMES_PYTHON" - "${payload}" <<'PY'`,
    PYTHON_HELPER,
    "PY",
  ].join("\n");
}
