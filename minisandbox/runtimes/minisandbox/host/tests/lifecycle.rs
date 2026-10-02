use std::{
	collections::HashMap, convert::Infallible, fs::File, net::SocketAddr, os::fd::OwnedFd,
	sync::Arc,
};

use anyhow::{Result, bail};
use futures_util::stream;
use hyper::{Body, Response, service::service_fn};
use rivet_envoy_client::config::{BoxFuture, HttpRequest};
use rivet_minisandbox_host::{
	LocalSandbox, LocalSandboxFactory, LocalSbxletBackend, MinisandboxActorIdentity,
	MinisandboxHost, MinisandboxRuntimeProfile, SandboxCreateRequest, SandboxDestroyReason,
	SbxletBackend,
};
use tokio::sync::{Mutex, Semaphore};

#[derive(Clone, Debug, PartialEq, Eq)]
enum Event {
	Create(MinisandboxActorIdentity),
	Destroy(MinisandboxActorIdentity, SandboxDestroyReason),
	Open(MinisandboxActorIdentity, u16),
}

#[derive(Default)]
struct TestFactory {
	events: Arc<Mutex<Vec<Event>>>,
	fail_create_generation: Option<u32>,
	fail_destroy_generation: Option<u32>,
}

impl LocalSandboxFactory for TestFactory {
	fn create(&self, request: SandboxCreateRequest) -> BoxFuture<Result<Arc<dyn LocalSandbox>>> {
		let events = self.events.clone();
		let fail_create = self.fail_create_generation == Some(request.identity.generation);
		let fail_destroy = self.fail_destroy_generation == Some(request.identity.generation);
		Box::pin(async move {
			events
				.lock()
				.await
				.push(Event::Create(request.identity.clone()));
			if fail_create {
				bail!("injected create failure");
			}
			Ok(Arc::new(TestSandbox {
				identity: request.identity,
				events,
				fail_destroy,
			}) as Arc<dyn LocalSandbox>)
		})
	}
}

struct TestSandbox {
	identity: MinisandboxActorIdentity,
	events: Arc<Mutex<Vec<Event>>>,
	fail_destroy: bool,
}

impl LocalSandbox for TestSandbox {
	fn open_ingress(&self, guest_port: u16) -> BoxFuture<Result<OwnedFd>> {
		let identity = self.identity.clone();
		let events = self.events.clone();
		Box::pin(async move {
			events.lock().await.push(Event::Open(identity, guest_port));
			bail!("test sandbox has no HTTP peer")
		})
	}

	fn destroy(&self, reason: SandboxDestroyReason) -> BoxFuture<Result<()>> {
		let identity = self.identity.clone();
		let events = self.events.clone();
		let fail = self.fail_destroy;
		Box::pin(async move {
			events.lock().await.push(Event::Destroy(identity, reason));
			if fail {
				bail!("injected destroy failure");
			}
			Ok(())
		})
	}
}

fn identity(generation: u32) -> MinisandboxActorIdentity {
	MinisandboxActorIdentity::new("actor-1", generation).unwrap()
}

fn profile() -> MinisandboxRuntimeProfile {
	MinisandboxRuntimeProfile::new("hermes-v1", 8642).unwrap()
}

fn host(factory: Arc<TestFactory>) -> MinisandboxHost {
	MinisandboxHost::new(Arc::new(LocalSbxletBackend::new(factory)), profile())
}

fn request() -> HttpRequest {
	HttpRequest {
		method: "GET".into(),
		path: "/".into(),
		headers: HashMap::new(),
		body: None,
		body_stream: None,
	}
}

#[tokio::test]
async fn replacement_fences_old_generation_before_dispatch() -> Result<()> {
	let factory = Arc::new(TestFactory::default());
	let host = host(factory.clone());

	host.start_actor(identity(1)).await?;
	host.start_actor(identity(1)).await?;
	host.start_actor(identity(2)).await?;

	assert!(host.fetch_actor(identity(1), request()).await.is_err());
	assert_eq!(host.active_generation("actor-1").await, Some(2));
	assert_eq!(
		*factory.events.lock().await,
		vec![
			Event::Create(identity(1)),
			Event::Destroy(identity(1), SandboxDestroyReason::Replaced),
			Event::Create(identity(2)),
		]
	);
	Ok(())
}

#[tokio::test]
async fn delayed_stop_cannot_remove_new_generation() -> Result<()> {
	let factory = Arc::new(TestFactory::default());
	let host = host(factory);

	host.start_actor(identity(1)).await?;
	host.start_actor(identity(2)).await?;
	host.stop_actor(identity(1)).await?;

	assert_eq!(host.active_generation("actor-1").await, Some(2));
	assert_eq!(host.active_count().await, 1);
	Ok(())
}

#[tokio::test]
async fn failed_create_is_never_published() {
	let factory = Arc::new(TestFactory {
		fail_create_generation: Some(2),
		..TestFactory::default()
	});
	let host = host(factory.clone());

	assert!(host.start_actor(identity(2)).await.is_err());
	assert_eq!(host.active_count().await, 0);
	assert!(host.start_actor(identity(1)).await.is_err());
	assert!(host.fetch_actor(identity(1), request()).await.is_err());
	assert_eq!(
		*factory.events.lock().await,
		vec![Event::Create(identity(2))]
	);
}

#[tokio::test]
async fn failed_destroy_still_revokes_admission() -> Result<()> {
	let factory = Arc::new(TestFactory {
		fail_destroy_generation: Some(1),
		..TestFactory::default()
	});
	let host = host(factory.clone());

	host.start_actor(identity(1)).await?;
	assert!(host.stop_actor(identity(1)).await.is_err());
	assert_eq!(host.active_count().await, 0);
	assert!(host.fetch_actor(identity(1), request()).await.is_err());
	assert!(host.stop_actor(identity(1)).await.is_err());
	assert_eq!(
		*factory.events.lock().await,
		vec![
			Event::Create(identity(1)),
			Event::Destroy(identity(1), SandboxDestroyReason::StopIntent),
			Event::Destroy(identity(1), SandboxDestroyReason::StopIntent),
		]
	);
	Ok(())
}

#[tokio::test]
async fn failed_replacement_preserves_floor_and_retries_old_teardown() -> Result<()> {
	let factory = Arc::new(TestFactory {
		fail_destroy_generation: Some(1),
		..TestFactory::default()
	});
	let host = host(factory.clone());

	host.start_actor(identity(1)).await?;
	assert!(host.start_actor(identity(2)).await.is_err());
	assert_eq!(host.active_count().await, 0);
	assert!(host.start_actor(identity(1)).await.is_err());
	assert!(host.start_actor(identity(2)).await.is_err());
	assert_eq!(
		*factory.events.lock().await,
		vec![
			Event::Create(identity(1)),
			Event::Destroy(identity(1), SandboxDestroyReason::Replaced),
			Event::Destroy(identity(1), SandboxDestroyReason::Replaced),
		]
	);
	Ok(())
}

#[test]
fn identity_and_profile_validation_are_bounded() {
	assert!(MinisandboxActorIdentity::new("", 1).is_err());
	assert!(MinisandboxActorIdentity::new("actor/escape", 1).is_err());
	assert!(MinisandboxActorIdentity::new("actor", 0).is_err());
	assert!(MinisandboxActorIdentity::new("a".repeat(129), 1).is_err());
	assert!(MinisandboxActorIdentity::new("actor_ok-1", 1).is_ok());
	assert!(MinisandboxRuntimeProfile::new("", 8642).is_err());
	assert!(MinisandboxRuntimeProfile::new("profile/path", 8642).is_err());
	assert!(MinisandboxRuntimeProfile::new("hermes-v1", 0).is_err());
	assert!(MinisandboxRuntimeProfile::new("hermes-v1", 8642).is_ok());
}

struct HttpFactory {
	address: SocketAddr,
	opened_port: Arc<Mutex<Option<u16>>>,
}

impl LocalSandboxFactory for HttpFactory {
	fn create(&self, _request: SandboxCreateRequest) -> BoxFuture<Result<Arc<dyn LocalSandbox>>> {
		let sandbox = Arc::new(HttpSandbox {
			address: self.address,
			opened_port: self.opened_port.clone(),
		});
		Box::pin(async move { Ok(sandbox as Arc<dyn LocalSandbox>) })
	}
}

struct HttpSandbox {
	address: SocketAddr,
	opened_port: Arc<Mutex<Option<u16>>>,
}

impl LocalSandbox for HttpSandbox {
	fn open_ingress(&self, guest_port: u16) -> BoxFuture<Result<OwnedFd>> {
		let address = self.address;
		let opened_port = self.opened_port.clone();
		Box::pin(async move {
			*opened_port.lock().await = Some(guest_port);
			let stream = tokio::net::TcpStream::connect(address).await?;
			Ok(stream.into_std()?.into())
		})
	}

	fn destroy(&self, _reason: SandboxDestroyReason) -> BoxFuture<Result<()>> {
		Box::pin(async { Ok(()) })
	}
}

#[tokio::test]
async fn rivet_http_streams_over_a_fresh_ingress_fd() -> Result<()> {
	let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
	let address = listener.local_addr()?;
	let (observed_tx, observed_rx) = tokio::sync::oneshot::channel();
	let server = tokio::spawn(async move {
		let (stream, _) = listener.accept().await?;
		let observed_tx = Arc::new(std::sync::Mutex::new(Some(observed_tx)));
		hyper::server::conn::Http::new()
			.serve_connection(
				stream,
				service_fn(move |request| {
					let observed_tx = observed_tx.clone();
					async move {
						let method = request.method().clone();
						let path = request.uri().path().to_owned();
						let body = hyper::body::to_bytes(request.into_body()).await.unwrap();
						if let Some(tx) = observed_tx.lock().unwrap().take() {
							let _ = tx.send((method, path, body.to_vec()));
						}
						let chunks = stream::iter([
							Ok::<_, Infallible>("hello "),
							Ok::<_, Infallible>("from guest"),
						]);
						Ok::<_, Infallible>(Response::new(Body::wrap_stream(chunks)))
					}
				}),
			)
			.await?;
		Ok::<_, anyhow::Error>(())
	});

	let opened_port = Arc::new(Mutex::new(None));
	let backend = Arc::new(LocalSbxletBackend::new(Arc::new(HttpFactory {
		address,
		opened_port: opened_port.clone(),
	})));
	let host = MinisandboxHost::new(backend, profile());
	host.start_actor(identity(1)).await?;
	let (body_tx, body_rx) = tokio::sync::mpsc::unbounded_channel();
	body_tx.send(b"request ".to_vec())?;
	body_tx.send(b"body".to_vec())?;
	drop(body_tx);
	let mut response = host
		.fetch_actor(
			identity(1),
			HttpRequest {
				method: "POST".into(),
				path: "/chat".into(),
				headers: HashMap::from([("host".into(), "sandbox".into())]),
				body: None,
				body_stream: Some(body_rx),
			},
		)
		.await?;
	assert_eq!(response.status, 200);
	assert!(response.body.is_none());
	let mut received = Vec::new();
	let mut finished = false;
	let mut response_stream = response.body_stream.take().unwrap();
	while let Some(chunk) = response_stream.recv().await {
		received.extend_from_slice(&chunk.data);
		if chunk.finish {
			finished = true;
			break;
		}
	}
	assert!(finished);
	assert_eq!(received, b"hello from guest");
	assert_eq!(*opened_port.lock().await, Some(8642));
	let (method, path, body) = observed_rx.await?;
	assert_eq!(method, hyper::Method::POST);
	assert_eq!(path, "/chat");
	assert_eq!(body, b"request body");
	server.await??;
	Ok(())
}

struct RaceFactory {
	state: Arc<RaceState>,
}

impl LocalSandboxFactory for RaceFactory {
	fn create(&self, _request: SandboxCreateRequest) -> BoxFuture<Result<Arc<dyn LocalSandbox>>> {
		let sandbox = Arc::new(RaceSandbox {
			state: self.state.clone(),
		});
		Box::pin(async move { Ok(sandbox as Arc<dyn LocalSandbox>) })
	}
}

struct RaceState {
	entered: Semaphore,
	release: Semaphore,
}

struct RaceSandbox {
	state: Arc<RaceState>,
}

impl LocalSandbox for RaceSandbox {
	fn open_ingress(&self, _guest_port: u16) -> BoxFuture<Result<OwnedFd>> {
		let state = self.state.clone();
		Box::pin(async move {
			state.entered.add_permits(1);
			state.release.acquire().await?.forget();
			Ok(File::open("/dev/null")?.into())
		})
	}

	fn destroy(&self, _reason: SandboxDestroyReason) -> BoxFuture<Result<()>> {
		Box::pin(async { Ok(()) })
	}
}

#[tokio::test]
async fn destroy_revokes_an_inflight_ingress_open() -> Result<()> {
	let state = Arc::new(RaceState {
		entered: Semaphore::new(0),
		release: Semaphore::new(0),
	});
	let backend = Arc::new(LocalSbxletBackend::new(Arc::new(RaceFactory {
		state: state.clone(),
	})));
	let handle = backend
		.create(SandboxCreateRequest {
			identity: identity(1),
			profile: profile(),
			launch_input: None,
		})
		.await?;
	let opening_backend = backend.clone();
	let opening_handle = handle.clone();
	let opening =
		tokio::spawn(async move { opening_backend.open_ingress(opening_handle, 8642).await });
	state.entered.acquire().await?.forget();
	backend
		.destroy(handle.clone(), SandboxDestroyReason::Destroy)
		.await?;
	state.release.add_permits(1);
	assert!(opening.await?.is_err());
	assert!(backend.open_ingress(handle, 8642).await.is_err());
	assert_eq!(backend.active_count(), 0);
	Ok(())
}
