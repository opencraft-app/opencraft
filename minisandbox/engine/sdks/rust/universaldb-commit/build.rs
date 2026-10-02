use std::{
	fs,
	path::{Path, PathBuf},
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
	let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")?;
	let out_dir = PathBuf::from(std::env::var("OUT_DIR")?);
	let workspace_root = Path::new(&manifest_dir)
		.parent()
		.and_then(|p| p.parent())
		.and_then(|p| p.parent())
		.ok_or("Failed to find workspace root")?;

	let schema_dir = workspace_root
		.join("sdks")
		.join("schemas")
		.join("universaldb-commit");
	println!("cargo:rerun-if-changed={}", schema_dir.display());

	let (highest_version, _) = find_highest_version(&schema_dir)
		.ok_or("universaldb-commit schema directory contains no versioned schemas")?;

	let cfg = vbare_compiler::Config::default();
	vbare_compiler::process_schemas_with_config(&schema_dir, &cfg)?;

	// Append protocol version constant to generated file
	let combined_imports_path = out_dir.join("combined_imports.rs");
	let mut combined = fs::read_to_string(&combined_imports_path)?;
	combined.push_str(&format!(
		"\npub const PROTOCOL_VERSION: u16 = {};\n",
		highest_version
	));
	fs::write(combined_imports_path, combined)?;

	Ok(())
}

fn find_highest_version(schema_dir: &Path) -> Option<(u32, PathBuf)> {
	let mut highest: Option<(u32, PathBuf)> = None;

	for entry in fs::read_dir(schema_dir).unwrap().flatten() {
		if !entry.path().is_dir() {
			let path = entry.path();
			let Some(version) = path
				.file_name()
				.and_then(|name| name.to_str())
				.and_then(|name| name.strip_prefix('v'))
				.and_then(|name| name.strip_suffix(".bare"))
				.and_then(|version| version.parse::<u32>().ok())
			else {
				continue;
			};

			if highest
				.as_ref()
				.is_none_or(|(highest_version, _)| version > *highest_version)
			{
				highest = Some((version, path));
			}
		}
	}

	highest
}
