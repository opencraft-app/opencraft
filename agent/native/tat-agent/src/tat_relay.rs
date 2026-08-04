use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures::{SinkExt, StreamExt};
use rand::{Rng, distributions::Alphanumeric, thread_rng};
use rsa::{
    RsaPrivateKey, pkcs1::DecodeRsaPrivateKey, pkcs1v15::Pkcs1v15Sign, pkcs8::DecodePrivateKey,
};
use serde::Deserialize;
use sha1::{Digest, Sha1};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::http::{HeaderMap, HeaderValue};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use tokio_tungstenite::{accept_async, connect_async};

const DEFAULT_RELAY_ADDR: &str = "127.0.0.1:17632";
const TAT_AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct RelayAuth {
    pub region: String,
    pub machine_id: String,
    pub instance_id: String,
    pub private_key: String,
}

#[derive(Clone, Copy)]
pub struct HeaderProfile<'a> {
    pub tat_version: &'a str,
    pub kernel_name: &'a str,
    pub kernel_version: &'a str,
    pub os_version: &'a str,
    pub cpu_arch: &'a str,
    pub uptime_secs: u64,
    pub pid: u32,
}

impl Default for HeaderProfile<'_> {
    fn default() -> Self {
        Self {
            tat_version: TAT_AGENT_VERSION,
            kernel_name: "Linux",
            kernel_version: "browser-relay",
            os_version: "browser-relay",
            cpu_arch: std::env::consts::ARCH,
            uptime_secs: 0,
            pid: std::process::id(),
        }
    }
}

#[derive(Deserialize)]
struct RelayAuthEnvelope {
    #[serde(rename = "type")]
    message_type: String,
    #[serde(flatten)]
    auth: RelayAuth,
}

pub fn default_addr() -> &'static str {
    DEFAULT_RELAY_ADDR
}

pub fn parse_relay_auth(raw: &str) -> Result<RelayAuth> {
    let envelope: RelayAuthEnvelope = serde_json::from_str(raw).context("parse relay auth")?;
    if envelope.message_type != "tat_relay_auth" {
        bail!("first relay message must be tat_relay_auth");
    }
    if envelope.auth.region.trim().is_empty()
        || envelope.auth.machine_id.trim().is_empty()
        || envelope.auth.instance_id.trim().is_empty()
        || envelope.auth.private_key.trim().is_empty()
    {
        bail!("relay auth missing region, machine_id, instance_id, or private_key");
    }
    Ok(envelope.auth)
}

pub fn build_tat_headers(auth: &RelayAuth) -> Result<HeaderMap> {
    let random_key = random_key();
    let timestamp = now_secs();
    build_tat_headers_with(
        &auth.machine_id,
        &auth.instance_id,
        &auth.private_key,
        &random_key,
        timestamp,
        HeaderProfile::default(),
    )
}

pub fn build_tat_headers_with(
    machine_id: &str,
    instance_id: &str,
    private_key_pem: &str,
    random_key: &str,
    timestamp: u64,
    profile: HeaderProfile<'_>,
) -> Result<HeaderMap> {
    let private_key = decode_private_key(private_key_pem)?;
    let data = format!("{machine_id}{instance_id}{random_key}{timestamp}");
    let digest = Sha1::digest(data.as_bytes());
    let signature = private_key
        .sign(Pkcs1v15Sign::new::<Sha1>(), &digest)
        .context("sign TAT websocket headers")?;

    let mut headers = HeaderMap::new();
    insert_header(&mut headers, "Tat-Version", profile.tat_version)?;
    insert_header(&mut headers, "Tat-Pid", &profile.pid.to_string())?;
    insert_header(&mut headers, "Tat-KernelName", profile.kernel_name)?;
    insert_header(&mut headers, "Tat-KernelVersion", profile.kernel_version)?;
    insert_header(&mut headers, "Tat-OSVersion", profile.os_version)?;
    insert_header(&mut headers, "Tat-CPUArch", profile.cpu_arch)?;
    insert_header(
        &mut headers,
        "Tat-UptimeSecs",
        &profile.uptime_secs.to_string(),
    )?;
    insert_header(&mut headers, "MachineId", machine_id)?;
    insert_header(&mut headers, "InstanceId", instance_id)?;
    insert_header(&mut headers, "RandomKey", random_key)?;
    insert_header(&mut headers, "Timestamp", &timestamp.to_string())?;
    insert_header(&mut headers, "Signature", &STANDARD.encode(signature))?;
    Ok(headers)
}

pub async fn run(addr: &str) -> Result<()> {
    let listener = TcpListener::bind(addr).await?;
    eprintln!("LightVela TAT relay listening on ws://{addr}/");
    loop {
        let (stream, _) = listener.accept().await?;
        tokio::spawn(async move {
            if let Err(err) = handle_client(stream).await {
                eprintln!("LightVela TAT relay connection failed: {err:#}");
            }
        });
    }
}

async fn handle_client(stream: TcpStream) -> Result<()> {
    let local_ws = accept_async(stream)
        .await
        .context("accept local websocket")?;
    let (mut local_write, mut local_read) = local_ws.split();
    let first = local_read
        .next()
        .await
        .context("local websocket closed before auth")?
        .context("read relay auth")?;
    let Message::Text(auth_text) = first else {
        bail!("first relay message must be text auth");
    };
    let auth = parse_relay_auth(&auth_text)?;
    let mut request = tat_ws_url(&auth.region)
        .into_client_request()
        .context("build TAT websocket request")?;
    request.headers_mut().extend(build_tat_headers(&auth)?);

    let (tat_ws, _) = connect_async(request)
        .await
        .context("connect TAT websocket")?;
    let (mut tat_write, mut tat_read) = tat_ws.split();
    local_write
        .send(Message::Text(r#"{"type":"tat_relay_ready"}"#.into()))
        .await
        .context("send relay ready")?;

    loop {
        tokio::select! {
            local_msg = local_read.next() => {
                let Some(local_msg) = local_msg else { break };
                let local_msg = local_msg.context("read local websocket")?;
                let is_close = local_msg.is_close();
                tat_write.send(local_msg).await.context("forward local message to TAT")?;
                if is_close { break; }
            }
            tat_msg = tat_read.next() => {
                let Some(tat_msg) = tat_msg else { break };
                let tat_msg = tat_msg.context("read TAT websocket")?;
                let is_close = tat_msg.is_close();
                local_write.send(tat_msg).await.context("forward TAT message to local websocket")?;
                if is_close { break; }
            }
        }
    }
    Ok(())
}

fn tat_ws_url(region: &str) -> String {
    format!("wss://{}.notify.tat-tc.tencent.cn:8186/ws", region.trim())
}

fn decode_private_key(private_key_pem: &str) -> Result<RsaPrivateKey> {
    RsaPrivateKey::from_pkcs1_pem(private_key_pem)
        .or_else(|_| RsaPrivateKey::from_pkcs8_pem(private_key_pem))
        .context("decode relay private key")
}

fn insert_header(headers: &mut HeaderMap, key: &'static str, value: &str) -> Result<()> {
    headers.insert(key, HeaderValue::from_str(value)?);
    Ok(())
}

fn random_key() -> String {
    thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time before unix epoch")
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::{
        RsaPrivateKey,
        pkcs1::{EncodeRsaPrivateKey, LineEnding},
    };

    #[test]
    fn parse_relay_auth_accepts_snake_case_fields() {
        let auth = parse_relay_auth(
            r#"{
                "type":"tat_relay_auth",
                "region":"ap-beijing",
                "machine_id":"mid",
                "instance_id":"ins",
                "private_key":"pem"
            }"#,
        )
        .unwrap();

        assert_eq!(
            auth,
            RelayAuth {
                region: "ap-beijing".to_owned(),
                machine_id: "mid".to_owned(),
                instance_id: "ins".to_owned(),
                private_key: "pem".to_owned(),
            }
        );
    }

    #[test]
    fn relay_headers_include_tat_identity_and_signature() {
        let private_key = RsaPrivateKey::new(&mut rand::thread_rng(), 2048)
            .unwrap()
            .to_pkcs1_pem(LineEnding::LF)
            .unwrap()
            .to_string();
        let headers = build_tat_headers_with(
            "mid",
            "ins",
            &private_key,
            "random",
            123,
            HeaderProfile::default(),
        )
        .unwrap();

        assert_eq!(headers.get("MachineId").unwrap(), "mid");
        assert_eq!(headers.get("InstanceId").unwrap(), "ins");
        assert_eq!(headers.get("RandomKey").unwrap(), "random");
        assert_eq!(headers.get("Timestamp").unwrap(), "123");
        assert!(headers.get("Signature").is_some());
        assert_eq!(headers.get("Tat-KernelName").unwrap(), "Linux");
    }
}
