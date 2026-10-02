use std::{ops::Deref, path::Path, result::Result::Ok, sync::Arc};

use ::config as config_loader;
use anyhow::*;

pub mod config;
pub mod defaults;
pub mod paths;
pub mod secret;

struct ConfigData {
	config: config::Root,
}

#[derive(Clone)]
pub struct Config(Arc<ConfigData>);

impl Config {
	pub async fn load<P: AsRef<Path>>(paths: &[P]) -> Result<Self> {
		let mut settings = config_loader::Config::builder();

		// Start with default values
		settings = settings.add_source(config_loader::Config::try_from(&config::Root::default())?);

		if paths.is_empty() {
			let default_path = paths::system_config_dir();
			if default_path.exists() {
				// Add default config directory if it exists
				settings = add_source(settings, default_path)?;
			}
		} else {
			// Use provided paths
			for path in paths {
				settings = add_source(settings, path)?;
			}
		}

		// Add env source for overrides
		settings = settings.add_source(
			config_loader::Environment::with_prefix("RIVET")
				.try_parsing(true)
				.separator("__")
				.list_separator(",")
				.with_list_parse_key("foundationdb.addresses"),
		);

		// Read config
		let settings = settings.build().context("failed to build config")?;
		let raw_config = settings
			.clone()
			.try_deserialize::<serde_json::Value>()
			.context("failed to inspect merged config")?;
		let mut config_root = settings
			.try_deserialize::<config::Root>()
			.context("failed to deserialize config")?;
		validate_flattened_pubsub(&raw_config, &config_root)?;

		// Validate configuration at load time
		config_root.validate_and_set_defaults()?;

		Ok(Self(Arc::new(ConfigData {
			config: config_root,
		})))
	}

	pub fn from_root(config: config::Root) -> Self {
		Self(Arc::new(ConfigData { config }))
	}
}

/// Serde cannot reliably report an unknown field inside an optional flattened
/// enum: a configured `nats` object that no longer matches the compiled NATS
/// schema can deserialize as `None`, silently selecting the in-process memory
/// driver. Fail closed whenever a pubsub selector was present in the merged
/// input but was not preserved by typed deserialization.
fn validate_flattened_pubsub(raw: &serde_json::Value, root: &config::Root) -> Result<()> {
	let Some(raw) = raw.as_object() else {
		bail!("merged config root must be an object");
	};
	let has_nats = raw.contains_key("nats");
	let has_memory = raw.contains_key("memory");
	if has_nats && has_memory {
		bail!("config must select exactly one pubsub driver, not both nats and memory");
	}
	if has_nats && !matches!(root.pubsub, Some(config::PubSub::Nats(_))) {
		bail!("configured nats pubsub was not accepted by this Engine binary");
	}
	if has_memory && !matches!(root.pubsub, Some(config::PubSub::Memory(_))) {
		bail!("configured memory pubsub was not accepted by this Engine binary");
	}
	Ok(())
}

impl Deref for Config {
	type Target = config::Root;

	fn deref(&self) -> &Self::Target {
		&self.0.config
	}
}

/// Adds a source to the config builder. If the path is a directory, it reads all config files.
/// If it's a file, it adds it directly. If the path doesn't exist, it's silently ignored.
fn add_source<P: AsRef<Path>>(
	mut settings: config_loader::ConfigBuilder<config_loader::builder::DefaultState>,
	path: P,
) -> Result<config_loader::ConfigBuilder<config_loader::builder::DefaultState>> {
	let path = path.as_ref();

	if !path.exists() {
		tracing::debug!(path=%path.display(), "ignoring non-existent config path");

		// Silently ignore non-existent paths
		return Ok(settings);
	}

	if path.is_dir() {
		tracing::debug!(path=%path.display(), "loading config from directory");

		for entry in std::fs::read_dir(path)? {
			let entry = entry?;
			let path = entry.path();
			if path.is_file() {
				if let Some(extension) = path.extension().and_then(std::ffi::OsStr::to_str) {
					if ["json", "json5", "jsonc", "yaml", "yml"].contains(&extension) {
						settings = add_file_source(settings, &path)?;
					}
				}
			}
		}
	} else if path.is_file() {
		tracing::debug!(path=%path.display(), "loading config from file");

		settings = add_file_source(settings, path)?;
	} else {
		bail!(
			"Invalid Rivet config path: {}. Ensure the path exists and is either a directory with config files or a specific config file.",
			path.display()
		);
	}

	Ok(settings)
}

/// Adds a single file source to the config builder.
fn add_file_source<P: AsRef<Path>>(
	settings: config_loader::ConfigBuilder<config_loader::builder::DefaultState>,
	path: P,
) -> Result<config_loader::ConfigBuilder<config_loader::builder::DefaultState>> {
	let path = path.as_ref();
	let content = std::fs::read_to_string(path)
		.with_context(|| format!("failed to read file: {}", path.display()))?;

	let format = match path.extension().and_then(std::ffi::OsStr::to_str) {
		Some("json") => config_loader::FileFormat::Json,
		Some("json5") | Some("jsonc") => {
			// Parse JSON5/JSONC and convert to regular JSON
			let value = match json5::from_str::<serde_json::Value>(&content) {
				Ok(x) => x,
				Err(err) => bail!("failed to parse config file at {}: {err}", path.display()),
			};
			let json = serde_json::to_string(&value)?;
			return Ok(settings.add_source(config_loader::File::from_str(
				&json,
				config_loader::FileFormat::Json,
			)));
		}
		Some("yaml") | Some("yml") => config_loader::FileFormat::Yaml,
		_ => bail!("Unsupported file format: {}", path.display()),
	};

	Ok(settings.add_source(config_loader::File::from_str(&content, format)))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn top_level_nats_survives_default_config_merge() {
		let settings = config_loader::Config::builder()
			.add_source(config_loader::Config::try_from(&config::Root::default()).unwrap())
			.add_source(config_loader::File::from_str(
				r#"{"nats":{"addresses":["nats-0:4222","nats-1:4222"]}}"#,
				config_loader::FileFormat::Json,
			))
			.build()
			.unwrap();
		let raw = settings
			.clone()
			.try_deserialize::<serde_json::Value>()
			.unwrap();
		let root = settings.try_deserialize::<config::Root>().unwrap();
		validate_flattened_pubsub(&raw, &root).unwrap();

		match root.pubsub {
			Some(config::PubSub::Nats(nats)) => {
				assert_eq!(nats.addresses, ["nats-0:4222", "nats-1:4222"]);
			}
			other => panic!("top-level nats did not select the NATS pubsub driver: {other:?}"),
		}
	}

	#[test]
	fn malformed_flattened_nats_fails_closed() {
		let settings = config_loader::Config::builder()
			.add_source(config_loader::Config::try_from(&config::Root::default()).unwrap())
			.add_source(config_loader::File::from_str(
				r#"{"nats":{"addresses":["nats-0:4222"],"unsupported_option":true}}"#,
				config_loader::FileFormat::Json,
			))
			.build()
			.unwrap();
		let raw = settings
			.clone()
			.try_deserialize::<serde_json::Value>()
			.unwrap();
		let root = settings.try_deserialize::<config::Root>().unwrap();

		assert!(root.pubsub.is_none(), "regression precondition changed");
		let error = validate_flattened_pubsub(&raw, &root).unwrap_err();
		assert!(
			error
				.to_string()
				.contains("configured nats pubsub was not accepted")
		);
	}
}
