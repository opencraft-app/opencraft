use std::{
	fmt,
	os::fd::OwnedFd,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
};

use anyhow::{Result, bail, ensure};
use rivet_envoy_client::config::BoxFuture;
use scc::HashMap;

use crate::MinisandboxActorIdentity;

const MAX_PROFILE_ID_BYTES: usize = 128;
const MAX_LAUNCH_INPUT_BYTES: usize = 1024 * 1024;

/// A host-owned runtime profile selected by the Rivet pool.
///
/// Profiles contain no user-controlled paths. A future standalone `sbxlet`
/// will resolve the same ID against its local template registry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MinisandboxRuntimeProfile {
	profile_id: String,
	ingress_port: u16,
}

impl MinisandboxRuntimeProfile {
	pub fn new(profile_id: impl Into<String>, ingress_port: u16) -> Result<Self> {
		let profile = Self {
			profile_id: profile_id.into(),
			ingress_port,
		};
		profile.validate()?;
		Ok(profile)
	}

	pub fn profile_id(&self) -> &str {
		&self.profile_id
	}

	pub const fn ingress_port(&self) -> u16 {
		self.ingress_port
	}

	fn validate(&self) -> Result<()> {
		ensure!(
			!self.profile_id.is_empty()
				&& self.profile_id.len() <= MAX_PROFILE_ID_BYTES
				&& self.profile_id.bytes().all(|byte| {
					byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
				}),
			"profile_id must be a non-empty, bounded local profile name"
		);
		ensure!(
			self.ingress_port != 0,
			"profile ingress port must be non-zero"
		);
		Ok(())
	}
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxCreateRequest {
	pub identity: MinisandboxActorIdentity,
	pub profile: MinisandboxRuntimeProfile,
	pub launch_input: Option<Vec<u8>>,
}

impl SandboxCreateRequest {
	pub fn validate(&self) -> Result<()> {
		self.identity.validate()?;
		self.profile.validate()?;
		ensure!(
			self.launch_input.as_ref().map_or(0, Vec::len) <= MAX_LAUNCH_INPUT_BYTES,
			"sandbox launch input exceeds {MAX_LAUNCH_INPUT_BYTES} bytes"
		);
		Ok(())
	}
}

/// Why a live PVM instance is being irreversibly torn down.
///
/// Only `Destroy` removes durable actor storage. Every other reason revokes the
/// instance and its writer epoch while preserving the actor volume.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxDestroyReason {
	SleepIntent,
	StopIntent,
	Destroy,
	GoingAway,
	Lost,
	Replaced,
}

impl SandboxDestroyReason {
	pub const fn preserves_volume(self) -> bool {
		!matches!(self, Self::Destroy)
	}
}

/// Opaque generation-bound capability returned by `sbxlet::create`.
#[derive(Clone, PartialEq, Eq)]
pub struct SandboxHandle {
	instance_id: u64,
	capability: u128,
	identity: MinisandboxActorIdentity,
}

impl SandboxHandle {
	pub fn identity(&self) -> &MinisandboxActorIdentity {
		&self.identity
	}
}

impl fmt::Debug for SandboxHandle {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("SandboxHandle")
			.field("instance_id", &self.instance_id)
			.field("identity", &self.identity)
			.field("capability", &"<redacted>")
			.finish()
	}
}

/// Stable boundary shared by the in-process backend and the future `sbxlet`
/// client. The process split changes transport, not lifecycle semantics.
pub trait SbxletBackend: Send + Sync + 'static {
	fn create(&self, request: SandboxCreateRequest) -> BoxFuture<Result<SandboxHandle>>;

	fn open_ingress(&self, handle: SandboxHandle, guest_port: u16) -> BoxFuture<Result<OwnedFd>>;

	fn destroy(&self, handle: SandboxHandle, reason: SandboxDestroyReason)
	-> BoxFuture<Result<()>>;
}

/// One runtime-specific sandbox owned by [`LocalSbxletBackend`].
///
/// Implementations normally wrap a running PVM clone. Dropping the final
/// reference must revoke its resources, including during process shutdown.
pub trait LocalSandbox: Send + Sync + 'static {
	fn open_ingress(&self, guest_port: u16) -> BoxFuture<Result<OwnedFd>>;

	fn destroy(&self, reason: SandboxDestroyReason) -> BoxFuture<Result<()>>;
}

/// Factory for host-owned profiles. Profile lookup remains inside the trusted
/// runtime and never accepts a kernel, EROFS, or database path from an actor.
pub trait LocalSandboxFactory: Send + Sync + 'static {
	fn create(&self, request: SandboxCreateRequest) -> BoxFuture<Result<Arc<dyn LocalSandbox>>>;
}

struct LocalSandboxEntry {
	handle: SandboxHandle,
	active: AtomicBool,
	sandbox: Arc<dyn LocalSandbox>,
}

/// Same-process implementation used to establish the Rivet E2E before the
/// exact API is moved behind a Unix `SOCK_SEQPACKET` protocol.
pub struct LocalSbxletBackend {
	factory: Arc<dyn LocalSandboxFactory>,
	next_instance_id: AtomicU64,
	sandboxes: Arc<HashMap<u64, Arc<LocalSandboxEntry>>>,
}

impl LocalSbxletBackend {
	pub fn new(factory: Arc<dyn LocalSandboxFactory>) -> Self {
		Self {
			factory,
			next_instance_id: AtomicU64::new(1),
			sandboxes: Arc::new(HashMap::default()),
		}
	}

	pub fn active_count(&self) -> usize {
		let mut active = 0;
		self.sandboxes.iter_sync(|_, entry| {
			active += usize::from(entry.active.load(Ordering::Acquire));
			true
		});
		active
	}

	fn entry(&self, handle: &SandboxHandle) -> Result<Arc<LocalSandboxEntry>> {
		let Some(entry) = self
			.sandboxes
			.read_sync(&handle.instance_id, |_, entry| Arc::clone(entry))
		else {
			bail!("sandbox capability is stale or unknown");
		};
		ensure!(entry.handle == *handle, "sandbox capability does not match");
		Ok(entry)
	}
}

impl SbxletBackend for LocalSbxletBackend {
	fn create(&self, request: SandboxCreateRequest) -> BoxFuture<Result<SandboxHandle>> {
		let factory = self.factory.clone();
		let instance_id = self.next_instance_id.fetch_add(1, Ordering::Relaxed);
		let sandboxes = self.sandboxes.clone();
		Box::pin(async move {
			request.validate()?;
			ensure!(instance_id != 0, "local sbxlet instance ID space exhausted");
			let identity = request.identity.clone();
			let sandbox = factory.create(request).await?;
			let capability = loop {
				let candidate = rand::random::<u128>();
				if candidate != 0 {
					break candidate;
				}
			};
			let handle = SandboxHandle {
				instance_id,
				capability,
				identity,
			};
			let entry = Arc::new(LocalSandboxEntry {
				handle: handle.clone(),
				active: AtomicBool::new(true),
				sandbox,
			});
			sandboxes
				.insert_sync(instance_id, entry)
				.map_err(|_| anyhow::anyhow!("local sbxlet instance ID collision"))?;
			Ok(handle)
		})
	}

	fn open_ingress(&self, handle: SandboxHandle, guest_port: u16) -> BoxFuture<Result<OwnedFd>> {
		let entry = self.entry(&handle);
		Box::pin(async move {
			ensure!(guest_port != 0, "guest ingress port must be non-zero");
			let entry = entry?;
			ensure!(
				entry.active.load(Ordering::Acquire),
				"sandbox capability has been revoked"
			);
			let descriptor = entry.sandbox.open_ingress(guest_port).await?;
			if !entry.active.load(Ordering::Acquire) {
				drop(descriptor);
				bail!("sandbox was destroyed while opening ingress");
			}
			Ok(descriptor)
		})
	}

	fn destroy(
		&self,
		handle: SandboxHandle,
		reason: SandboxDestroyReason,
	) -> BoxFuture<Result<()>> {
		let entry = self.entry(&handle);
		let sandboxes = self.sandboxes.clone();
		Box::pin(async move {
			let entry = entry?;
			entry.active.store(false, Ordering::Release);
			entry.sandbox.destroy(reason).await?;
			sandboxes.remove_if_sync(&handle.instance_id, |current| current.handle == handle);
			Ok(())
		})
	}
}
