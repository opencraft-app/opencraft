//! Fixed PVM attachment protocol for a fenced persistent ActorBlockVolume.

use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result, ensure};
use minisandbox_core::{control::CommandSpec, engine::PvmBlockBackend};
use rivet_minisandbox_host::MinisandboxActorIdentity;

const MOUNT_TIMEOUT: Duration = Duration::from_secs(10);
const SETUP_SCRIPT: &str = r#"
PATH=/usr/sbin:/sbin:/usr/bin:/bin
bound=0
for candidate in /sys/bus/platform/devices/virtio-mmio.*; do
	[ -e "$candidate" ] || continue
	[ ! -e "$candidate/driver" ] || continue
	device=${candidate##*/}
	printf '%s' "$device" > /sys/bus/platform/drivers/virtio-mmio/bind
	bound=$((bound + 1))
done
[ "$bound" -eq 1 ] || { echo 'expected exactly one ActorBlockVolume device' >&2; exit 1; }
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
	[ -b /dev/vdb ] && break
	sleep 0.01
done
[ -b /dev/vdb ] || { echo 'ActorBlockVolume device did not bind' >&2; exit 1; }
[ "$(cat /sys/class/block/vdb/ro)" -eq 0 ] || {
	echo 'ActorBlockVolume must be writable' >&2
	exit 1
}
[ "$(cat /sys/class/block/vdb/queue/discard_max_bytes)" -ge 4096 ] || {
	echo 'ActorBlockVolume does not expose discard' >&2
	exit 1
}
mkdir -p /workspace /opt/data
mount -t ext4 -o rw,nosuid,nodev,noatime,lazytime,discard,commit=5 /dev/vdb /workspace
chown 10000:10000 /workspace
mount -o bind /workspace /opt/data
"#;

/// Trusted bridge from Rivet's authoritative actor generation to one fenced
/// ActorBlockVolume writer.
pub trait ActorBlockVolumeProvider: Send + Sync + 'static {
	fn open_writer(
		&self,
		identity: &MinisandboxActorIdentity,
	) -> Result<ActorBlockVolumeAttachment>;
}

/// One initialized sparse ext4 volume plus a hidden host-only readiness block.
pub struct ActorBlockVolumeAttachment {
	/// Guest-visible ext4 capacity; the backend wrapper hides its readiness block.
	pub volume: Box<dyn PvmBlockBackend>,
}

pub(crate) type SharedActorBlockVolumeProvider = Arc<dyn ActorBlockVolumeProvider>;

pub(crate) fn mount(control: &minisandbox_core::control::SandboxControl) -> Result<()> {
	// The script is host-owned and contains no actor-provided interpolation. It
	// binds exactly one previously absent fixed platform device.
	let output = control
		.execute(
			&CommandSpec::new("/bin/sh").args(["-eu", "-c", SETUP_SCRIPT]),
			MOUNT_TIMEOUT,
		)
		.context("mount fixed sparse ext4 ActorBlockVolume")?;
	ensure!(
		output.exit_code == 0,
		"ActorBlockVolume mount protocol failed with exit code {} and {} stderr bytes",
		output.exit_code,
		output.stderr.len()
	);
	Ok(())
}

#[cfg(test)]
mod tests {
	use std::process::Command;

	use super::SETUP_SCRIPT;

	#[test]
	fn mount_protocol_has_no_dynamic_identity_or_host_path() {
		assert!(SETUP_SCRIPT.contains("/dev/vdb"));
		assert!(!SETUP_SCRIPT.contains("/dev/vdc"));
		assert!(!SETUP_SCRIPT.contains("dmsetup"));
		assert!(SETUP_SCRIPT.contains("discard_max_bytes"));
		assert!(SETUP_SCRIPT.contains("mount -t ext4"));
		assert!(SETUP_SCRIPT.contains("noatime,lazytime,discard,commit=5"));
		assert!(SETUP_SCRIPT.contains("/workspace"));
		assert!(SETUP_SCRIPT.contains("/opt/data"));
		assert!(SETUP_SCRIPT.contains("/sys/bus/platform/drivers/virtio-mmio/bind"));
		assert!(!SETUP_SCRIPT.contains("mkfs"));
		assert!(!SETUP_SCRIPT.contains("$1"));
	}

	#[test]
	fn mount_protocol_is_valid_posix_shell() {
		let status = Command::new("/bin/sh")
			.args(["-n", "-c", SETUP_SCRIPT])
			.status()
			.unwrap();
		assert!(status.success());
	}
}
