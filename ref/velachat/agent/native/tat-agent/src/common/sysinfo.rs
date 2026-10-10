#[cfg(not(target_os = "macos"))]
use std::env::consts::OS;
#[cfg(target_os = "macos")]
use std::fs;
use std::sync::LazyLock;
use std::{cmp::min, num::NonZeroUsize, thread::available_parallelism};

use anyhow::{Result, anyhow};
use smbioslib::{DefinedStruct, SystemUuidData, table_load_from_device};
use sysinfo::System;
use tokio::net::UdpSocket;
use url::Url;

use crate::network::urls::get_ws_url;

const MAX_PARALLELISM: usize = 8;
static MACHINE_ID: LazyLock<Result<String>> = LazyLock::new(get_machine_id);

pub async fn local_ip(region: &str) -> Result<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").await?;
    let url = Url::parse(&get_ws_url(Some(region)).await)?;
    let host = url.host().expect("invalid ws url").to_string();
    let port = url.port().unwrap_or(443);
    socket.connect((host, port)).await?;
    let addr = socket.local_addr()?;
    Ok(addr.ip().to_string())
}

fn get_machine_id() -> Result<String> {
    #[cfg(target_os = "macos")]
    if let Some(machine_id) = persisted_macos_machine_id() {
        return Ok(machine_id);
    }

    if let Some(machine_id) = smbios_machine_id() {
        return Ok(machine_id);
    }
    machine_uid::get().map_err(|e| anyhow!("{}", e))
}

#[cfg(target_os = "macos")]
fn persisted_macos_machine_id() -> Option<String> {
    let value = fs::read_to_string("/Library/Application Support/Tencent/TAT/device-id").ok()?;
    let trimmed = value.trim();
    if trimmed.len() >= 12
        && trimmed.len() <= 96
        && trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        Some(trimmed.to_owned())
    } else {
        None
    }
}

fn smbios_machine_id() -> Option<String> {
    let smbios_data = table_load_from_device().ok()?;
    for undefstruct in smbios_data.iter() {
        let DefinedStruct::SystemInformation(info) = undefstruct.defined_struct() else {
            continue;
        };
        if let Some(uuid_data @ SystemUuidData::Uuid(_)) = info.uuid() {
            return Some(uuid_data.to_string());
        }
    }
    None
}

pub fn machine_id() -> Result<&'static str> {
    MACHINE_ID.as_deref().map_err(|e| anyhow!(e))
}

#[cfg(not(target_os = "macos"))]
pub fn kernel_name() -> String {
    let mut os = OS.to_string();
    os.get_mut(0..1).unwrap().make_ascii_uppercase();
    os
}

pub fn kernel_version() -> String {
    System::kernel_version().unwrap_or(String::from("<unknown>"))
}

pub fn os_version() -> String {
    System::long_os_version().unwrap_or(String::from("<unknown>"))
}

pub fn cpu_arch() -> String {
    System::cpu_arch()
}

pub fn hostname() -> Option<String> {
    System::host_name()
}

pub fn uptime_secs() -> u64 {
    System::uptime()
}

pub fn parallelism() -> usize {
    let sys_parallelism = available_parallelism().map_or(1, NonZeroUsize::get);
    min(sys_parallelism, MAX_PARALLELISM)
}
