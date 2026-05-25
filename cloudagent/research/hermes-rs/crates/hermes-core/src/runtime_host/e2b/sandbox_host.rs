use serde::Deserialize;
use serde_json::Value;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SandboxHostTransport {
    Http,
    Cli,
}

#[derive(Debug, Deserialize)]
struct NativeHostResponse {
    ok: bool,
    result: Option<Value>,
    error: Option<NativeHostError>,
}

#[derive(Debug, Deserialize)]
struct NativeHostError {
    code: String,
    message: String,
}

pub(super) fn sandbox_host_url() -> Option<String> {
    first_non_empty_env(&["HERMES_SANDBOX_HOST_URL", "SANDBOX_HOST_URL"])
}

pub(super) fn sandbox_host_sha256() -> Option<String> {
    first_non_empty_env(&["HERMES_SANDBOX_HOST_SHA256", "SANDBOX_HOST_SHA256"])
}

pub(super) fn sandbox_host_addr() -> String {
    first_non_empty_env(&["HERMES_SANDBOX_HOST_ADDR", "SANDBOX_HOST_ADDR"])
        .unwrap_or_else(|| "0.0.0.0:19091".to_string())
}

pub(super) fn sandbox_host_port() -> Result<u16> {
    let addr = sandbox_host_addr();
    parse_host_port(&addr).ok_or_else(|| Error::MissingConfig {
        key: format!("valid HERMES_SANDBOX_HOST_ADDR / SANDBOX_HOST_ADDR port, got '{addr}'"),
    })
}

pub(super) fn sandbox_host_bin() -> String {
    first_non_empty_env(&["HERMES_SANDBOX_HOST_BIN", "SANDBOX_HOST_BIN"])
        .unwrap_or_else(|| "/tmp/cloudagent-sandbox-host".to_string())
}

pub(super) fn sandbox_host_transport() -> SandboxHostTransport {
    match first_non_empty_env(&["HERMES_SANDBOX_HOST_TRANSPORT", "SANDBOX_HOST_TRANSPORT"])
        .as_deref()
    {
        Some("http") | Some("HTTP") => SandboxHostTransport::Http,
        _ => SandboxHostTransport::Cli,
    }
}

pub(super) fn sandbox_host_cli_fallback_enabled() -> bool {
    matches!(
        first_non_empty_env(&[
            "HERMES_SANDBOX_HOST_ALLOW_CLI_FALLBACK",
            "SANDBOX_HOST_ALLOW_CLI_FALLBACK",
        ])
        .as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}

pub(super) fn parse_host_port(addr: &str) -> Option<u16> {
    if let Ok(socket) = addr.parse::<std::net::SocketAddr>() {
        return Some(socket.port());
    }
    addr.rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
}

pub(super) fn sandbox_host_probe_addr(addr: &str) -> String {
    if let Ok(socket) = addr.parse::<std::net::SocketAddr>() {
        if socket.ip().is_unspecified() {
            return format!("127.0.0.1:{}", socket.port());
        }
        return addr.to_string();
    }
    let Some((host, port)) = addr.rsplit_once(':') else {
        return addr.to_string();
    };
    match host.trim_matches(['[', ']']) {
        "0.0.0.0" | "::" => format!("127.0.0.1:{port}"),
        _ => addr.to_string(),
    }
}

fn first_non_empty_env(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

pub(super) fn sidecar_timeline(event: &str, fields: &[(&str, String)]) {
    let mut parts = vec![format!("timeline source=hermes_sidecar event={event}")];
    for (key, value) in fields {
        let encoded = serde_json::to_string(value.as_str()).unwrap_or_else(|_| "\"\"".to_string());
        parts.push(format!("{key}={encoded}"));
    }
    eprintln!("{}", parts.join(" "));
}

pub(super) fn sandbox_host_bootstrap_command(
    url: &str,
    sha256: Option<&str>,
    bin: &str,
    addr: &str,
    probe_addr: &str,
    workspace_root: &str,
) -> String {
    let sha_check = match sha256 {
        Some(value) => format!(
            r#"if command -v sha256sum >/dev/null 2>&1; then
  printf '%s  %s\n' {sha} {bin} | sha256sum -c -
elif command -v python3 >/dev/null 2>&1; then
  python3 - {sha} {bin} <<'PY'
import hashlib, pathlib, sys
expected = sys.argv[1].lower()
actual = hashlib.sha256(pathlib.Path(sys.argv[2]).read_bytes()).hexdigest()
if actual != expected:
    print(f"sha256 mismatch: expected {{expected}}, got {{actual}}", file=sys.stderr)
    raise SystemExit(1)
PY
else
  printf 'missing sha256 verifier\n' >&2
  exit 1
fi"#,
            sha = shell_quote(value),
            bin = shell_quote(bin)
        ),
        None => "true".to_string(),
    };
    format!(
        r#"set -e
bin={bin}
url={url}
addr={addr}
probe_addr={probe_addr}
workspace={workspace}
log=/tmp/cloudagent-sandbox-host.log
printf 'sandbox-host bootstrap: bin=%s addr=%s workspace=%s\n' "$bin" "$addr" "$workspace" >&2
if [ ! -x "$bin" ]; then
  tmp="${{bin}}.download"
  rm -f "$tmp"
  printf 'sandbox-host bootstrap: downloading %s\n' "$url" >&2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$tmp"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$tmp" "$url"
  else
    python3 - "$url" "$tmp" <<'PY'
import sys, urllib.request
urllib.request.urlretrieve(sys.argv[1], sys.argv[2])
PY
  fi
  chmod +x "$tmp"
  mv "$tmp" "$bin"
fi
{sha_check}
if "$bin" call --url "http://$probe_addr" --method host.info --json '{{}}' >/dev/null 2>&1; then
  exit 0
fi
printf 'sandbox-host bootstrap: starting daemon\n' >&2
if command -v nohup >/dev/null 2>&1; then
  nohup "$bin" serve --addr "$addr" --workspace "$workspace" >"$log" 2>&1 &
else
  "$bin" serve --addr "$addr" --workspace "$workspace" >"$log" 2>&1 &
fi
set +e
i=0
while [ "$i" -lt 50 ]; do
  if "$bin" call --url "http://$probe_addr" --method host.info --json '{{}}' >/dev/null 2>&1; then
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done
printf 'sandbox-host failed to become ready; log follows\n' >&2
tail -200 "$log" >&2 || true
exit 1
"#,
        bin = shell_quote(bin),
        url = shell_quote(url),
        addr = shell_quote(addr),
        probe_addr = shell_quote(probe_addr),
        workspace = shell_quote(workspace_root),
        sha_check = sha_check
    )
}

pub(super) fn parse_native_host_response(method: &str, stdout: &str) -> Result<Value> {
    let response: NativeHostResponse = serde_json::from_str(stdout.trim()).map_err(|error| {
        Error::ParseResponse(format!(
            "sandbox-host {method} returned invalid JSON: {error}: {stdout}"
        ))
    })?;
    if response.ok {
        return Ok(response.result.unwrap_or(Value::Null));
    }
    let message = response
        .error
        .map(|error| format!("{}: {}", error.code, error.message))
        .unwrap_or_else(|| "unknown sandbox-host error".to_string());
    Err(Error::Agent(format!(
        "sandbox-host {method} failed: {message}"
    )))
}

pub(super) fn shell_quote(value: &str) -> String {
    let escaped = value.replace('\'', "'\"'\"'");
    format!("'{}'", escaped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_command_verifies_sha256() {
        let command = sandbox_host_bootstrap_command(
            "https://example.com/host",
            Some("abc123"),
            "/tmp/host",
            "0.0.0.0:19091",
            "127.0.0.1:19091",
            "/workspace",
        );
        assert!(command.contains("sha256sum -c"));
        assert!(command.contains("abc123"));
    }

    #[test]
    fn cli_fallback_command_preserves_method_and_payload() {
        let command = format!(
            "{} call --url {} --method {} --json {}",
            shell_quote("/tmp/host"),
            shell_quote("http://127.0.0.1:19091"),
            shell_quote("file.read"),
            shell_quote("{\"path\":\"a.txt\"}")
        );
        assert!(command.contains("'file.read'"));
        assert!(command.contains("'{\"path\":\"a.txt\"}'"));
    }

    #[test]
    fn env_resolution_prefers_explicit_runtime_settings() {
        assert_eq!(parse_host_port("127.0.0.1:19091"), Some(19091));
        assert_eq!(parse_host_port("[::1]:19091"), Some(19091));
        assert_eq!(parse_host_port("bad"), None);
    }

    #[test]
    fn probe_addr_maps_unspecified_bind_addr_to_loopback() {
        assert_eq!(sandbox_host_probe_addr("0.0.0.0:19091"), "127.0.0.1:19091");
        assert_eq!(sandbox_host_probe_addr("[::]:19091"), "127.0.0.1:19091");
    }
}
