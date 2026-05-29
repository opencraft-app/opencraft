use std::collections::HashMap;
use std::env;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const DEFAULT_KEYS_PATH: &str = "/etc/cloudagent/agent-loader-keys.json";
const SIGNATURE_ALG: &str = "ed25519";
const SIGNATURE_DOMAIN: &str = "cloudagent-agent-loader:v1\n";

#[derive(Debug)]
struct Options {
    url: String,
    output: PathBuf,
    sha256: Option<String>,
    sig_url: String,
    key_id: String,
    keys_path: PathBuf,
    exec_args: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct SignatureEnvelope {
    key_id: String,
    alg: String,
    sha256: String,
    signature: String,
}

#[derive(Debug, Deserialize)]
struct TrustedKeys {
    keys: HashMap<String, String>,
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        eprintln!("cloudagent-agent-loader: {err:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let opts = parse_args(env::args().skip(1).collect())?;
    let raw_sig = fetch(&opts.sig_url, Duration::from_secs(30))
        .await
        .with_context(|| format!("download signature {}", redact_url(&opts.sig_url)))?;
    let envelope: SignatureEnvelope =
        serde_json::from_slice(&raw_sig).context("parse signature envelope")?;
    let expected_sha = verify_signature(
        &envelope,
        opts.sha256.as_deref(),
        &opts.key_id,
        &opts.keys_path,
    )?;

    let artifact = fetch(&opts.url, Duration::from_secs(180))
        .await
        .with_context(|| format!("download artifact {}", redact_url(&opts.url)))?;
    let actual_sha = hex_sha256(&artifact);
    if actual_sha != expected_sha {
        bail!(
            "artifact sha256 mismatch: got {} want {}",
            actual_sha,
            expected_sha
        );
    }

    if let Some(parent) = opts.output.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    fs::write(&opts.output, artifact)
        .with_context(|| format!("write {}", opts.output.display()))?;
    let mut perms = fs::metadata(&opts.output)
        .with_context(|| format!("stat {}", opts.output.display()))?
        .permissions();
    perms.set_mode(0o700);
    fs::set_permissions(&opts.output, perms)
        .with_context(|| format!("chmod {}", opts.output.display()))?;

    let err = Command::new(&opts.output).args(&opts.exec_args).exec();
    Err(err).with_context(|| format!("exec {}", opts.output.display()))
}

fn parse_args(args: Vec<String>) -> Result<Options> {
    let mut url = String::new();
    let mut output = PathBuf::new();
    let mut sha256 = String::new();
    let mut sig_url = String::new();
    let mut key_id = String::new();
    let mut keys_path = PathBuf::from(
        env::var("CLOUDAGENT_AGENT_LOADER_KEYS").unwrap_or_else(|_| DEFAULT_KEYS_PATH.to_string()),
    );
    let mut exec_args = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--" => {
                exec_args.extend(args[i + 1..].iter().cloned());
                break;
            }
            "--url" => {
                i += 1;
                url = required_value(&args, i, "--url")?;
            }
            "--output" => {
                i += 1;
                output = PathBuf::from(required_value(&args, i, "--output")?);
            }
            "--sha256" => {
                i += 1;
                sha256 = required_value(&args, i, "--sha256")?.to_ascii_lowercase();
            }
            "--sig-url" => {
                i += 1;
                sig_url = required_value(&args, i, "--sig-url")?;
            }
            "--key-id" => {
                i += 1;
                key_id = required_value(&args, i, "--key-id")?;
            }
            "--keys" => {
                i += 1;
                keys_path = PathBuf::from(required_value(&args, i, "--keys")?);
            }
            other => bail!("unknown argument {other}"),
        }
        i += 1;
    }
    if url.is_empty() {
        bail!("--url is required");
    }
    if output.as_os_str().is_empty() {
        bail!("--output is required");
    }
    let sha256 = if sha256.is_empty() {
        None
    } else if is_sha256_hex(&sha256) {
        Some(sha256)
    } else {
        bail!("--sha256 must be 64 lowercase hex characters");
    };
    if sig_url.is_empty() {
        bail!("--sig-url is required");
    }
    if key_id.is_empty() {
        bail!("--key-id is required");
    }
    Ok(Options {
        url,
        output,
        sha256,
        sig_url,
        key_id,
        keys_path,
        exec_args,
    })
}

fn required_value(args: &[String], index: usize, flag: &str) -> Result<String> {
    args.get(index)
        .filter(|value| !value.is_empty())
        .cloned()
        .with_context(|| format!("{flag} requires a value"))
}

async fn fetch(url: &str, timeout: Duration) -> Result<Vec<u8>> {
    let client = reqwest::Client::builder().timeout(timeout).build()?;
    let response = client.get(url).send().await?;
    let status = response.status();
    if !status.is_success() {
        bail!("unexpected HTTP status {status}");
    }
    Ok(response.bytes().await?.to_vec())
}

fn verify_signature(
    envelope: &SignatureEnvelope,
    expected_sha: Option<&str>,
    expected_key_id: &str,
    keys_path: &Path,
) -> Result<String> {
    if envelope.alg != SIGNATURE_ALG {
        bail!("unsupported signature alg {}", envelope.alg);
    }
    if envelope.key_id != expected_key_id {
        bail!(
            "signature key_id mismatch: got {} want {}",
            envelope.key_id,
            expected_key_id
        );
    }
    let envelope_sha = envelope.sha256.to_ascii_lowercase();
    if !is_sha256_hex(&envelope_sha) {
        bail!("signature sha256 is invalid");
    }
    if let Some(expected_sha) = expected_sha {
        if envelope_sha != expected_sha {
            bail!(
                "signature sha256 mismatch: got {} want {}",
                envelope.sha256,
                expected_sha
            );
        }
    }
    let public_key = trusted_public_key(keys_path, expected_key_id)?;
    let signature_bytes = base64::engine::general_purpose::STANDARD
        .decode(envelope.signature.trim())
        .context("decode signature")?;
    let signature = Signature::from_slice(&signature_bytes).context("parse ed25519 signature")?;
    let message = format!("{SIGNATURE_DOMAIN}sha256:{envelope_sha}\n");
    public_key
        .verify(message.as_bytes(), &signature)
        .context("signature verification failed")?;
    Ok(envelope_sha)
}

fn trusted_public_key(keys_path: &Path, key_id: &str) -> Result<VerifyingKey> {
    let raw = fs::read(keys_path).with_context(|| format!("read {}", keys_path.display()))?;
    let keys: TrustedKeys = serde_json::from_slice(&raw).context("parse trusted keys")?;
    let encoded = keys
        .keys
        .get(key_id)
        .with_context(|| format!("trusted key {key_id} is not configured"))?;
    let key_bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .with_context(|| format!("decode trusted key {key_id}"))?;
    let key_array: [u8; 32] = key_bytes.try_into().map_err(|bytes: Vec<u8>| {
        anyhow::anyhow!("trusted key {key_id} has {} bytes, want 32", bytes.len())
    })?;
    VerifyingKey::from_bytes(&key_array).with_context(|| format!("parse trusted key {key_id}"))
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push(hex_digit(byte >> 4));
        out.push(hex_digit(byte & 0x0f));
    }
    out
}

fn hex_digit(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        10..=15 => (b'a' + value - 10) as char,
        _ => unreachable!(),
    }
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn redact_url(value: &str) -> String {
    let mut out = value.to_string();
    for key in ["token=", "key=", "secret=", "signature=", "sign=", "q-ak="] {
        let mut search_from = 0;
        while let Some(offset) = out[search_from..].to_ascii_lowercase().find(key) {
            let start = search_from + offset + key.len();
            let end = out[start..]
                .find('&')
                .map(|idx| start + idx)
                .unwrap_or(out.len());
            out.replace_range(start..end, "<redacted>");
            search_from = start + "<redacted>".len();
        }
    }
    out
}
