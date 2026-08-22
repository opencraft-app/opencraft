export const HERMES_MODEL_CONFIG_JSON_START = "__LIGHTVELA_HERMES_MODEL_CONFIG_JSON_START__";
export const HERMES_MODEL_CONFIG_JSON_END = "__LIGHTVELA_HERMES_MODEL_CONFIG_JSON_END__";

export type HermesCanonicalApiMode = "chat_completions" | "codex_responses" | "anthropic_messages" | "bedrock_converse";

export interface HermesConfiguredModel {
  id: string;
  providerKey: string;
  providerName: string;
  baseUrl: string;
  routeBaseUrl?: string;
  apiMode: string;
  keyEnv: string;
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
  description?: string;
  apiKeyUrl?: string;
  catalogModels?: Array<{ id: string; name: string }>;
}

export type HermesModelConfigAction =
  | { type: "prepareCredentialEnvelope" }
  | { type: "read" }
  | { type: "probe"; credentialEnvelope: HermesCredentialEnvelope; baseUrl: string; apiMode?: string }
  | { type: "connectivityProbe"; credentialEnvelope: HermesCredentialEnvelope; model: HermesConfiguredModel }
  | { type: "add"; credentialEnvelope: HermesCredentialEnvelope; model: HermesConfiguredModel; purpose: "primary" | "fallback" | "idle" }
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
import inspect
import json
import os
import re
import secrets
import sys
import time

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from hermes_cli import config as hermes_config
from hermes_cli import models as hermes_models

try:
    from hermes_cli import credential_lifecycle as credential_lifecycle
except ImportError:
    credential_lifecycle = None

try:
    from hermes_cli import fallback_config as fallback_config
except ImportError:
    fallback_config = None

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
    values = []
    for key in ("fallback_providers", "fallback_model"):
        candidate = config.get(key)
        entries = candidate if isinstance(candidate, list) else [candidate]
        for entry in entries:
            if isinstance(entry, dict): values.append(dict(entry))
            elif isinstance(entry, str) and entry.strip():
                primary = config.get("model") if isinstance(config.get("model"), dict) else {}
                values.append({"provider": primary.get("provider"), "model": entry.strip()})
    return values

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

def probe_model_connection(credential, model):
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

def fail():
    print(START)
    print(json.dumps({"ok": False, "error": "Model configuration operation failed"}))
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
    return {
        "id": text(value.get("id"), field + ".id"),
        "providerKey": new_product_key(key) if product_key else key,
        "providerName": text(value.get("providerName"), field + ".providerName"),
        "baseUrl": base_url,
        "routeBaseUrl": text(route_base_url, field + ".routeBaseUrl", required=False),
        "apiMode": api_mode(value.get("apiMode"), field + ".apiMode"),
        "keyEnv": text(value.get("keyEnv"), field + ".keyEnv", required=False),
    }

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

def normalized_route_base_url(value):
    return str(value or "").strip().rstrip("/").lower()

def route_identity(model):
    if not model: return ("", "", "")
    route_base_url = model.get("routeBaseUrl") if "routeBaseUrl" in model else model.get("baseUrl")
    return (
        str(model.get("providerKey") or "").strip().lower(),
        str(model.get("id") or "").strip().lower(),
        normalized_route_base_url(route_base_url),
    )

def same_route(left, right):
    return bool(left and right and route_identity(left) == route_identity(right))

def same_provider_model(left, right):
    return bool(
        left and right
        and left["id"].strip().lower() == right["id"].strip().lower()
        and left["providerKey"].strip().lower() == right["providerKey"].strip().lower()
    )

def same_runtime_deployment(left, right):
    if not left or not right: return False
    left_base_url = left.get("routeBaseUrl") if "routeBaseUrl" in left else left.get("baseUrl")
    right_base_url = right.get("routeBaseUrl") if "routeBaseUrl" in right else right.get("baseUrl")
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

def model_config(config):
    lightvela = config.get("lightvela") if isinstance(config.get("lightvela"), dict) else {}
    managed = lightvela.get("model_config") if isinstance(lightvela.get("model_config"), dict) else {}
    lightvela["model_config"] = managed
    config["lightvela"] = lightvela
    return managed

def configured_models(config):
    managed = model_config(config)
    values = []
    for entry in managed.get("configured_models", []):
        try: values.append(normalized_model(entry, "configuredModels"))
        except ValueError: continue
    managed["configured_models"] = values
    return values

def fallback_models(config):
    values = []
    for route in get_fallback_chain(config) or []:
        try: model = model_from_route(config, route)
        except (TypeError, ValueError): continue
        if model and not any(same_route(model, saved) for saved in values): values.append(model)
    return values

def read_snapshot(config):
    configured = configured_models(config)
    primary = model_from_route(config, config.get("model") if isinstance(config.get("model"), dict) else {})
    fallbacks = fallback_models(config)
    for candidate in [primary] + fallbacks:
        if candidate and not any(same_route(candidate, saved) for saved in configured): configured.append(candidate)
    return {"primary": primary, "fallbacks": fallbacks, "configuredModels": configured}

def find_configured(config, provider_key, model_id, base_url=None, route_base_url=None):
    matches = [
        model for model in read_snapshot(config)["configuredModels"]
        if model["providerKey"].strip().lower() == provider_key.strip().lower()
        and model["id"].strip().lower() == model_id.strip().lower()
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

def save_and_reload(config):
    save_config(config)
    saved = load_config() or {}
    if not isinstance(saved, dict): raise ValueError("saved config is invalid")
    return saved

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
        models.setdefault(model_id, {})
    elif isinstance(existing, list):
        models = list(existing)
        if not any(model_entry_id(item) == model_id for item in models): models.append(model_id)
    else:
        models = [model_id]
    provider["models"] = models

def remove_provider_model(provider, model_id):
    existing = provider.get("models")
    if isinstance(existing, dict): provider["models"] = {key: value for key, value in existing.items() if key != model_id}
    elif isinstance(existing, list): provider["models"] = [item for item in existing if model_entry_id(item) != model_id]
    else: provider["models"] = []

def snapshot_models(config):
    snapshot = read_snapshot(config)
    return [snapshot["primary"]] + snapshot["fallbacks"] + snapshot["configuredModels"]

def provider_model_referenced(config, model):
    return any(same_provider_model(candidate, model) for candidate in snapshot_models(config))

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
    entries = []
    seen = set()
    for value in get_fallback_chain(config) or []:
        if not isinstance(value, dict): continue
        identity = (
            str(value.get("provider") or "").strip().lower(),
            str(value.get("model") or "").strip().lower(),
            normalized_route_base_url(value.get("base_url")),
        )
        if not identity[0] or not identity[1] or identity in seen: continue
        seen.add(identity)
        entries.append(copy.deepcopy(value))
    return entries

def route_matches_model(route, model):
    if not isinstance(route, dict): return False
    return (
        str(route.get("provider") or "").strip().lower() == model["providerKey"].strip().lower()
        and str(route.get("model") or route.get("default") or "").strip().lower() == model["id"].strip().lower()
        and normalized_route_base_url(route.get("base_url")) == route_identity(model)[2]
    )

def write_fallback_routes(config, entries):
    if entries: config["fallback_providers"] = entries
    else: config.pop("fallback_providers", None)
    config.pop("fallback_model", None)

def apply_fallback(config, model):
    entries = raw_fallback_routes(config)
    if not any(route_matches_model(entry, model) for entry in entries): entries.append(fallback_entry(model))
    write_fallback_routes(config, entries)

def remove_fallback(config, model):
    write_fallback_routes(config, [entry for entry in raw_fallback_routes(config) if not route_matches_model(entry, model)])

def remove_runtime_fallbacks(config, model):
    retained = []
    for entry in raw_fallback_routes(config):
        try: candidate = model_from_route(config, entry)
        except (TypeError, ValueError): candidate = None
        if not same_runtime_deployment(candidate, model): retained.append(entry)
    write_fallback_routes(config, retained)

def is_fallback(snapshot, model):
    return any(same_route(item, model) for item in snapshot["fallbacks"])

def expect_role(saved, purpose, model):
    snapshot = read_snapshot(saved)
    if purpose == "primary" and not same_route(snapshot["primary"], model): raise ValueError("primary was not saved")
    if purpose == "fallback" and not is_fallback(snapshot, model): raise ValueError("fallback was not saved")
    if purpose == "idle" and (same_route(snapshot["primary"], model) or is_fallback(snapshot, model)): raise ValueError("idle role was not saved")
    return snapshot

def execute(action):
    action = as_dict(action, "action")
    kind = text(action.get("type"), "type")
    if kind == "prepareCredentialEnvelope": return {"credentialEnvelope": prepare_credential_envelope()}
    credential = decrypt_credential(action.get("credentialEnvelope")) if kind in ("probe", "connectivityProbe", "add") else None
    config = load_config() or {}
    if not isinstance(config, dict): raise ValueError("Hermes config must be an object")
    if kind == "read": return {"snapshot": read_snapshot(config)}
    if kind == "probe":
        result = probe_api_models(credential, text(action.get("baseUrl"), "baseUrl"), timeout=90, mode=api_mode(action.get("apiMode") or "chat_completions", "apiMode"))
        models = probed_model_ids(result)
        snapshot = read_snapshot(config)
        snapshot["probedModels"] = models
        snapshot["probeSucceeded"] = isinstance(result, dict) and isinstance(result.get("models"), list)
        return {"snapshot": snapshot}
    if kind == "connectivityProbe":
        model = normalized_model(action.get("model"))
        return {"connection": probe_model_connection(credential, model)}
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
            providers = config.get("providers") if isinstance(config.get("providers"), dict) else {}
            provider = dict(providers.get(model["providerKey"]) if isinstance(providers.get(model["providerKey"]), dict) else {})
            for alias in ("display_name", "base_url", "url", "api_mode", "api_key", "api_key_env"):
                provider.pop(alias, None)
            provider.update({"name": model["providerName"], "api": model["baseUrl"], "key_env": model["keyEnv"], "transport": TRANSPORTS[model["apiMode"]]})
            add_provider_model(provider, model["id"])
            providers[model["providerKey"]] = provider
            config["providers"] = providers
            saved_models = configured_models(config)
            saved_models[:] = [item for item in saved_models if not same_route(item, model)] + [model]
            if purpose == "primary":
                apply_primary(config, model)
                remove_runtime_fallbacks(config, model)
            elif purpose == "fallback": apply_fallback(config, model)
            else: remove_fallback(config, model)
            save_config(config)
            saved = load_config() or {}
            if not isinstance(saved, dict): raise ValueError("saved config is invalid")
            return {"snapshot": expect_role(saved, purpose, model)}
        except Exception:
            try: save_config(original_config)
            except Exception: pass
            restore_credential(model["keyEnv"], previous_credential)
            raise
    if kind == "assign":
        route_base_url = text(action.get("routeBaseUrl"), "routeBaseUrl", required=False) if "routeBaseUrl" in action else None
        model = find_configured(config, text(action.get("providerKey"), "providerKey"), text(action.get("modelId"), "modelId"), text(action.get("baseUrl"), "baseUrl", required=False), route_base_url)
        purpose = text(action.get("purpose"), "purpose")
        before = read_snapshot(config)
        if purpose == "fallback" and same_runtime_deployment(before["primary"], model): raise ValueError("role conflict")
        if purpose == "idle" and same_route(before["primary"], model): raise ValueError("cannot idle primary")
        if purpose == "primary":
            apply_primary(config, model)
            remove_runtime_fallbacks(config, model)
        elif purpose == "fallback": apply_fallback(config, model)
        elif purpose == "idle":
            if is_fallback(before, model): remove_fallback(config, model)
            else: return {"snapshot": expect_role(config, purpose, model)}
        elif purpose != "idle": raise ValueError("purpose is invalid")
        saved = save_and_reload(config)
        return {"snapshot": expect_role(saved, purpose, model)}
    if kind == "removeFallback":
        route_base_url = text(action.get("routeBaseUrl"), "routeBaseUrl", required=False) if "routeBaseUrl" in action else None
        model = find_configured(config, text(action.get("providerKey"), "providerKey"), text(action.get("modelId"), "modelId"), text(action.get("baseUrl"), "baseUrl", required=False), route_base_url)
        remove_fallback(config, model)
        saved = save_and_reload(config)
        if is_fallback(read_snapshot(saved), model): raise ValueError("fallback was not removed")
        return {"snapshot": read_snapshot(saved)}
    if kind == "remove":
        original_config = copy.deepcopy(config)
        route_base_url = text(action.get("routeBaseUrl"), "routeBaseUrl", required=False) if "routeBaseUrl" in action else None
        model = find_configured(config, text(action.get("providerKey"), "providerKey"), text(action.get("modelId"), "modelId"), text(action.get("baseUrl"), "baseUrl", required=False), route_base_url)
        before = read_snapshot(config)
        if same_route(before["primary"], model): raise ValueError("cannot remove primary")
        remove_fallback(config, model)
        saved_models = configured_models(config)
        saved_models[:] = [item for item in saved_models if not same_route(item, model)]
        providers = config.get("providers") if isinstance(config.get("providers"), dict) else {}
        provider = providers.get(model["providerKey"]) if isinstance(providers.get(model["providerKey"]), dict) else None
        remove_key = model["keyEnv"]
        if provider is not None:
            provider = dict(provider)
            remove_key = model["keyEnv"] or text(provider.get("key_env") or provider.get("api_key_env"), "keyEnv", required=False) or custom_endpoint_key_env(model["providerKey"])
            if not provider_model_referenced(config, model): remove_provider_model(provider, model["id"])
            if not provider.get("models") and not provider_referenced(config, model["providerKey"]):
                providers.pop(model["providerKey"], None)
            else:
                providers[model["providerKey"]] = provider
        config["providers"] = providers
        previous_credential = current_credential(remove_key) if remove_key else None
        try:
            saved = save_and_reload(config)
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

try:
    payload = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
    result = execute(payload)
    print(START)
    print(json.dumps({"ok": True, **result}, ensure_ascii=False))
    print(END)
except Exception:
    fail()
`;

export function buildHermesModelConfigCommand(action: HermesModelConfigAction): string {
  const payload = encodeBase64(JSON.stringify(action));
  return [
    "set -e",
    'HERMES_ROOT="${HERMES_HOME:-$HOME/.hermes}"',
    "export HERMES_ROOT",
    'HERMES_PYTHON="$HERMES_ROOT/hermes-agent/venv/bin/python"',
    'if [ ! -x "$HERMES_PYTHON" ]; then HERMES_PYTHON="python3"; fi',
    `"$HERMES_PYTHON" - "${payload}" <<'PY'`,
    PYTHON_HELPER,
    "PY",
  ].join("\n");
}
