use crate::common::gen_rand_str_with;

use anyhow::{Context, Result, anyhow};
use log::warn;
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::fs::read_to_string;
use tokio::sync::{OnceCell, RwLock};

const CONFIG_DAT: &str = "config.dat";
static STATE_ROOT: OnceLock<PathBuf> = OnceLock::new();

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
struct Config {
    #[serde(default)]
    register: Option<RegisterInfo>,

    #[serde(default)]
    url: Option<Url>,
}

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct RegisterInfo {
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub register_code: String,
    #[serde(default)]
    pub register_value: String,
    #[serde(default)]
    pub machine_id: String,
    #[serde(default)]
    pub private_key: String,
    #[serde(default)]
    pub instance_id: String,
}

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
struct Url {
    #[serde(default)]
    pub invoke_url: Option<String>,
    #[serde(default)]
    pub ws_url: Option<String>,
    #[serde(default)]
    pub forward_url: Option<String>,
}

pub fn initialize_state_root(path: impl AsRef<Path>) -> Result<()> {
    let path = path.as_ref();
    if !path.is_absolute() {
        return Err(anyhow!("TAT state root must be absolute"));
    }
    std::fs::create_dir_all(path).context("create TAT state root")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .context("protect TAT state root")?;
    }
    let canonical = path.canonicalize().context("canonicalize TAT state root")?;
    if let Some(existing) = STATE_ROOT.get() {
        if existing != &canonical {
            return Err(anyhow!("TAT state root is already initialized"));
        }
        return Ok(());
    }
    STATE_ROOT
        .set(canonical)
        .map_err(|_| anyhow!("TAT state root initialization raced"))
}

fn config_path() -> Result<PathBuf> {
    let root = STATE_ROOT
        .get()
        .ok_or_else(|| anyhow!("TAT state root is not initialized"))?;
    Ok(root.join(CONFIG_DAT))
}

pub fn state_root() -> Result<&'static Path> {
    STATE_ROOT
        .get()
        .map(PathBuf::as_path)
        .ok_or_else(|| anyhow!("TAT state root is not initialized"))
}

async fn load_config() -> Result<&'static RwLock<Config>> {
    static ONCE: OnceCell<RwLock<Config>> = OnceCell::const_new();
    let path = config_path()?;
    Ok(ONCE
        .get_or_init(|| async {
            let config = read_to_string(&path)
                .await
                .context("read config file failed")
                .and_then(|value| {
                    serde_json::from_str::<Config>(&value).context("serde_json failed")
                })
                .map_err(|error| warn!("load config: {error:#}"))
                .unwrap_or_default();
            RwLock::new(config)
        })
        .await)
}

pub async fn get_invoke_url() -> Option<String> {
    let config = load_config().await.ok()?;
    config.read().await.url.as_ref()?.invoke_url.clone()
}

pub async fn get_ws_url() -> Option<String> {
    let config = load_config().await.ok()?;
    config.read().await.url.as_ref()?.ws_url.clone()
}

pub async fn get_forward_url() -> Option<String> {
    let config = load_config().await.ok()?;
    config.read().await.url.as_ref()?.forward_url.clone()
}

pub async fn get_register_info() -> Option<RegisterInfo> {
    let config = load_config().await.ok()?;
    config.read().await.register.clone()
}

pub async fn save_register_info(info: RegisterInfo) -> Result<()> {
    let config = load_config().await?;
    let mut value = config.write().await;
    value.register = Some(info);
    save_config(&value).await
}

async fn save_config(config: &Config) -> Result<()> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context("create config parent")?;
    }
    let json = serde_json::to_string(config).context("serde")?;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("TAT config path has no parent"))?;
    let temp_path = parent.join(format!(".config-{}.tmp", gen_rand_str_with(16)));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .context("create temporary TAT config")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .context("protect temporary TAT config")?;
        }
        file.write_all(json.as_bytes())
            .context("write temporary TAT config")?;
        file.sync_all().context("sync temporary TAT config")?;
        drop(file);
        std::fs::rename(&temp_path, &path).context("commit TAT config")?;
        let directory = std::fs::File::open(parent).context("open TAT state directory")?;
        directory.sync_all().context("sync TAT state directory")
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}
