use std::env;
use std::fs;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use serde::Serialize;
use sha2::{Digest, Sha256};

const SIGNATURE_DOMAIN: &str = "cloudagent-agent-loader:v1\n";

#[derive(Serialize)]
struct SignatureEnvelope {
    key_id: String,
    alg: String,
    sha256: String,
    signature: String,
}

fn main() {
    if let Err(err) = run() {
        eprintln!("cloudagent-agent-sign: {err:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args(env::args().skip(1).collect())?;
    let artifact = fs::read(&args.artifact)
        .with_context(|| format!("read artifact {}", args.artifact.display()))?;
    let sha256 = hex_sha256(&artifact);
    let seed = load_seed(args.seed_b64, args.seed_file)?;
    let signing_key = SigningKey::from_bytes(&seed);
    let message = format!("{SIGNATURE_DOMAIN}sha256:{sha256}\n");
    let signature = signing_key.sign(message.as_bytes());
    let envelope = SignatureEnvelope {
        key_id: args.key_id,
        alg: "ed25519".to_string(),
        sha256,
        signature: base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
    };
    let raw = serde_json::to_vec_pretty(&envelope)?;
    fs::write(&args.output, raw).with_context(|| format!("write {}", args.output.display()))?;
    println!(
        "{}",
        base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().to_bytes())
    );
    Ok(())
}

struct Args {
    key_id: String,
    artifact: PathBuf,
    output: PathBuf,
    seed_b64: String,
    seed_file: PathBuf,
}

fn parse_args(args: Vec<String>) -> Result<Args> {
    let mut key_id = String::new();
    let mut artifact = PathBuf::new();
    let mut output = PathBuf::new();
    let mut seed_b64 = String::new();
    let mut seed_file = PathBuf::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--key-id" => {
                i += 1;
                key_id = required_value(&args, i, "--key-id")?;
            }
            "--artifact" => {
                i += 1;
                artifact = PathBuf::from(required_value(&args, i, "--artifact")?);
            }
            "--output" => {
                i += 1;
                output = PathBuf::from(required_value(&args, i, "--output")?);
            }
            "--seed-b64" => {
                i += 1;
                seed_b64 = required_value(&args, i, "--seed-b64")?;
            }
            "--seed-file" => {
                i += 1;
                seed_file = PathBuf::from(required_value(&args, i, "--seed-file")?);
            }
            other => bail!("unknown argument {other}"),
        }
        i += 1;
    }
    if key_id.is_empty() {
        bail!("--key-id is required");
    }
    if artifact.as_os_str().is_empty() {
        bail!("--artifact is required");
    }
    if output.as_os_str().is_empty() {
        bail!("--output is required");
    }
    Ok(Args {
        key_id,
        artifact,
        output,
        seed_b64,
        seed_file,
    })
}

fn required_value(args: &[String], index: usize, flag: &str) -> Result<String> {
    args.get(index)
        .filter(|value| !value.is_empty())
        .cloned()
        .with_context(|| format!("{flag} requires a value"))
}

fn load_seed(seed_b64: String, seed_file: PathBuf) -> Result<[u8; 32]> {
    let encoded = if !seed_b64.trim().is_empty() {
        seed_b64
    } else if !seed_file.as_os_str().is_empty() {
        fs::read_to_string(&seed_file).with_context(|| format!("read {}", seed_file.display()))?
    } else {
        env::var("CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64")
            .context("CLOUDAGENT_AGENT_RELEASE_ED25519_SEED_B64 or --seed-file is required")?
    };
    let raw = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .context("decode ed25519 seed")?;
    raw.try_into().map_err(|bytes: Vec<u8>| {
        anyhow::anyhow!("ed25519 seed has {} bytes, want 32", bytes.len())
    })
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
