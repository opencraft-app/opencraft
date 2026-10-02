//! Validate one persistent sparse ext3 ActorBlockVolume.

use std::{
	env,
	fs::{self, File, OpenOptions},
	io,
	os::unix::fs::FileExt,
	path::Path,
	process::ExitCode,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::Duration,
};

use minisandbox_core::{
	control::CommandSpec,
	engine::{Engine, PvmBlockBackend, PvmBlockPool, PvmReadOnlyImage, RunOptions, RunOutcome},
	pvm_linux::READ_ONLY_ROOTFS_GPA,
};
use minisandbox_pvm_sys::{
	PVM_VIRTIO_BLK_DATA_IRQ_GSI, PVM_VIRTIO_BLK_DATA_MMIO_BASE, PVM_VIRTIO_BLK_IRQ_GSI,
	PVM_VIRTIO_BLK_MMIO_BASE,
};

const COMMON_COMMAND_LINE: &str = "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 nokaslr acpi=off pci=off noapic clocksource=tsc tsc=reliable";
const MEMORY_SIZE: usize = 256 * 1024 * 1024;
const EXPECTED_RECLAIM_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug)]
struct ExampleFileBackend {
	file: File,
	size: u64,
	discarded_bytes: Option<Arc<AtomicU64>>,
}

impl ExampleFileBackend {
	fn open(
		path: &Path,
		writable: bool,
		discarded_bytes: Option<Arc<AtomicU64>>,
	) -> Result<Self, String> {
		let file = OpenOptions::new()
			.read(true)
			.write(writable)
			.open(path)
			.map_err(|error| format!("cannot open {}: {error}", path.display()))?;
		let size = file
			.metadata()
			.map_err(|error| format!("cannot stat {}: {error}", path.display()))?
			.len();
		Ok(Self {
			file,
			size,
			discarded_bytes,
		})
	}
}

impl PvmBlockBackend for ExampleFileBackend {
	fn size(&self) -> u64 {
		self.size
	}

	fn read_at(&mut self, offset: u64, length: usize) -> io::Result<Vec<u8>> {
		let mut bytes = vec![0; length];
		self.file.read_exact_at(&mut bytes, offset)?;
		Ok(bytes)
	}

	fn write_at(&mut self, offset: u64, bytes: &[u8]) -> io::Result<()> {
		self.file.write_all_at(bytes, offset)
	}

	fn discard(&mut self, offset: u64, length: u64) -> io::Result<()> {
		let zeroes = vec![0_u8; 64 * 1024];
		let mut cursor = offset;
		let end = offset
			.checked_add(length)
			.ok_or_else(|| io::Error::other("discard range overflow"))?;
		while cursor < end {
			let chunk = usize::try_from((end - cursor).min(zeroes.len() as u64))
				.map_err(io::Error::other)?;
			self.file.write_all_at(&zeroes[..chunk], cursor)?;
			cursor += u64::try_from(chunk).map_err(io::Error::other)?;
		}
		if let Some(discarded_bytes) = &self.discarded_bytes {
			discarded_bytes.fetch_add(length, Ordering::SeqCst);
		}
		Ok(())
	}

	fn flush(&mut self) -> io::Result<()> {
		self.file.sync_data()
	}
}

fn main() -> ExitCode {
	match run() {
		Ok(()) => ExitCode::SUCCESS,
		Err(error) => {
			eprintln!("pvm-linux-actor-volume: {error}");
			ExitCode::FAILURE
		}
	}
}

fn run() -> Result<(), String> {
	let mut arguments = env::args_os().skip(1);
	let kernel_path = arguments.next().ok_or_else(usage)?;
	let lower_path = arguments.next().ok_or_else(usage)?;
	let upper_path = arguments.next().ok_or_else(usage)?;
	let pool_path = arguments.next().ok_or_else(usage)?;
	let actor_volume_path = arguments.next().ok_or_else(usage)?;
	if arguments.next().is_some() {
		return Err(usage());
	}

	let kernel = fs::read(&kernel_path)
		.map_err(|error| format!("cannot read {}: {error}", kernel_path.to_string_lossy()))?;
	let lower = File::open(&lower_path)
		.map_err(|error| format!("cannot open {}: {error}", lower_path.to_string_lossy()))?;
	let lower = PvmReadOnlyImage::from_file(lower)
		.map_err(|error| format!("cannot map shared EROFS: {error}"))?;
	let upper = OpenOptions::new()
		.read(true)
		.write(true)
		.open(&upper_path)
		.map_err(|error| {
			format!(
				"cannot open {} read-write: {error}",
				upper_path.to_string_lossy()
			)
		})?;
	fs::create_dir_all(&pool_path)
		.map_err(|error| format!("cannot create {}: {error}", pool_path.to_string_lossy()))?;
	let pool = PvmBlockPool::from_directory(
		File::open(&pool_path)
			.map_err(|error| format!("cannot open {}: {error}", pool_path.to_string_lossy()))?,
	)
	.map_err(|error| format!("cannot create block pool: {error}"))?;
	let actor_volume_path = Path::new(&actor_volume_path);

	let command_line = format!(
		"{COMMON_COMMAND_LINE} memmap={:#x}!{READ_ONLY_ROOTFS_GPA:#x} \
         root=/dev/pmem0 rootfstype=erofs rootflags=dax=always ro \
		 init=/sbin/minisandbox-init minisandbox.overlay=1 \
		 virtio_mmio.device=4K@{PVM_VIRTIO_BLK_MMIO_BASE:#x}:{PVM_VIRTIO_BLK_IRQ_GSI} \
		 virtio_mmio.device=4K@{PVM_VIRTIO_BLK_DATA_MMIO_BASE:#x}:{PVM_VIRTIO_BLK_DATA_IRQ_GSI}",
		lower.len()
	);
	let engine = Engine::open().map_err(|error| format!("cannot open PVM engine: {error:?}"))?;
	let template = engine
		.warm_pvm_linux_template_with_storage(
			&kernel,
			&[],
			command_line.as_bytes(),
			MEMORY_SIZE,
			&lower,
			READ_ONLY_ROOTFS_GPA,
			upper,
			&pool,
			RunOptions {
				timeout: Duration::from_secs(30),
			},
		)
		.map_err(|error| format!("cannot warm system-disk template: {error:?}"))?;
	print!("{}", String::from_utf8_lossy(template.warm_output()));

	let reclaimed = run_actor_volume_clone(
		&engine,
		&template,
		actor_volume_path,
		"MINISANDBOX_ACTOR_VOLUME_CREATED",
	)?;
	if reclaimed < EXPECTED_RECLAIM_BYTES {
		return Err(format!(
			"guest fstrim reclaimed {reclaimed} bytes, expected at least {EXPECTED_RECLAIM_BYTES}"
		));
	}
	println!("MINISANDBOX_ACTOR_VOLUME_RECLAIMED_BYTES={reclaimed}");
	run_actor_volume_clone(
		&engine,
		&template,
		actor_volume_path,
		"MINISANDBOX_ACTOR_VOLUME_REOPENED",
	)?;
	println!("MINISANDBOX_ACTOR_VOLUME_E2E_OK");
	Ok(())
}

fn run_actor_volume_clone(
	engine: &Engine,
	template: &minisandbox_core::engine::PvmLinuxTemplate,
	actor_volume_path: &Path,
	expected_probe: &str,
) -> Result<u64, String> {
	let discarded_bytes = Arc::new(AtomicU64::new(0));
	let actor_volume =
		ExampleFileBackend::open(actor_volume_path, true, Some(Arc::clone(&discarded_bytes)))?;
	let mut instance = engine
		.clone_pvm_linux_template_with_actor_volume_backend(template, Box::new(actor_volume))
		.map_err(|error| format!("cannot attach sparse ext3 ActorVolume clone: {error:?}"))?;
	let control = instance.sandbox_control();
	std::thread::scope(|scope| -> Result<(), String> {
		let runner = scope.spawn(move || {
			instance.run_for(RunOptions {
				timeout: Duration::from_secs(60),
			})
		});
		let operation = exercise_actor_volume(&control, expected_probe);
		let shutdown = request_guest_shutdown(&control);
		let run = runner
			.join()
			.map_err(|_| "PVM ActorVolume runner panicked".to_owned())?
			.map_err(|error| format!("PVM ActorVolume runner failed: {error:?}"))?;
		print!("{}", String::from_utf8_lossy(&run.output));
		if !matches!(run.outcome, RunOutcome::Exited { .. }) {
			return Err(format!(
				"ActorVolume clone did not complete graceful shutdown: {:?}",
				run.outcome
			));
		}
		operation?;
		if let Err(error) = shutdown {
			eprintln!("pvm-linux-actor-volume: shutdown command reply raced guest exit: {error}");
		}
		Ok(())
	})?;
	Ok(discarded_bytes.load(Ordering::SeqCst))
}

fn exercise_actor_volume(
	control: &minisandbox_core::control::SandboxControl,
	expected_probe: &str,
) -> Result<(), String> {
	control
		.ping(Duration::from_secs(2))
		.map_err(|error| format!("control ping failed: {error}"))?;
	let script = r#"
PATH=/usr/sbin:/sbin:/usr/bin:/bin
bound=0
for candidate in /sys/bus/platform/devices/virtio-mmio.*; do
	[ -e "$candidate" ] || continue
	[ ! -e "$candidate/driver" ] || continue
	device=${candidate##*/}
	printf '%s' "$device" > /sys/bus/platform/drivers/virtio-mmio/bind
	bound=$((bound + 1))
done
[ "$bound" -eq 1 ]
[ -b /dev/vdb ]
[ "$(cat /sys/class/block/vdb/ro)" -eq 0 ]
[ "$(cat /sys/class/block/vdb/queue/discard_max_bytes)" -ge 4096 ]
mkdir -p /workspace /opt/data
mount -t ext3 -o rw,nosuid,nodev,discard /dev/vdb /workspace
mount -o bind /workspace /opt/data
if [ -e /workspace/minisandbox-actor-volume-probe ]; then
	grep -qx actor-volume-ok /workspace/minisandbox-actor-volume-probe
	printf MINISANDBOX_ACTOR_VOLUME_REOPENED
else
	printf 'actor-volume-ok\n' > /workspace/minisandbox-actor-volume-probe
	sync -f /workspace
	dd if=/dev/zero of=/workspace/.minisandbox-reclaim-probe bs=1M count=8 conv=fsync status=none
	rm /workspace/.minisandbox-reclaim-probe
	fstrim /workspace >/dev/null
	sync -f /workspace
	printf MINISANDBOX_ACTOR_VOLUME_CREATED
fi
"#;
	let output = control
		.execute(
			&CommandSpec::new("/bin/sh").args(["-eu", "-c", script]),
			Duration::from_secs(30),
		)
		.map_err(|error| format!("ActorVolume mount command failed: {error}"))?;
	if output.exit_code != 0 || output.stdout != expected_probe.as_bytes() {
		return Err(format!("unexpected ActorVolume probe result: {output:?}"));
	}
	Ok(())
}

fn request_guest_shutdown(
	control: &minisandbox_core::control::SandboxControl,
) -> Result<(), String> {
	let output = control
		.execute(
			&CommandSpec::new("/usr/bin/kill").args(["-TERM", "1"]),
			Duration::from_secs(2),
		)
		.map_err(|error| format!("guest shutdown request failed: {error}"))?;
	if output.exit_code != 0 {
		return Err(format!(
			"guest shutdown command returned {}",
			output.exit_code
		));
	}
	Ok(())
}

fn usage() -> String {
	"usage: pvm_linux_actor_volume <bzImage> <lower.erofs> <system-upper.ext4> <pool-dir> <actor-volume.ext3>"
        .to_owned()
}
