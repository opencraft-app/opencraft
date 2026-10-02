//! Nonblocking host TCP broker driven by a bounded mailbox drain.

use std::{
    collections::{HashMap, VecDeque},
    fs,
    future::Future,
    io::{self, Write},
    net::{
        Ipv4Addr, Shutdown, SocketAddr, SocketAddrV4, TcpListener as StdTcpListener,
        TcpStream as StdTcpStream, UdpSocket as StdUdpSocket,
    },
    os::fd::AsRawFd,
    os::unix::thread::JoinHandleExt,
    panic::{AssertUnwindSafe, catch_unwind},
    pin::Pin,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc::{Receiver, SyncSender, TryRecvError, TrySendError, sync_channel},
    },
    task::{Context, Poll as TaskPoll, Waker as TaskWaker},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use minisandbox_pvm_sys::PvmIrqSender;
use mio::{
    Events, Interest, Poll, Token, Waker,
    net::{TcpStream, UdpSocket},
};
use pvm_stream_mailbox::{
    Capability, Limits, MailboxState, RxCompletion, TxProgress,
    protocol::MailboxError,
    wire::{Command, CommandKind, Opcode},
};

use crate::{
    dns::{RESPONSE_MAX, validate_query, validate_response},
    layout::{DRAIN_BUDGET, RING_ENTRIES, SLOT_COUNT, SLOT_SIZE, ServiceMemory},
    policy::{ConnectPolicy, DenyAll, DnsPolicy},
    quota::{
        CLONE_MAILBOX_BUFFER_BYTES_PER_DIRECTION, MAX_ACTIVE_SOCKET_FDS,
        STREAM_BUFFER_BYTES_PER_DIRECTION, SocketQuotas, TokenBucket,
    },
    ring::{HostRing, RingError},
    wire::{ENDPOINT_SIZE, Endpoint, Event, EventKind, INGRESS_SLOTS, PendingIngressId},
};

/// Guest-visible address for explicitly reaching the host loopback namespace.
/// Guest `127/8` is reserved for the native in-guest loopback stack.
pub const HOST_LOOPBACK_ALIAS: Ipv4Addr = Ipv4Addr::new(192, 0, 2, 1);

const WAKE_TOKEN: Token = Token(0);
const CAPABILITY_COUNT: usize = MAX_ACTIVE_SOCKET_FDS;
const MAX_PENDING_EVENTS: usize = RING_ENTRIES + SLOT_COUNT + INGRESS_SLOTS;
const SOCKET_IO_QUANTUM: usize = 2;
const READY_TURN_BUDGET: usize = 64;
const PER_CONNECTION_SLOTS: usize = 4;
const MAX_EVENTS_PER_COMMAND: usize = PER_CONNECTION_SLOTS + 1;
const MAX_EVENTS_PER_READY_TURN: usize = 2 * SOCKET_IO_QUANTUM + PER_CONNECTION_SLOTS + 1;
const MAX_DNS_OUTSTANDING: usize = 8;
const MAX_DNS_CONNECTIONS: usize = 16;
const HOST_COMMAND_CAPACITY: usize = INGRESS_SLOTS;
const HOST_COMMAND_BUDGET: usize = 16;
const DEFAULT_INGRESS_TIMEOUT: Duration = Duration::from_secs(5);
const TCP_PRIVATE_COPY_MAX: u32 = 1024;
const SLOT_SIZE_U32: u32 = 4096;
const STREAM_WINDOW_U32: u32 = 4 * SLOT_SIZE_U32;
const ENDPOINT_SIZE_U32: u32 = 8;
const DNS_RESPONSE_MAX_U32: u32 = SLOT_SIZE_U32 - ENDPOINT_SIZE_U32;
const HOST_DNS_ALIAS: Ipv4Addr = Ipv4Addr::new(192, 0, 2, 53);
const RESOLV_CONF_MAX: usize = 16 * 1024;

const _: () = assert!(ENDPOINT_SIZE == ENDPOINT_SIZE_U32 as usize);
const _: () = assert!(RESPONSE_MAX == DNS_RESPONSE_MAX_U32 as usize);
const _: () = assert!(STREAM_WINDOW_U32 as usize == PER_CONNECTION_SLOTS * SLOT_SIZE);
const _: () = assert!(
    CLONE_MAILBOX_BUFFER_BYTES_PER_DIRECTION == SLOT_COUNT * SLOT_SIZE,
    "public clone buffer quota must match the fixed mailbox"
);
const _: () = assert!(
    STREAM_BUFFER_BYTES_PER_DIRECTION == PER_CONNECTION_SLOTS * SLOT_SIZE,
    "public stream buffer quota must match ownership limits"
);

type State = MailboxState<SLOT_COUNT, SLOT_COUNT, CAPABILITY_COUNT>;

/// Factory for one clone-local nonblocking TCP worker.
pub struct TcpBroker;

/// Factory for a combined outbound TCP and restricted UDP DNS worker.
pub struct SocketBroker;

/// Control handle retained by the VM run loop.
pub struct BrokerHandle {
    wake: Arc<Waker>,
    stopping: Arc<AtomicBool>,
    outcome: Arc<Mutex<Option<String>>>,
    stats: Arc<BrokerStatsAtomic>,
    thread_cpu_clock: Option<libc::clockid_t>,
    worker: Option<JoinHandle<()>>,
    ingress: SocketIngressHandle,
}

/// Cloneable host-side entrance for explicitly injecting an accepted IPv4 TCP
/// stream into one sandbox listener. Guest `listen(2)` alone creates no host
/// descriptor or reactor registration.
#[derive(Clone)]
pub struct SocketIngressHandle {
    commands: SyncSender<HostCommand>,
    wake: Arc<Waker>,
    in_flight: Arc<AtomicUsize>,
    stopping: Arc<AtomicBool>,
    pending_limit: usize,
}

/// Bounded failure modes for host-to-guest TCP injection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SocketIngressError {
    /// Guest port zero is not a connectable listener endpoint.
    InvalidPort,
    /// The first ABI version supports connected IPv4 TCP streams only.
    UnsupportedPeer,
    /// The supplied TCP stream is not connected or could not become nonblocking.
    InvalidStream(i32),
    /// A host-local TCP pair could not be constructed.
    HostIo(i32),
    /// This clone already has the maximum number of pending ingress requests.
    Capacity,
    /// No unambiguous guest listener accepted the offer.
    Rejected,
    /// The guest did not acknowledge the bounded offer before its deadline.
    TimedOut,
    /// The clone-local socket worker has stopped.
    BrokerStopped,
}

impl std::fmt::Display for SocketIngressError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPort => formatter.write_str("guest ingress port must be nonzero"),
            Self::UnsupportedPeer => formatter.write_str("guest ingress requires an IPv4 peer"),
            Self::InvalidStream(errno) => write!(formatter, "invalid TCP stream (errno {errno})"),
            Self::HostIo(errno) => write!(formatter, "host TCP setup failed (errno {errno})"),
            Self::Capacity => formatter.write_str("guest ingress queue is full"),
            Self::Rejected => formatter.write_str("guest listener rejected ingress"),
            Self::TimedOut => formatter.write_str("guest ingress offer timed out"),
            Self::BrokerStopped => formatter.write_str("socket broker stopped"),
        }
    }
}

impl std::error::Error for SocketIngressError {}

type IngressResult = Result<(), SocketIngressError>;

struct IngressCompletionState {
    result: Option<IngressResult>,
    waker: Option<TaskWaker>,
}

struct IngressCompletion {
    state: Mutex<IngressCompletionState>,
    ready: Condvar,
    cancelled: AtomicBool,
    cancel_wake: Option<Arc<Waker>>,
}

impl IngressCompletion {
    fn finish(&self, result: IngressResult) {
        let waker = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.result.is_some() {
                return;
            }
            state.result = Some(result);
            state.waker.take()
        };
        self.ready.notify_all();
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Some(wake) = &self.cancel_wake {
            let _ = wake.wake();
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

struct IngressReply(Arc<IngressCompletion>);

impl IngressReply {
    fn pair(cancel_wake: Option<Arc<Waker>>) -> (Self, IngressOperation) {
        let completion = Arc::new(IngressCompletion {
            state: Mutex::new(IngressCompletionState {
                result: None,
                waker: None,
            }),
            ready: Condvar::new(),
            cancelled: AtomicBool::new(false),
            cancel_wake,
        });
        (
            Self(Arc::clone(&completion)),
            IngressOperation {
                completion,
                consumed: false,
            },
        )
    }

    fn send(self, result: IngressResult) {
        self.0.finish(result);
    }
}

impl Drop for IngressReply {
    fn drop(&mut self) {
        self.0.finish(Err(SocketIngressError::BrokerStopped));
    }
}

/// One submitted host-to-guest TCP offer.
///
/// This future is executor-independent: polling it never blocks a thread and
/// completion is driven by the clone-local socket broker. Dropping an
/// incomplete future actively cancels and reclaims the bounded offer.
#[must_use = "an ingress operation must be awaited or synchronously waited"]
pub struct IngressOperation {
    completion: Arc<IngressCompletion>,
    consumed: bool,
}

impl IngressOperation {
    /// Best-effort cancellation before the guest accepts the offered stream.
    ///
    /// This also cancels an acknowledgement that completed in the broker but
    /// has not yet been consumed by the caller. Once guest `accept(2)` wins the
    /// race, ordinary TCP FIN/RST from the peer is the cancellation signal.
    pub fn cancel(mut self) {
        self.completion.cancel();
        self.consumed = true;
    }

    /// Blocks only the calling thread until the broker completes the offer.
    ///
    /// Async host servers should await the operation instead.
    ///
    /// # Errors
    ///
    /// Returns listener rejection, deadline expiry, or broker shutdown.
    pub fn wait(mut self) -> IngressResult {
        let mut state = self
            .completion
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if let Some(result) = state.result.take() {
                drop(state);
                self.consumed = true;
                return result;
            }
            state = self
                .completion
                .ready
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    /// Blocks only the calling thread for at most `timeout`.
    ///
    /// # Errors
    ///
    /// Returns listener rejection, broker shutdown, or `TimedOut` when either
    /// the ingress or this caller-side wait reaches its deadline.
    pub fn wait_timeout(mut self, timeout: Duration) -> IngressResult {
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or(SocketIngressError::TimedOut)?;
        let mut state = self
            .completion
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if let Some(result) = state.result.take() {
                drop(state);
                self.consumed = true;
                return result;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(SocketIngressError::TimedOut);
            }
            let (next, wait) = self
                .completion
                .ready
                .wait_timeout(state, remaining)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state = next;
            if wait.timed_out() && state.result.is_none() {
                return Err(SocketIngressError::TimedOut);
            }
        }
    }

    /// Returns a completed result without blocking, or `None` while pending.
    pub fn try_result(&self) -> Option<IngressResult> {
        self.completion
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .result
            .as_ref()
            .copied()
    }
}

impl Future for IngressOperation {
    type Output = IngressResult;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> TaskPoll<Self::Output> {
        let this = self.get_mut();
        let mut state = this
            .completion
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(result) = state.result.take() {
            drop(state);
            this.consumed = true;
            return TaskPoll::Ready(result);
        }
        if state
            .waker
            .as_ref()
            .is_none_or(|waker| !waker.will_wake(context.waker()))
        {
            state.waker = Some(context.waker().clone());
        }
        TaskPoll::Pending
    }
}

impl Drop for IngressOperation {
    fn drop(&mut self) {
        if !self.consumed {
            self.completion.cancel();
        }
    }
}

struct IngressPermit(Arc<AtomicUsize>);

impl IngressPermit {
    fn acquire(counter: &Arc<AtomicUsize>, limit: usize) -> Option<Self> {
        counter
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < limit).then_some(current + 1)
            })
            .ok()
            .map(|_| Self(Arc::clone(counter)))
    }
}

impl Drop for IngressPermit {
    fn drop(&mut self) {
        let previous = self.0.fetch_sub(1, Ordering::AcqRel);
        debug_assert_ne!(previous, 0);
    }
}

enum HostCommand {
    Inject {
        stream: StdTcpStream,
        guest_port: u16,
        peer: SocketAddrV4,
        deadline: Instant,
        reply: IngressReply,
        permit: IngressPermit,
    },
}

/// Monotonic diagnostic counters for one clone-local socket broker.
///
/// These counters are host-only observability state. They do not change the
/// guest ABI, mailbox layout, quotas, or scheduling decisions.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct BrokerStats {
    /// Guest-to-host service doorbells received by the VM run loop.
    pub guest_doorbells: u64,
    /// Returns from the host `mio` poller, including explicit wakeups.
    pub poll_wakeups: u64,
    /// Connection turns serviced by the bounded fair ready queue.
    pub reactor_turns: u64,
    /// Valid or rejected guest commands removed from the request ring.
    pub commands_drained: u64,
    /// Completion events published into the host-to-guest ring.
    pub events_published: u64,
    /// Host-to-guest socket IRQ notifications injected into the VM.
    pub guest_irq_injections: u64,
    /// Completed guest transmit slots written to host sockets.
    pub tx_slots: u64,
    /// Bytes written to host sockets, including partial write progress.
    pub tx_bytes: u64,
    /// Receive slots published after reading host sockets.
    pub rx_slots: u64,
    /// Bytes read from host sockets and published to the guest.
    pub rx_bytes: u64,
    /// CPU time consumed by the broker thread itself.
    pub broker_cpu_ns: u64,
}

#[derive(Default)]
struct BrokerStatsAtomic {
    guest_doorbells: AtomicU64,
    poll_wakeups: AtomicU64,
    reactor_turns: AtomicU64,
    commands_drained: AtomicU64,
    events_published: AtomicU64,
    guest_irq_injections: AtomicU64,
    tx_slots: AtomicU64,
    tx_bytes: AtomicU64,
    rx_slots: AtomicU64,
    rx_bytes: AtomicU64,
}

impl BrokerStatsAtomic {
    fn snapshot(&self) -> BrokerStats {
        BrokerStats {
            guest_doorbells: self.guest_doorbells.load(Ordering::Relaxed),
            poll_wakeups: self.poll_wakeups.load(Ordering::Relaxed),
            reactor_turns: self.reactor_turns.load(Ordering::Relaxed),
            commands_drained: self.commands_drained.load(Ordering::Relaxed),
            events_published: self.events_published.load(Ordering::Relaxed),
            guest_irq_injections: self.guest_irq_injections.load(Ordering::Relaxed),
            tx_slots: self.tx_slots.load(Ordering::Relaxed),
            tx_bytes: self.tx_bytes.load(Ordering::Relaxed),
            rx_slots: self.rx_slots.load(Ordering::Relaxed),
            rx_bytes: self.rx_bytes.load(Ordering::Relaxed),
            broker_cpu_ns: 0,
        }
    }
}

trait GuestNotifier: Send + Sync {
    fn notify(&self) -> io::Result<()>;
}

impl GuestNotifier for PvmIrqSender {
    fn notify(&self) -> io::Result<()> {
        PvmIrqSender::notify(self)
    }
}

impl TcpBroker {
    /// Starts one worker. The policy is the only way to authorize destinations.
    ///
    /// # Errors
    ///
    /// Returns an error when the poller, waker, protocol state, ring, or worker
    /// thread cannot be constructed.
    pub fn spawn(
        memory: ServiceMemory,
        irq: PvmIrqSender,
        policy: Arc<dyn ConnectPolicy>,
    ) -> io::Result<BrokerHandle> {
        spawn_with_notifier(memory, Arc::new(irq), policy, Arc::new(DenyAll))
    }

    /// Starts one worker with explicit clone-local resource quotas.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid quotas or worker/ring/PVM setup failure.
    pub fn spawn_with_quotas(
        memory: ServiceMemory,
        irq: PvmIrqSender,
        policy: Arc<dyn ConnectPolicy>,
        quotas: SocketQuotas,
    ) -> io::Result<BrokerHandle> {
        spawn_with_notifier_and_quotas(memory, Arc::new(irq), policy, Arc::new(DenyAll), quotas)
    }
}

impl SocketBroker {
    /// Starts one worker with independent TCP-destination and DNS-resolver policies.
    ///
    /// # Errors
    ///
    /// Returns an error when the poller, waker, protocol state, ring, or worker
    /// thread cannot be constructed.
    pub fn spawn(
        memory: ServiceMemory,
        irq: PvmIrqSender,
        tcp_policy: Arc<dyn ConnectPolicy>,
        dns_policy: Arc<dyn DnsPolicy>,
    ) -> io::Result<BrokerHandle> {
        spawn_with_notifier(memory, Arc::new(irq), tcp_policy, dns_policy)
    }

    /// Starts one worker with explicit clone-local resource quotas.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid quotas or worker/ring/PVM setup failure.
    pub fn spawn_with_quotas(
        memory: ServiceMemory,
        irq: PvmIrqSender,
        tcp_policy: Arc<dyn ConnectPolicy>,
        dns_policy: Arc<dyn DnsPolicy>,
        quotas: SocketQuotas,
    ) -> io::Result<BrokerHandle> {
        spawn_with_notifier_and_quotas(memory, Arc::new(irq), tcp_policy, dns_policy, quotas)
    }
}

fn spawn_with_notifier(
    memory: ServiceMemory,
    irq: Arc<dyn GuestNotifier>,
    tcp_policy: Arc<dyn ConnectPolicy>,
    dns_policy: Arc<dyn DnsPolicy>,
) -> io::Result<BrokerHandle> {
    spawn_with_notifier_and_quotas(memory, irq, tcp_policy, dns_policy, SocketQuotas::default())
}

fn spawn_with_notifier_and_quotas(
    memory: ServiceMemory,
    irq: Arc<dyn GuestNotifier>,
    tcp_policy: Arc<dyn ConnectPolicy>,
    dns_policy: Arc<dyn DnsPolicy>,
    quotas: SocketQuotas,
) -> io::Result<BrokerHandle> {
    let quotas = quotas.validate().map_err(io::Error::other)?;
    let poll = Poll::new()?;
    let wake = Arc::new(Waker::new(poll.registry(), WAKE_TOKEN)?);
    let (host_commands, host_command_rx) = sync_channel(HOST_COMMAND_CAPACITY);
    let ingress_in_flight = Arc::new(AtomicUsize::new(0));
    let stopping = Arc::new(AtomicBool::new(false));
    let outcome = Arc::new(Mutex::new(None));
    let stats = Arc::new(BrokerStatsAtomic::default());
    let worker_wake = Arc::clone(&wake);
    let worker_stopping = Arc::clone(&stopping);
    let worker_outcome = Arc::clone(&outcome);
    let mut loop_state = BrokerLoop::new_with_stats(
        poll,
        memory,
        irq,
        BrokerConfiguration {
            tcp_policy,
            dns_policy,
            quotas,
        },
        Arc::clone(&stats),
        host_command_rx,
    )?;
    let worker = thread::Builder::new()
        .name("pvm-socket-broker".to_owned())
        .spawn(move || {
            let failure = match catch_unwind(AssertUnwindSafe(|| {
                loop_state.run(&worker_wake, &worker_stopping)
            })) {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(error.to_string()),
                Err(_) => Some("socket broker thread panicked".to_owned()),
            };
            if let Some(failure) = failure {
                *worker_outcome
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(failure);
            }
        })?;
    let thread_cpu_clock = thread_cpu_clock(&worker);
    Ok(BrokerHandle {
        ingress: SocketIngressHandle {
            commands: host_commands,
            wake: Arc::clone(&wake),
            in_flight: ingress_in_flight,
            stopping: Arc::clone(&stopping),
            pending_limit: quotas.pending_ingress_offers,
        },
        wake,
        stopping,
        outcome,
        stats,
        thread_cpu_clock,
        worker: Some(worker),
    })
}

impl BrokerHandle {
    /// Returns a cloneable ingress handle that does not own or join the worker.
    #[must_use]
    pub fn ingress_handle(&self) -> SocketIngressHandle {
        self.ingress.clone()
    }

    /// Wakes the bounded request drain after `HC_SERVICE_NOTIFY`.
    ///
    /// # Errors
    ///
    /// Returns an OS error if the poll waker has been closed.
    pub fn notify_guest_requests(&self) -> io::Result<()> {
        if let Some(error) = self
            .outcome
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            return Err(io::Error::other(error.clone()));
        }
        self.stats.guest_doorbells.fetch_add(1, Ordering::Relaxed);
        self.wake.wake()
    }

    /// Returns a lock-free snapshot of this broker's diagnostic counters.
    #[must_use]
    pub fn stats(&self) -> BrokerStats {
        let mut snapshot = self.stats.snapshot();
        snapshot.broker_cpu_ns = self
            .thread_cpu_clock
            .and_then(clock_cpu_ns)
            .unwrap_or_default();
        snapshot
    }

    /// Stops the worker and reports a protocol/socket failure, if one occurred.
    ///
    /// # Errors
    ///
    /// Returns an error if wake/join fails or the worker terminated fatally.
    pub fn shutdown(mut self) -> io::Result<()> {
        self.stop_and_join()
    }

    fn stop_and_join(&mut self) -> io::Result<()> {
        self.stopping.store(true, Ordering::Release);
        let wake_result = self.wake.wake();
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| io::Error::other("socket broker thread panicked"))?;
        }
        wake_result?;
        if let Some(error) = self
            .outcome
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            return Err(io::Error::other(error));
        }
        Ok(())
    }
}

impl SocketIngressHandle {
    /// Creates one private host-local TCP pair, injects its far endpoint into
    /// `127.0.0.1:guest_port`, and returns the endpoint used by the host server.
    ///
    /// This is the ordinary request/response API. [`Self::inject_tcp`] remains
    /// available when a front-end listener has already accepted an external
    /// client and wants to transfer that exact stream.
    ///
    /// # Errors
    ///
    /// Returns a bounded host socket, validation, capacity, listener, timeout,
    /// or worker error.
    pub fn connect_tcp(&self, guest_port: u16) -> Result<StdTcpStream, SocketIngressError> {
        self.connect_tcp_with_timeout(guest_port, DEFAULT_INGRESS_TIMEOUT)
    }

    /// Equivalent to [`Self::connect_tcp`] with an explicit bounded offer lifetime.
    ///
    /// # Errors
    ///
    /// Returns the same bounded errors as [`Self::connect_tcp`].
    pub fn connect_tcp_with_timeout(
        &self,
        guest_port: u16,
        timeout: Duration,
    ) -> Result<StdTcpStream, SocketIngressError> {
        let (host, injected) = private_tcp_pair()?;
        self.inject_tcp_with_timeout(injected, guest_port, timeout)?;
        Ok(host)
    }

    /// Async equivalent of [`Self::connect_tcp`].
    ///
    /// Submission is immediate and awaiting the guest acknowledgement does not
    /// occupy an executor worker thread.
    ///
    /// # Errors
    ///
    /// Returns the same bounded errors as [`Self::connect_tcp`].
    pub async fn connect_tcp_async(
        &self,
        guest_port: u16,
    ) -> Result<StdTcpStream, SocketIngressError> {
        self.connect_tcp_with_timeout_async(guest_port, DEFAULT_INGRESS_TIMEOUT)
            .await
    }

    /// Async equivalent of [`Self::connect_tcp_with_timeout`].
    ///
    /// # Errors
    ///
    /// Returns the same bounded errors as [`Self::connect_tcp_with_timeout`].
    pub async fn connect_tcp_with_timeout_async(
        &self,
        guest_port: u16,
        timeout: Duration,
    ) -> Result<StdTcpStream, SocketIngressError> {
        let (host, injected) = private_tcp_pair()?;
        self.inject_tcp_with_timeout_async(injected, guest_port, timeout)
            .await?;
        Ok(host)
    }

    /// Offers one connected IPv4 TCP stream to `127.0.0.1:guest_port` and
    /// returns after the guest has atomically queued it on a listener.
    ///
    /// The stream is not registered in the host reactor until guest
    /// `accept(2)` allocates a child capability. At most 32 offers exist per
    /// clone, and an unaccepted offer expires after five seconds.
    ///
    /// # Errors
    ///
    /// Returns a bounded validation, capacity, listener, timeout, or worker
    /// error. Ownership of `stream` is consumed on every outcome.
    pub fn inject_tcp(
        &self,
        stream: StdTcpStream,
        guest_port: u16,
    ) -> Result<(), SocketIngressError> {
        self.inject_tcp_with_timeout(stream, guest_port, DEFAULT_INGRESS_TIMEOUT)
    }

    /// Equivalent to [`Self::inject_tcp`] with an explicit bounded offer lifetime.
    ///
    /// # Errors
    ///
    /// Returns the same bounded errors as [`Self::inject_tcp`].
    pub fn inject_tcp_with_timeout(
        &self,
        stream: StdTcpStream,
        guest_port: u16,
        timeout: Duration,
    ) -> Result<(), SocketIngressError> {
        self.begin_inject_tcp_with_timeout(stream, guest_port, timeout)?
            .wait_timeout(timeout.saturating_add(Duration::from_millis(100)))
    }

    /// Async equivalent of [`Self::inject_tcp`].
    ///
    /// # Errors
    ///
    /// Returns the same bounded errors as [`Self::inject_tcp`].
    pub async fn inject_tcp_async(
        &self,
        stream: StdTcpStream,
        guest_port: u16,
    ) -> Result<(), SocketIngressError> {
        self.begin_inject_tcp(stream, guest_port)?.await
    }

    /// Async equivalent of [`Self::inject_tcp_with_timeout`].
    ///
    /// # Errors
    ///
    /// Returns the same bounded errors as [`Self::inject_tcp_with_timeout`].
    pub async fn inject_tcp_with_timeout_async(
        &self,
        stream: StdTcpStream,
        guest_port: u16,
        timeout: Duration,
    ) -> Result<(), SocketIngressError> {
        self.begin_inject_tcp_with_timeout(stream, guest_port, timeout)?
            .await
    }

    /// Immediately submits one bounded offer and returns its completion future.
    ///
    /// No thread waits for the guest. The clone-local broker owns the deadline,
    /// and an unresponsive guest cannot retain more than 32 offers.
    ///
    /// # Errors
    ///
    /// Returns before submission for validation, capacity, or stopped-worker
    /// failures. Listener rejection and deadline expiry complete the returned
    /// operation.
    pub fn begin_inject_tcp(
        &self,
        stream: StdTcpStream,
        guest_port: u16,
    ) -> Result<IngressOperation, SocketIngressError> {
        self.begin_inject_tcp_with_timeout(stream, guest_port, DEFAULT_INGRESS_TIMEOUT)
    }

    /// Equivalent to [`Self::begin_inject_tcp`] with an explicit offer lifetime.
    ///
    /// # Errors
    ///
    /// Returns the same immediate errors as [`Self::begin_inject_tcp`].
    pub fn begin_inject_tcp_with_timeout(
        &self,
        stream: StdTcpStream,
        guest_port: u16,
        timeout: Duration,
    ) -> Result<IngressOperation, SocketIngressError> {
        if self.stopping.load(Ordering::Acquire) {
            return Err(SocketIngressError::BrokerStopped);
        }
        if guest_port == 0 {
            return Err(SocketIngressError::InvalidPort);
        }
        let peer = match stream.peer_addr() {
            Ok(SocketAddr::V4(peer)) if peer.port() != 0 => peer,
            Ok(SocketAddr::V6(_) | SocketAddr::V4(_)) => {
                return Err(SocketIngressError::UnsupportedPeer);
            }
            Err(error) => return Err(SocketIngressError::InvalidStream(io_errno(&error))),
        };
        stream
            .set_nonblocking(true)
            .map_err(|error| SocketIngressError::InvalidStream(io_errno(&error)))?;
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or(SocketIngressError::TimedOut)?;
        let permit = IngressPermit::acquire(&self.in_flight, self.pending_limit)
            .ok_or(SocketIngressError::Capacity)?;
        let (reply, operation) = IngressReply::pair(Some(Arc::clone(&self.wake)));
        if self.stopping.load(Ordering::Acquire) {
            return Err(SocketIngressError::BrokerStopped);
        }
        match self.commands.try_send(HostCommand::Inject {
            stream,
            guest_port,
            peer,
            deadline,
            reply,
            permit,
        }) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => return Err(SocketIngressError::Capacity),
            Err(TrySendError::Disconnected(_)) => return Err(SocketIngressError::BrokerStopped),
        }
        self.wake
            .wake()
            .map_err(|_| SocketIngressError::BrokerStopped)?;
        Ok(operation)
    }
}

fn private_tcp_pair() -> Result<(StdTcpStream, StdTcpStream), SocketIngressError> {
    let listener = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| SocketIngressError::HostIo(io_errno(&error)))?;
    let address = listener
        .local_addr()
        .map_err(|error| SocketIngressError::HostIo(io_errno(&error)))?;
    let host = StdTcpStream::connect(address)
        .map_err(|error| SocketIngressError::HostIo(io_errno(&error)))?;
    let (injected, _) = listener
        .accept()
        .map_err(|error| SocketIngressError::HostIo(io_errno(&error)))?;
    Ok((host, injected))
}

impl Drop for BrokerHandle {
    fn drop(&mut self) {
        let _ = self.stop_and_join();
    }
}

struct PendingTx {
    capability: Capability,
    slot: u16,
    sequence: u32,
    payload: PendingTxPayload,
    sent: usize,
}

enum PendingTxPayload {
    Private(Vec<u8>),
    Shared { offset: u32, length: u32 },
}

#[derive(Clone, Copy)]
struct PendingClose {
    command: Command,
    transport_shutdown: bool,
    errno: i32,
}

#[derive(Clone, Copy)]
struct PendingShutdown {
    command: Command,
    how: u32,
}

struct Connection {
    stream: TcpStream,
    poll_token: Token,
    capability: Capability,
    connect_sequence: u32,
    connect_slot: u16,
    connected: bool,
    pending_tx: VecDeque<PendingTx>,
    rx_inflight: usize,
    rx_eof: bool,
    tx_shutdown: bool,
    pending_shutdown: Option<PendingShutdown>,
    closing: Option<PendingClose>,
}

struct PendingIngress {
    id: PendingIngressId,
    stream: StdTcpStream,
    target: SocketAddrV4,
    peer: SocketAddrV4,
    deadline: Instant,
    reply: Option<IngressReply>,
    cancellation: Arc<IngressCompletion>,
    queued: bool,
    _permit: IngressPermit,
}

fn send_pending_tx(
    ring: &HostRing,
    connection: &mut Connection,
    maximum: usize,
) -> io::Result<usize> {
    let pending = connection.pending_tx.front().expect("pending TX checked");
    match &pending.payload {
        PendingTxPayload::Private(bytes) => {
            let end = pending.sent.saturating_add(maximum).min(bytes.len());
            connection.stream.write(&bytes[pending.sent..end])
        }
        PendingTxPayload::Shared { offset, length } => {
            let sent = u32::try_from(pending.sent)
                .map_err(|_| io::Error::other("TCP TX progress exceeded fixed range"))?;
            let remaining = length
                .checked_sub(sent)
                .ok_or_else(|| io::Error::other("TCP TX progress exceeded fixed range"))?
                .min(u32::try_from(maximum).unwrap_or(u32::MAX));
            let offset = offset
                .checked_add(sent)
                .ok_or_else(|| io::Error::other("TCP TX offset overflow"))?;
            let source = ring
                .tx_source(pending.slot, offset, remaining)
                .map_err(ring_io_error)?;
            // The mailbox state retains host ownership until the complete range
            // is accepted. The guest may still mutate opaque TCP payload.
            // SAFETY: `tx_source` bounds one live G2H slot; no Rust reference is
            // formed, and policy-bearing endpoint/DNS bytes use private copies.
            let result = unsafe {
                libc::send(
                    connection.stream.as_raw_fd(),
                    source.cast(),
                    usize::try_from(remaining).expect("u32 fits usize"),
                    libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
                )
            };
            if result < 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(usize::try_from(result).expect("nonnegative ssize_t fits usize"))
            }
        }
    }
}

fn receive_into_slot(
    ring: &HostRing,
    connection: &Connection,
    slot: u16,
    capacity: usize,
) -> io::Result<isize> {
    let destination = ring.rx_destination(slot).map_err(ring_io_error)?;
    // SAFETY: The caller reserves the complete fixed slot before invoking
    // this helper. H2G is host-writable and guest-read-only, and no Rust slice
    // or reference aliases the syscall destination.
    Ok(unsafe {
        libc::recv(
            connection.stream.as_raw_fd(),
            destination.cast(),
            capacity,
            libc::MSG_DONTWAIT,
        )
    })
}

struct PendingDnsQuery {
    capability: Capability,
    slot: u16,
    sequence: u32,
    transaction_id: u16,
    bytes: Vec<u8>,
}

struct DnsConnection {
    socket: UdpSocket,
    poll_token: Token,
    capability: Capability,
    resolver: SocketAddrV4,
    pending_tx: VecDeque<PendingDnsQuery>,
    outstanding_ids: VecDeque<u16>,
    rx_inflight: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RxBlock {
    GlobalCredit,
    ConnectionCredit,
    Bandwidth,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TxBlock {
    Bandwidth,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct Readiness {
    readable: bool,
    writable: bool,
    queued: bool,
    tx_block: Option<TxBlock>,
    rx_block: Option<RxBlock>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum IoProgress {
    Idle,
    WouldBlock,
    Continue,
    TxBandwidthBlocked,
    RxBlocked(RxBlock),
}

fn dns_transaction_available(connection: &DnsConnection, transaction_id: u16) -> bool {
    connection.pending_tx.len() + connection.outstanding_ids.len() < MAX_DNS_OUTSTANDING
        && !connection
            .pending_tx
            .iter()
            .any(|pending| pending.transaction_id == transaction_id)
        && !connection.outstanding_ids.contains(&transaction_id)
}

struct BrokerLoop {
    poll: Poll,
    events: Events,
    ring: HostRing,
    irq: Arc<dyn GuestNotifier>,
    tcp_policy: Arc<dyn ConnectPolicy>,
    dns_policy: Arc<dyn DnsPolicy>,
    host_dns_resolver: Option<Ipv4Addr>,
    state: State,
    connections: Vec<Option<Connection>>,
    dns_connections: Vec<Option<DnsConnection>>,
    registrations: HashMap<usize, Capability>,
    next_registration_token: usize,
    readiness: Vec<Readiness>,
    ready_queue: VecDeque<Capability>,
    global_rx_waiters: VecDeque<Capability>,
    connection_rx_waiters: VecDeque<Capability>,
    tx_bandwidth_waiters: VecDeque<Capability>,
    rx_bandwidth_waiters: VecDeque<Capability>,
    rx_free: [bool; SLOT_COUNT],
    pending_events: VecDeque<Event>,
    request_credit_irq_pending: bool,
    stats: Arc<BrokerStatsAtomic>,
    host_commands: Receiver<HostCommand>,
    pending_ingress: Vec<Option<PendingIngress>>,
    pending_ingress_count: usize,
    ingress_generation: [u64; INGRESS_SLOTS],
    quotas: SocketQuotas,
    egress_bandwidth: TokenBucket,
    ingress_bandwidth: TokenBucket,
}

struct BrokerConfiguration {
    tcp_policy: Arc<dyn ConnectPolicy>,
    dns_policy: Arc<dyn DnsPolicy>,
    quotas: SocketQuotas,
}

impl BrokerLoop {
    #[cfg(test)]
    fn new(
        poll: Poll,
        memory: ServiceMemory,
        irq: Arc<dyn GuestNotifier>,
        tcp_policy: Arc<dyn ConnectPolicy>,
        dns_policy: Arc<dyn DnsPolicy>,
    ) -> io::Result<Self> {
        let (_host_commands, host_command_rx) = sync_channel(HOST_COMMAND_CAPACITY);
        Self::new_with_stats(
            poll,
            memory,
            irq,
            BrokerConfiguration {
                tcp_policy,
                dns_policy,
                quotas: SocketQuotas::default(),
            },
            Arc::new(BrokerStatsAtomic::default()),
            host_command_rx,
        )
    }

    #[cfg(test)]
    fn new_with_quotas(
        poll: Poll,
        memory: ServiceMemory,
        irq: Arc<dyn GuestNotifier>,
        tcp_policy: Arc<dyn ConnectPolicy>,
        dns_policy: Arc<dyn DnsPolicy>,
        quotas: SocketQuotas,
    ) -> io::Result<Self> {
        let (_host_commands, host_command_rx) = sync_channel(HOST_COMMAND_CAPACITY);
        Self::new_with_stats(
            poll,
            memory,
            irq,
            BrokerConfiguration {
                tcp_policy,
                dns_policy,
                quotas: quotas.validate().map_err(io::Error::other)?,
            },
            Arc::new(BrokerStatsAtomic::default()),
            host_command_rx,
        )
    }

    fn new_with_stats(
        poll: Poll,
        memory: ServiceMemory,
        irq: Arc<dyn GuestNotifier>,
        configuration: BrokerConfiguration,
        stats: Arc<BrokerStatsAtomic>,
        host_commands: Receiver<HostCommand>,
    ) -> io::Result<Self> {
        let BrokerConfiguration {
            tcp_policy,
            dns_policy,
            quotas,
        } = configuration;
        let session = memory.session();
        let limits = Limits {
            slot_size: SLOT_SIZE_U32,
            max_stream_tx_bytes: STREAM_WINDOW_U32,
            max_stream_rx_bytes: STREAM_WINDOW_U32,
        };
        Ok(Self {
            poll,
            events: Events::with_capacity(128),
            ring: HostRing::new(memory).map_err(ring_io_error)?,
            irq,
            tcp_policy,
            dns_policy,
            host_dns_resolver: system_dns_resolver(),
            state: State::new_in_session(limits, session).map_err(state_io_error)?,
            connections: (0..CAPABILITY_COUNT).map(|_| None).collect(),
            dns_connections: (0..CAPABILITY_COUNT).map(|_| None).collect(),
            registrations: HashMap::with_capacity(CAPABILITY_COUNT),
            next_registration_token: 1,
            readiness: vec![Readiness::default(); CAPABILITY_COUNT],
            ready_queue: VecDeque::new(),
            global_rx_waiters: VecDeque::new(),
            connection_rx_waiters: VecDeque::new(),
            tx_bandwidth_waiters: VecDeque::new(),
            rx_bandwidth_waiters: VecDeque::new(),
            rx_free: [true; SLOT_COUNT],
            pending_events: VecDeque::new(),
            request_credit_irq_pending: false,
            stats,
            host_commands,
            pending_ingress: (0..INGRESS_SLOTS).map(|_| None).collect(),
            pending_ingress_count: 0,
            ingress_generation: [1; INGRESS_SLOTS],
            quotas,
            egress_bandwidth: TokenBucket::new(quotas.egress_bandwidth),
            ingress_bandwidth: TokenBucket::new(quotas.ingress_bandwidth),
        })
    }

    fn run(&mut self, wake: &Waker, stopping: &AtomicBool) -> io::Result<()> {
        while !stopping.load(Ordering::Acquire) {
            self.cancel_detached_ingress()?;
            self.expire_ingress()?;
            self.flush_events()?;
            self.resume_global_rx_waiters();
            self.resume_bandwidth_waiters();
            let timeout = if !self.ready_queue.is_empty() && self.can_service_ready() {
                Some(Duration::ZERO)
            } else {
                minimum_timeout(self.next_ingress_timeout(), self.next_bandwidth_timeout())
            };
            self.poll.poll(&mut self.events, timeout)?;
            self.stats.poll_wakeups.fetch_add(1, Ordering::Relaxed);
            let ready: Vec<_> = self
                .events
                .iter()
                .map(|event| {
                    (
                        event.token(),
                        event.is_readable() || event.is_read_closed(),
                        event.is_writable() || event.is_write_closed(),
                    )
                })
                .collect();
            for (token, readable, writable) in ready {
                if token == WAKE_TOKEN {
                    let host_more = self.drain_host_commands()?;
                    if self.drain_requests()? || host_more {
                        wake.wake()?;
                    }
                } else {
                    self.mark_socket_ready(token, readable, writable);
                }
            }
            let turns = self.service_ready_queue(READY_TURN_BUDGET)?;
            self.stats
                .reactor_turns
                .fetch_add(turns as u64, Ordering::Relaxed);
            self.flush_events()?;
        }
        Ok(())
    }

    fn drain_host_commands(&mut self) -> io::Result<bool> {
        let mut drained = 0;
        while drained < HOST_COMMAND_BUDGET {
            match self.host_commands.try_recv() {
                Ok(command) => {
                    self.handle_host_command(command)?;
                    drained += 1;
                }
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => return Ok(false),
            }
        }
        Ok(drained == HOST_COMMAND_BUDGET)
    }

    fn handle_host_command(&mut self, command: HostCommand) -> io::Result<()> {
        match command {
            HostCommand::Inject {
                stream,
                guest_port,
                peer,
                deadline,
                reply,
                permit,
            } => self.stage_ingress(stream, guest_port, peer, deadline, reply, permit),
        }
    }

    fn stage_ingress(
        &mut self,
        stream: StdTcpStream,
        guest_port: u16,
        peer: SocketAddrV4,
        deadline: Instant,
        reply: IngressReply,
        permit: IngressPermit,
    ) -> io::Result<()> {
        if reply.0.is_cancelled() {
            return Ok(());
        }
        if deadline <= Instant::now() {
            reply.send(Err(SocketIngressError::TimedOut));
            return Ok(());
        }
        // One slot publishes the offer; one remains reserved for a cancel if
        // the guest never acknowledges it. Host commands fail fast instead of
        // waiting behind a guest-controlled completion backlog.
        if self.event_headroom() < 2 {
            reply.send(Err(SocketIngressError::Capacity));
            return Ok(());
        }
        let Some(index) = self
            .pending_ingress
            .iter()
            .enumerate()
            .find_map(|(index, pending)| {
                (pending.is_none() && self.ingress_generation[index] != 0).then_some(index)
            })
        else {
            reply.send(Err(SocketIngressError::Capacity));
            return Ok(());
        };
        let id = PendingIngressId {
            index: u32::try_from(index).expect("fixed ingress index fits u32"),
            generation: self.ingress_generation[index],
        };
        let target = SocketAddrV4::new(Ipv4Addr::LOCALHOST, guest_port);
        let cancellation = Arc::clone(&reply.0);
        self.pending_ingress[index] = Some(PendingIngress {
            id,
            stream,
            target,
            peer,
            deadline,
            reply: Some(reply),
            cancellation,
            queued: false,
            _permit: permit,
        });
        self.pending_ingress_count += 1;
        self.queue_event(Event::ingress_offer(self.ring.session(), id, target, peer))
    }

    fn cancel_detached_ingress(&mut self) -> io::Result<()> {
        let cancelled: Vec<_> = self
            .pending_ingress
            .iter()
            .flatten()
            .filter(|pending| pending.cancellation.is_cancelled())
            .map(|pending| pending.id)
            .collect();
        for id in cancelled {
            let Some(pending) = self.take_pending_ingress(id) else {
                continue;
            };
            self.queue_event(Event::ingress_cancel(self.ring.session(), id))?;
            drop(pending);
        }
        Ok(())
    }

    fn pending_ingress_matches(&self, id: PendingIngressId) -> bool {
        self.pending_ingress
            .get(id.index as usize)
            .and_then(Option::as_ref)
            .is_some_and(|pending| pending.id == id)
    }

    fn take_pending_ingress(&mut self, id: PendingIngressId) -> Option<PendingIngress> {
        let index = usize::try_from(id.index).ok()?;
        if !self.pending_ingress_matches(id) {
            return None;
        }
        let pending = self.pending_ingress[index].take()?;
        self.pending_ingress_count = self
            .pending_ingress_count
            .checked_sub(1)
            .expect("pending ingress count tracks occupied entries");
        self.ingress_generation[index] = pending.id.generation.checked_add(1).unwrap_or(0);
        Some(pending)
    }

    fn ingress_ack(&mut self, id: PendingIngressId) -> io::Result<()> {
        if self
            .pending_ingress
            .get(id.index as usize)
            .and_then(Option::as_ref)
            .is_some_and(|pending| pending.id == id && pending.deadline <= Instant::now())
        {
            let mut pending = self
                .take_pending_ingress(id)
                .expect("matching pending ingress checked");
            if let Some(reply) = pending.reply.take() {
                reply.send(Err(SocketIngressError::TimedOut));
            }
            return self.queue_event(Event::ingress_cancel(self.ring.session(), id));
        }
        let Some(pending) = self
            .pending_ingress
            .get_mut(id.index as usize)
            .and_then(Option::as_mut)
            .filter(|pending| pending.id == id)
        else {
            return Ok(());
        };
        if pending.queued {
            return Ok(());
        }
        pending.queued = true;
        if let Some(reply) = pending.reply.take() {
            reply.send(Ok(()));
        }
        Ok(())
    }

    fn ingress_reject(&mut self, id: PendingIngressId) {
        let Some(mut pending) = self.take_pending_ingress(id) else {
            return;
        };
        if let Some(reply) = pending.reply.take() {
            reply.send(Err(SocketIngressError::Rejected));
        }
    }

    fn expire_ingress(&mut self) -> io::Result<()> {
        let now = Instant::now();
        let expired: Vec<_> = self
            .pending_ingress
            .iter()
            .flatten()
            .filter(|pending| pending.deadline <= now)
            .map(|pending| pending.id)
            .collect();
        for id in expired {
            let Some(mut pending) = self.take_pending_ingress(id) else {
                continue;
            };
            if let Some(reply) = pending.reply.take() {
                reply.send(Err(SocketIngressError::TimedOut));
            }
            self.queue_event(Event::ingress_cancel(self.ring.session(), id))?;
        }
        Ok(())
    }

    fn next_ingress_timeout(&self) -> Option<Duration> {
        let now = Instant::now();
        self.pending_ingress
            .iter()
            .flatten()
            .map(|pending| pending.deadline.saturating_duration_since(now))
            .min()
    }

    fn drain_requests(&mut self) -> io::Result<bool> {
        let budget = DRAIN_BUDGET.min(self.event_headroom() / MAX_EVENTS_PER_COMMAND);
        if budget == 0 {
            return Ok(false);
        }
        let batch = self.ring.drain(budget).map_err(ring_io_error)?;
        let count = batch.requests.len();
        self.stats
            .commands_drained
            .fetch_add(count as u64, Ordering::Relaxed);
        self.request_credit_irq_pending |= batch.notify_guest;
        for request in batch.requests {
            match request {
                Ok(command) => self.handle_command(command)?,
                Err(_) => self.queue_event(Event {
                    kind: EventKind::Error,
                    capability: Capability {
                        index: 0,
                        generation: 1,
                        session: self.ring.session(),
                    },
                    slot: 0,
                    status: -libc::EPROTO,
                    length: 0,
                    sequence: 0,
                })?,
            }
        }
        self.ring.arm_request_notification().map_err(ring_io_error)
    }

    fn handle_command(&mut self, command: Command) -> io::Result<()> {
        match command.kind {
            CommandKind::Connect { slot, length } => self.connect(command, slot, length),
            CommandKind::Tx {
                slot,
                offset,
                length,
            } => self.submit_tx(command, slot, offset, length),
            CommandKind::RxRelease { slot } => self.release_rx(command, slot),
            CommandKind::Shutdown { how } => self.shutdown_stream(command, how),
            CommandKind::Close => self.request_stream_close(command),
            CommandKind::DnsQuery { slot, length } => self.submit_dns(command, slot, length),
            CommandKind::IngressAck => self.ingress_ack(PendingIngressId {
                index: command.capability.index,
                generation: command.capability.generation,
            }),
            CommandKind::IngressReject => {
                self.ingress_reject(PendingIngressId {
                    index: command.capability.index,
                    generation: command.capability.generation,
                });
                Ok(())
            }
            CommandKind::IngressAccept {
                pending_index,
                pending_generation,
            } => self.accept_ingress(command, pending_index, pending_generation),
        }
    }

    fn accept_ingress(
        &mut self,
        command: Command,
        pending_index: u16,
        pending_generation: u64,
    ) -> io::Result<()> {
        let id = PendingIngressId {
            index: u32::from(pending_index),
            generation: pending_generation,
        };
        let Some(pending) = self
            .pending_ingress
            .get(id.index as usize)
            .and_then(Option::as_ref)
            .filter(|pending| pending.id == id && pending.queued)
        else {
            return self.queue_error(command, libc::ESTALE);
        };
        debug_assert_eq!(pending.target.ip(), &Ipv4Addr::LOCALHOST);
        debug_assert_ne!(pending.peer.port(), 0);
        let index = command.capability.index as usize;
        if index >= self.connections.len()
            || self.connections[index].is_some()
            || self.dns_connections[index].is_some()
        {
            return self.queue_error(command, libc::EALREADY);
        }
        if self.active_socket_fds() >= self.quotas.active_socket_fds {
            return self.queue_error(command, libc::EMFILE);
        }
        let capability = match self.state.open_capability(command.capability.index) {
            Ok(capability) => capability,
            Err(error) => return self.queue_error(command, mailbox_errno(error)),
        };
        if capability != command.capability {
            let _ = self.state.close_capability(capability);
            return self.queue_error(command, libc::ESTALE);
        }
        let Some(pending) = self.take_pending_ingress(id) else {
            let _ = self.state.close_capability(capability);
            return self.queue_error(command, libc::ESTALE);
        };
        let mut stream = TcpStream::from_std(pending.stream);
        let poll_token = match self.allocate_registration_token() {
            Ok(token) => token,
            Err(errno) => {
                let _ = self.state.close_capability(capability);
                return self.queue_error(command, errno);
            }
        };
        if let Err(error) = self.poll.registry().register(
            &mut stream,
            poll_token,
            Interest::READABLE | Interest::WRITABLE,
        ) {
            let _ = self.state.close_capability(capability);
            return self.queue_error(command, io_errno(&error));
        }
        self.registrations.insert(poll_token.0, capability);
        self.connections[index] = Some(Connection {
            stream,
            poll_token,
            capability,
            connect_sequence: command.sequence,
            connect_slot: 0,
            connected: true,
            pending_tx: VecDeque::new(),
            rx_inflight: 0,
            rx_eof: false,
            tx_shutdown: false,
            pending_shutdown: None,
            closing: None,
        });
        self.readiness[index] = Readiness::default();
        self.queue_event(Event {
            kind: EventKind::IngressAccepted,
            capability,
            slot: 0,
            status: 0,
            length: 0,
            sequence: command.sequence,
        })
    }

    fn connect(&mut self, command: Command, slot: u16, length: u32) -> io::Result<()> {
        let mut opened = None;
        let result = (|| {
            if self
                .connections
                .get(command.capability.index as usize)
                .and_then(Option::as_ref)
                .is_some()
                || self
                    .dns_connections
                    .get(command.capability.index as usize)
                    .and_then(Option::as_ref)
                    .is_some()
            {
                return Err(libc::EALREADY);
            }
            if self.active_socket_fds() >= self.quotas.active_socket_fds {
                return Err(libc::EMFILE);
            }
            let capability = self
                .state
                .open_capability(command.capability.index)
                .map_err(mailbox_errno)?;
            opened = Some(capability);
            if capability != command.capability {
                let _ = self.state.close_capability(capability);
                return Err(libc::ESTALE);
            }
            let endpoint_bytes = self
                .ring
                .copy_tx(slot, 0, length)
                .map_err(|_| libc::EINVAL)?;
            let endpoint = Endpoint::decode(&endpoint_bytes)?;
            let destination = SocketAddr::from(endpoint);
            if !self.tcp_policy.authorize(destination) {
                return Err(libc::EACCES);
            }
            let mut stream =
                TcpStream::connect(tcp_upstream(destination)).map_err(|error| io_errno(&error))?;
            let poll_token = self.allocate_registration_token()?;
            self.poll
                .registry()
                .register(
                    &mut stream,
                    poll_token,
                    Interest::READABLE | Interest::WRITABLE,
                )
                .map_err(|error| io_errno(&error))?;
            self.registrations.insert(poll_token.0, capability);
            self.connections[capability.index as usize] = Some(Connection {
                stream,
                poll_token,
                capability,
                connect_sequence: command.sequence,
                connect_slot: slot,
                connected: false,
                pending_tx: VecDeque::new(),
                rx_inflight: 0,
                rx_eof: false,
                tx_shutdown: false,
                pending_shutdown: None,
                closing: None,
            });
            self.readiness[capability.index as usize] = Readiness::default();
            Ok(())
        })();
        if let Err(errno) = result {
            if let Some(capability) = opened
                && self.connections[capability.index as usize].is_none()
                && self.dns_connections[capability.index as usize].is_none()
            {
                let _ = self.state.close_capability(capability);
            }
            self.queue_error(command, errno)?;
        }
        Ok(())
    }

    fn submit_tx(
        &mut self,
        command: Command,
        slot: u16,
        offset: u32,
        length: u32,
    ) -> io::Result<()> {
        let index = command.capability.index as usize;
        let Some(connection) = self.connections.get(index).and_then(Option::as_ref) else {
            return self.queue_error(command, libc::ENOTCONN);
        };
        if connection.capability != command.capability || !connection.connected {
            return self.queue_error(command, libc::ENOTCONN);
        }
        if connection.closing.is_some()
            || connection.tx_shutdown
            || connection.pending_shutdown.is_some()
        {
            return self.queue_error(command, libc::EPIPE);
        }
        if connection.pending_tx.len() >= PER_CONNECTION_SLOTS {
            return self.queue_error(command, libc::ENOBUFS);
        }
        let payload = if length <= TCP_PRIVATE_COPY_MAX {
            let Ok(bytes) = self.ring.copy_tx(slot, offset, length) else {
                return self.queue_error(command, libc::EINVAL);
            };
            PendingTxPayload::Private(bytes)
        } else {
            if self.ring.tx_source(slot, offset, length).is_err() {
                return self.queue_error(command, libc::EINVAL);
            }
            PendingTxPayload::Shared { offset, length }
        };
        if let Err(error) = self
            .state
            .submit_tx(command.capability, slot, offset, length)
        {
            return self.queue_error(command, mailbox_errno(error));
        }
        self.connections[index]
            .as_mut()
            .expect("connection checked above")
            .pending_tx
            .push_back(PendingTx {
                capability: command.capability,
                slot,
                sequence: command.sequence,
                payload,
                sent: 0,
            });
        self.enqueue_if_runnable(command.capability);
        Ok(())
    }

    #[allow(clippy::too_many_lines)]
    fn submit_dns(&mut self, command: Command, slot: u16, length: u32) -> io::Result<()> {
        let index = command.capability.index as usize;
        let mut opened = None;
        let result = (|| {
            if index >= self.dns_connections.len() || self.connections[index].is_some() {
                return Err(libc::EPROTOTYPE);
            }
            if self.dns_connections[index].is_none() {
                if self.active_socket_fds() >= self.quotas.active_socket_fds {
                    return Err(libc::EMFILE);
                }
                let capability = self
                    .state
                    .open_capability(command.capability.index)
                    .map_err(mailbox_errno)?;
                opened = Some(capability);
                if capability != command.capability {
                    let _ = self.state.close_capability(capability);
                    return Err(libc::ESTALE);
                }
                if self.dns_connections.iter().flatten().count() >= MAX_DNS_CONNECTIONS {
                    return Err(libc::EMFILE);
                }
            }
            let endpoint_bytes = self
                .ring
                .copy_tx(slot, 0, ENDPOINT_SIZE_U32)
                .map_err(|_| libc::EINVAL)?;
            let endpoint = Endpoint::decode(&endpoint_bytes)?;
            let resolver = endpoint.socket_addr();
            if resolver.port() != 53 || !self.dns_policy.authorize_resolver(*resolver.ip()) {
                return Err(libc::EACCES);
            }
            let query = self
                .ring
                .copy_tx(slot, ENDPOINT_SIZE_U32, length)
                .map_err(|_| libc::EINVAL)?;
            let transaction_id = validate_query(&query)?;

            if self.dns_connections[index].is_none() {
                let capability = opened.expect("new DNS capability opened above");
                let socket = StdUdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
                    .map_err(|error| io_errno(&error))?;
                let upstream = SocketAddrV4::new(
                    dns_upstream(*resolver.ip(), self.host_dns_resolver),
                    resolver.port(),
                );
                socket.connect(upstream).map_err(|error| io_errno(&error))?;
                socket
                    .set_nonblocking(true)
                    .map_err(|error| io_errno(&error))?;
                let mut socket = UdpSocket::from_std(socket);
                let poll_token = self.allocate_registration_token()?;
                self.poll
                    .registry()
                    .register(
                        &mut socket,
                        poll_token,
                        Interest::READABLE | Interest::WRITABLE,
                    )
                    .map_err(|error| io_errno(&error))?;
                self.registrations.insert(poll_token.0, capability);
                self.dns_connections[index] = Some(DnsConnection {
                    socket,
                    poll_token,
                    capability,
                    resolver,
                    pending_tx: VecDeque::new(),
                    outstanding_ids: VecDeque::new(),
                    rx_inflight: 0,
                });
                self.readiness[index] = Readiness::default();
            }

            let connection = self.dns_connections[index]
                .as_ref()
                .expect("DNS connection created above");
            if connection.capability != command.capability {
                return Err(libc::ESTALE);
            }
            if connection.resolver != resolver {
                return Err(libc::EISCONN);
            }
            if !dns_transaction_available(connection, transaction_id) {
                return Err(libc::EBUSY);
            }
            if connection.pending_tx.len() >= PER_CONNECTION_SLOTS {
                return Err(libc::ENOBUFS);
            }
            self.state
                .submit_tx(command.capability, slot, ENDPOINT_SIZE_U32, length)
                .map_err(mailbox_errno)?;
            self.dns_connections[index]
                .as_mut()
                .expect("DNS connection checked")
                .pending_tx
                .push_back(PendingDnsQuery {
                    capability: command.capability,
                    slot,
                    sequence: command.sequence,
                    transaction_id,
                    bytes: query,
                });
            Ok(())
        })();

        if let Err(errno) = result {
            if let Some(capability) = opened
                && self.dns_connections[index].is_none()
            {
                let _ = self.state.close_capability(capability);
            }
            self.queue_error(command, errno)?;
            return Ok(());
        }
        self.enqueue_if_runnable(command.capability);
        Ok(())
    }

    fn flush_dns(&mut self, index: usize) -> io::Result<IoProgress> {
        for _ in 0..SOCKET_IO_QUANTUM {
            let send_result = {
                let connection = self.dns_connections[index]
                    .as_mut()
                    .expect("DNS connection exists");
                let Some(pending) = connection.pending_tx.front() else {
                    return Ok(IoProgress::Idle);
                };
                connection.socket.send(&pending.bytes)
            };
            match send_result {
                Ok(bytes) => {
                    self.stats
                        .tx_bytes
                        .fetch_add(bytes as u64, Ordering::Relaxed);
                    let pending = self.dns_connections[index]
                        .as_mut()
                        .expect("DNS connection exists")
                        .pending_tx
                        .pop_front()
                        .expect("pending query exists");
                    if bytes != pending.bytes.len() {
                        self.state
                            .cancel_tx(pending.capability, pending.slot)
                            .map_err(state_io_error)?;
                        self.queue_event(Event {
                            kind: EventKind::Error,
                            capability: pending.capability,
                            slot: pending.slot,
                            status: -libc::EIO,
                            length: Opcode::DnsQuery as u32,
                            sequence: pending.sequence,
                        })?;
                        continue;
                    }
                    let completed = u32::try_from(bytes)
                        .map_err(|_| io::Error::other("DNS query exceeded fixed slot"))?;
                    if !matches!(
                        self.state
                            .complete_tx_progress(pending.capability, pending.slot, completed)
                            .map_err(state_io_error)?,
                        TxProgress::Complete
                    ) {
                        return Err(io::Error::other("UDP send completed partially"));
                    }
                    self.dns_connections[index]
                        .as_mut()
                        .expect("DNS connection exists")
                        .outstanding_ids
                        .push_back(pending.transaction_id);
                    self.queue_event(Event {
                        kind: EventKind::DnsTxComplete,
                        capability: pending.capability,
                        slot: pending.slot,
                        status: 0,
                        length: 0,
                        sequence: pending.sequence,
                    })?;
                    self.stats.tx_slots.fetch_add(1, Ordering::Relaxed);
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    return Ok(IoProgress::WouldBlock);
                }
                Err(error) => {
                    let errno = io_errno(&error);
                    self.close_stream(
                        Command {
                            sequence: 0,
                            capability: self.dns_connections[index]
                                .as_ref()
                                .expect("DNS connection exists")
                                .capability,
                            kind: CommandKind::Close,
                        },
                        errno,
                    )?;
                    return Ok(IoProgress::Idle);
                }
            }
        }
        Ok(
            if self.dns_connections[index]
                .as_ref()
                .is_some_and(|connection| connection.pending_tx.is_empty())
            {
                IoProgress::Idle
            } else {
                IoProgress::Continue
            },
        )
    }

    fn release_rx(&mut self, command: Command, slot: u16) -> io::Result<()> {
        let index = command.capability.index as usize;
        match self.state.release_rx(command.capability, slot) {
            Ok(()) => {
                if let Some(free) = self.rx_free.get_mut(usize::from(slot)) {
                    *free = true;
                    self.decrement_rx_inflight(command.capability);
                    let global = self.resume_global_rx_waiters();
                    self.resume_connection_rx_waiters(self.free_rx_slots() - global);
                    self.finish_drained_close(index)?;
                    Ok(())
                } else {
                    self.queue_error(command, libc::EINVAL)
                }
            }
            Err(error) => self.queue_error(command, mailbox_errno(error)),
        }
    }

    fn request_stream_close(&mut self, command: Command) -> io::Result<()> {
        let index = command.capability.index as usize;
        if self
            .connections
            .get(index)
            .and_then(Option::as_ref)
            .is_none()
            && self
                .dns_connections
                .get(index)
                .and_then(Option::as_ref)
                .is_some()
        {
            return self.close_dns(command, 0);
        }
        let Some(connection) = self.connections.get(index).and_then(Option::as_ref) else {
            return self.queue_error(command, libc::ENOTCONN);
        };
        if connection.capability != command.capability {
            return self.queue_error(command, libc::ESTALE);
        }
        if connection.closing.is_some() {
            return self.queue_error(command, libc::EALREADY);
        }
        self.state
            .close_capability(command.capability)
            .map_err(state_io_error)?;
        self.connections[index]
            .as_mut()
            .expect("connection checked above")
            .closing = Some(PendingClose {
            command,
            transport_shutdown: false,
            errno: 0,
        });
        self.readiness[index].readable = false;
        self.readiness[index].rx_block = None;
        if self.finish_drained_close(index)? {
            return Ok(());
        }
        self.enqueue_if_runnable(command.capability);
        Ok(())
    }

    fn finish_drained_close(&mut self, index: usize) -> io::Result<bool> {
        let Some((closing, tx_pending, shutdown_pending)) = self
            .connections
            .get(index)
            .and_then(Option::as_ref)
            .and_then(|connection| {
                connection.closing.map(|closing| {
                    (
                        closing,
                        !connection.pending_tx.is_empty(),
                        connection.pending_shutdown.is_some(),
                    )
                })
            })
        else {
            return Ok(false);
        };
        if tx_pending {
            return Ok(false);
        }
        if shutdown_pending {
            self.finish_pending_shutdown(index)?;
        }
        if !closing.transport_shutdown {
            let capability = self.connections[index]
                .as_ref()
                .expect("connection checked above")
                .capability;
            self.reset_readiness(capability);
            let connection = self.connections[index]
                .as_mut()
                .expect("connection checked above");
            self.registrations.remove(&connection.poll_token.0);
            let _ = self.poll.registry().deregister(&mut connection.stream);
            let _ = connection.stream.shutdown(Shutdown::Write);
            connection
                .closing
                .as_mut()
                .expect("close state checked above")
                .transport_shutdown = true;
        }
        if self
            .state
            .capability(closing.command.capability.index)
            .is_some()
        {
            return Ok(false);
        }
        self.connections[index].take();
        self.queue_event(Event {
            kind: EventKind::Closed,
            capability: closing.command.capability,
            slot: 0,
            status: -closing.errno,
            length: 0,
            sequence: closing.command.sequence,
        })?;
        Ok(true)
    }

    fn shutdown_stream(&mut self, command: Command, how: u32) -> io::Result<()> {
        if how > 2 {
            return self.queue_error(command, libc::EINVAL);
        }
        if self
            .dns_connections
            .get(command.capability.index as usize)
            .and_then(Option::as_ref)
            .is_some()
        {
            return self.queue_error(command, libc::EOPNOTSUPP);
        }
        let Some(connection) = self
            .connections
            .get(command.capability.index as usize)
            .and_then(Option::as_ref)
        else {
            return self.queue_error(command, libc::ENOTCONN);
        };
        if connection.capability != command.capability {
            return self.queue_error(command, libc::ESTALE);
        }
        if connection.closing.is_some() {
            return self.queue_error(command, libc::EPIPE);
        }
        if connection.pending_shutdown.is_some() {
            return self.queue_error(command, libc::EALREADY);
        }
        let index = command.capability.index as usize;
        if how == 0 {
            match self.connections[index]
                .as_ref()
                .expect("connection checked above")
                .stream
                .shutdown(Shutdown::Read)
            {
                Ok(()) => {
                    self.connections[index]
                        .as_mut()
                        .expect("connection checked above")
                        .rx_eof = true;
                    self.readiness[index].readable = false;
                    self.readiness[index].rx_block = None;
                    return self.queue_event(Event {
                        kind: EventKind::Shutdown,
                        capability: command.capability,
                        slot: 0,
                        status: 0,
                        length: how,
                        sequence: command.sequence,
                    });
                }
                Err(error) => return self.queue_error(command, io_errno(&error)),
            }
        }
        if self.connections[index]
            .as_ref()
            .expect("connection checked above")
            .tx_shutdown
        {
            return self.queue_event(Event {
                kind: EventKind::Shutdown,
                capability: command.capability,
                slot: 0,
                status: 0,
                length: how,
                sequence: command.sequence,
            });
        }
        if how == 2
            && let Err(error) = self.connections[index]
                .as_ref()
                .expect("connection checked above")
                .stream
                .shutdown(Shutdown::Read)
        {
            return self.queue_error(command, io_errno(&error));
        }
        if how == 2 {
            let connection = self.connections[index]
                .as_mut()
                .expect("connection checked above");
            connection.rx_eof = true;
            self.readiness[index].readable = false;
            self.readiness[index].rx_block = None;
        }
        self.connections[index]
            .as_mut()
            .expect("connection checked above")
            .pending_shutdown = Some(PendingShutdown { command, how });
        if self.connections[index]
            .as_ref()
            .expect("connection checked above")
            .pending_tx
            .is_empty()
        {
            self.finish_pending_shutdown(index)?;
        } else {
            self.enqueue_if_runnable(command.capability);
        }
        Ok(())
    }

    fn finish_pending_shutdown(&mut self, index: usize) -> io::Result<bool> {
        let Some(connection) = self.connections.get(index).and_then(Option::as_ref) else {
            return Ok(false);
        };
        let Some(pending) = connection.pending_shutdown else {
            return Ok(false);
        };
        if !connection.pending_tx.is_empty() {
            return Ok(false);
        }
        let result = connection.stream.shutdown(Shutdown::Write);
        self.connections[index]
            .as_mut()
            .expect("connection checked above")
            .pending_shutdown = None;
        match result {
            Ok(()) => {
                self.connections[index]
                    .as_mut()
                    .expect("connection checked above")
                    .tx_shutdown = true;
                self.queue_event(Event {
                    kind: EventKind::Shutdown,
                    capability: pending.command.capability,
                    slot: 0,
                    status: 0,
                    length: pending.how,
                    sequence: pending.command.sequence,
                })?;
            }
            Err(error) => self.queue_error(pending.command, io_errno(&error))?,
        }
        Ok(true)
    }

    fn close_stream(&mut self, command: Command, errno: i32) -> io::Result<()> {
        let index = command.capability.index as usize;
        if self
            .connections
            .get(index)
            .and_then(Option::as_ref)
            .is_none()
            && self
                .dns_connections
                .get(index)
                .and_then(Option::as_ref)
                .is_some()
        {
            return self.close_dns(command, errno);
        }
        let Some(mut connection) = self.connections.get_mut(index).and_then(Option::take) else {
            return self.queue_error(command, libc::ENOTCONN);
        };
        if connection.capability != command.capability {
            self.connections[index] = Some(connection);
            return self.queue_error(command, libc::ESTALE);
        }
        let close_command = connection
            .closing
            .map_or(command, |closing| closing.command);
        self.reset_readiness(command.capability);
        self.registrations.remove(&connection.poll_token.0);
        let _ = self.poll.registry().deregister(&mut connection.stream);
        while let Some(pending) = connection.pending_tx.pop_front() {
            let _ = self.state.cancel_tx(pending.capability, pending.slot);
            self.queue_event(Event {
                kind: EventKind::Error,
                capability: pending.capability,
                slot: pending.slot,
                status: -if errno == 0 { libc::ECANCELED } else { errno },
                length: Opcode::Tx as u32,
                sequence: pending.sequence,
            })?;
        }
        if connection.closing.is_none() {
            let _ = self.state.close_capability(command.capability);
        }
        if let Some(mut closing) = connection.closing
            && self.state.capability(command.capability.index).is_some()
        {
            closing.transport_shutdown = true;
            closing.errno = errno;
            connection.closing = Some(closing);
            let _ = connection.stream.shutdown(Shutdown::Both);
            self.connections[index] = Some(connection);
            return Ok(());
        }
        let (slot, sequence, failed_opcode) = if connection.connected {
            (0, close_command.sequence, 0)
        } else {
            (
                connection.connect_slot,
                connection.connect_sequence,
                Opcode::Connect as u32,
            )
        };
        self.queue_event(Event {
            kind: EventKind::Closed,
            capability: close_command.capability,
            slot,
            status: -errno,
            length: failed_opcode,
            sequence,
        })
    }

    fn close_dns(&mut self, command: Command, errno: i32) -> io::Result<()> {
        let index = command.capability.index as usize;
        let Some(mut connection) = self.dns_connections.get_mut(index).and_then(Option::take)
        else {
            return self.queue_error(command, libc::ENOTCONN);
        };
        if connection.capability != command.capability {
            self.dns_connections[index] = Some(connection);
            return self.queue_error(command, libc::ESTALE);
        }
        self.reset_readiness(command.capability);
        self.registrations.remove(&connection.poll_token.0);
        let _ = self.poll.registry().deregister(&mut connection.socket);
        for pending in connection.pending_tx {
            let _ = self.state.cancel_tx(pending.capability, pending.slot);
            self.queue_event(Event {
                kind: EventKind::Error,
                capability: pending.capability,
                slot: pending.slot,
                status: -if errno == 0 { libc::ECANCELED } else { errno },
                length: Opcode::DnsQuery as u32,
                sequence: pending.sequence,
            })?;
        }
        let _ = self.state.close_capability(command.capability);
        self.queue_event(Event {
            kind: EventKind::Closed,
            capability: command.capability,
            slot: 0,
            status: -errno,
            length: 0,
            sequence: command.sequence,
        })
    }

    fn mark_socket_ready(&mut self, token: Token, readable: bool, writable: bool) {
        let Some(capability) = self.registrations.get(&token.0).copied() else {
            return; /* stale event after deregistration */
        };
        let index = capability.index as usize;
        if self.current_capability(index) != Some(capability) {
            return;
        }
        let state = &mut self.readiness[index];
        state.readable |= readable;
        state.writable |= writable;
        self.enqueue_if_runnable(capability);
    }

    fn allocate_registration_token(&mut self) -> Result<Token, i32> {
        let token = self.next_registration_token;
        self.next_registration_token = token.checked_add(1).ok_or(libc::EOVERFLOW)?;
        if token == WAKE_TOKEN.0 || self.registrations.contains_key(&token) {
            return Err(libc::EOVERFLOW);
        }
        Ok(Token(token))
    }

    fn service_ready_queue(&mut self, budget: usize) -> io::Result<usize> {
        let mut serviced = 0;
        while serviced < budget && self.can_service_ready() {
            let Some(capability) = self.ready_queue.pop_front() else {
                break;
            };
            let index = capability.index as usize;
            if self.current_capability(index) != Some(capability) {
                continue;
            }
            self.readiness[index].queued = false;
            self.service_socket(capability)?;
            serviced += 1;
        }
        Ok(serviced)
    }

    fn event_headroom(&self) -> usize {
        MAX_PENDING_EVENTS.saturating_sub(
            self.pending_events
                .len()
                .saturating_add(self.pending_ingress_count),
        )
    }

    fn can_service_ready(&self) -> bool {
        self.event_headroom() >= MAX_EVENTS_PER_READY_TURN
    }

    fn service_socket(&mut self, capability: Capability) -> io::Result<()> {
        let index = capability.index as usize;
        let writable = self.readiness[index].writable;
        let readable = self.readiness[index].readable && self.readiness[index].rx_block.is_none();

        if self.connections[index].is_none() {
            if self.dns_connections[index].is_none() {
                return Ok(());
            }
            if writable {
                let progress = self.flush_dns(index)?;
                self.apply_write_progress(capability, progress);
            }
            if readable && self.dns_connections[index].is_some() {
                let progress = self.receive_dns(index)?;
                self.apply_read_progress(capability, progress);
            }
            return Ok(());
        }
        if writable {
            let connect_result = {
                let connection = self.connections[index].as_ref().expect("checked");
                if connection.connected {
                    None
                } else {
                    Some(connection.stream.take_error())
                }
            };
            if let Some(result) = connect_result {
                match result {
                    Ok(None) => {
                        let (capability, sequence, slot) = {
                            let connection =
                                self.connections[index].as_mut().expect("checked above");
                            connection.connected = true;
                            (
                                connection.capability,
                                connection.connect_sequence,
                                connection.connect_slot,
                            )
                        };
                        self.queue_event(Event {
                            kind: EventKind::Connected,
                            capability,
                            slot,
                            status: 0,
                            length: 0,
                            sequence,
                        })?;
                    }
                    Ok(Some(error)) | Err(error) => {
                        let errno = io_errno(&error);
                        let capability = self.connections[index]
                            .as_ref()
                            .expect("checked")
                            .capability;
                        return self.close_stream(
                            Command {
                                capability,
                                sequence: 0,
                                kind: CommandKind::Close,
                            },
                            errno,
                        );
                    }
                }
            }
            if self.connections[index].is_some() {
                let progress = self.flush_tx(index)?;
                self.finish_pending_shutdown(index)?;
                if self.finish_drained_close(index)? {
                    return Ok(());
                }
                self.apply_write_progress(capability, progress);
            }
        }
        if readable
            && self.connections[index]
                .as_ref()
                .is_some_and(|connection| !connection.rx_eof)
        {
            let progress = self.receive(index)?;
            self.apply_read_progress(capability, progress);
        }
        Ok(())
    }

    fn flush_tx(&mut self, index: usize) -> io::Result<IoProgress> {
        for _ in 0..SOCKET_IO_QUANTUM {
            if self.connections[index]
                .as_ref()
                .is_some_and(|connection| connection.pending_tx.is_empty())
            {
                return Ok(IoProgress::Idle);
            }
            let allowance = self.egress_bandwidth.allowance(SLOT_SIZE);
            if allowance == 0 {
                return Ok(IoProgress::TxBandwidthBlocked);
            }
            let write_result = {
                let connection = self.connections[index].as_mut().expect("connection exists");
                send_pending_tx(&self.ring, connection, allowance)
            };
            match write_result {
                Ok(0) => return Ok(IoProgress::WouldBlock),
                Ok(bytes) => {
                    self.egress_bandwidth.consume(bytes);
                    self.stats
                        .tx_bytes
                        .fetch_add(bytes as u64, Ordering::Relaxed);
                    let (capability, slot, sequence, complete) = {
                        let connection = self.connections[index].as_mut().expect("exists");
                        let pending = connection.pending_tx.front_mut().expect("exists");
                        let written = u32::try_from(bytes)
                            .map_err(|_| io::Error::other("socket write exceeded fixed slot"))?;
                        pending.sent = pending
                            .sent
                            .checked_add(bytes)
                            .ok_or_else(|| io::Error::other("TCP TX progress overflow"))?;
                        let progress = self
                            .state
                            .complete_tx_progress(pending.capability, pending.slot, written)
                            .map_err(state_io_error)?;
                        (
                            pending.capability,
                            pending.slot,
                            pending.sequence,
                            matches!(progress, TxProgress::Complete),
                        )
                    };
                    if complete {
                        self.connections[index]
                            .as_mut()
                            .expect("exists")
                            .pending_tx
                            .pop_front();
                        self.queue_event(Event {
                            kind: EventKind::TxComplete,
                            capability,
                            slot,
                            status: 0,
                            length: 0,
                            sequence,
                        })?;
                        self.stats.tx_slots.fetch_add(1, Ordering::Relaxed);
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    return Ok(IoProgress::WouldBlock);
                }
                Err(error) => {
                    let capability = self.connections[index].as_ref().expect("exists").capability;
                    self.close_stream(
                        Command {
                            sequence: 0,
                            capability,
                            kind: CommandKind::Close,
                        },
                        io_errno(&error),
                    )?;
                    return Ok(IoProgress::Idle);
                }
            }
        }
        Ok(
            if self.connections[index]
                .as_ref()
                .is_some_and(|connection| connection.pending_tx.is_empty())
            {
                IoProgress::Idle
            } else {
                IoProgress::Continue
            },
        )
    }

    fn receive(&mut self, index: usize) -> io::Result<IoProgress> {
        for _ in 0..SOCKET_IO_QUANTUM {
            if self.connections[index]
                .as_ref()
                .is_some_and(|connection| connection.rx_eof)
            {
                return Ok(IoProgress::Idle);
            }
            if self.connections[index]
                .as_ref()
                .is_some_and(|connection| connection.rx_inflight >= PER_CONNECTION_SLOTS)
            {
                return Ok(IoProgress::RxBlocked(RxBlock::ConnectionCredit));
            }
            if self.event_headroom() == 0 {
                return Ok(IoProgress::RxBlocked(RxBlock::GlobalCredit));
            }
            let allowance = self.ingress_bandwidth.allowance(SLOT_SIZE);
            if allowance == 0 {
                return Ok(IoProgress::RxBlocked(RxBlock::Bandwidth));
            }
            let Some(slot) = self.rx_free.iter().position(|free| *free) else {
                return Ok(IoProgress::RxBlocked(RxBlock::GlobalCredit));
            };
            let slot_u16 = u16::try_from(slot)
                .map_err(|_| io::Error::other("RX slot index exceeds wire width"))?;
            let capability = self.connections[index]
                .as_ref()
                .expect("connection exists")
                .capability;
            self.state
                .reserve_rx(
                    capability,
                    slot_u16,
                    u32::try_from(allowance).expect("allowance is bounded to one slot"),
                )
                .map_err(state_io_error)?;
            let received = receive_into_slot(
                &self.ring,
                self.connections[index].as_ref().expect("connection exists"),
                slot_u16,
                allowance,
            )?;
            match received.cmp(&0) {
                std::cmp::Ordering::Greater => {
                    let received = u32::try_from(received)
                        .map_err(|_| io::Error::other("recv exceeded fixed slot"))?;
                    self.ingress_bandwidth
                        .consume(usize::try_from(received).expect("u32 fits usize"));
                    if !matches!(
                        self.state
                            .complete_rx(capability, slot_u16, received)
                            .map_err(state_io_error)?,
                        RxCompletion::Published { .. }
                    ) {
                        continue;
                    }
                    self.rx_free[slot] = false;
                    self.connections[index]
                        .as_mut()
                        .expect("connection exists")
                        .rx_inflight += 1;
                    self.queue_event(Event {
                        kind: EventKind::RxReady,
                        capability,
                        slot: slot_u16,
                        status: 0,
                        length: received,
                        sequence: 0,
                    })?;
                    self.stats.rx_slots.fetch_add(1, Ordering::Relaxed);
                    self.stats
                        .rx_bytes
                        .fetch_add(u64::from(received), Ordering::Relaxed);
                }
                std::cmp::Ordering::Equal => {
                    self.finish_peer_eof(index, capability, slot_u16)?;
                    return Ok(IoProgress::Idle);
                }
                std::cmp::Ordering::Less => {
                    let error = io::Error::last_os_error();
                    self.state
                        .cancel_rx(capability, slot_u16)
                        .map_err(state_io_error)?;
                    if error.kind() == io::ErrorKind::WouldBlock {
                        return Ok(IoProgress::WouldBlock);
                    }
                    self.close_stream(
                        Command {
                            sequence: 0,
                            capability,
                            kind: CommandKind::Close,
                        },
                        io_errno(&error),
                    )?;
                    return Ok(IoProgress::Idle);
                }
            }
        }
        Ok(IoProgress::Continue)
    }

    fn finish_peer_eof(
        &mut self,
        index: usize,
        capability: Capability,
        slot: u16,
    ) -> io::Result<()> {
        self.state
            .complete_rx(capability, slot, 0)
            .map_err(state_io_error)?;
        self.connections[index]
            .as_mut()
            .expect("connection exists")
            .rx_eof = true;
        self.readiness[index].readable = false;
        self.readiness[index].rx_block = None;
        self.queue_event(Event {
            kind: EventKind::Closed,
            capability,
            slot: 0,
            status: 0,
            length: 0,
            sequence: 0,
        })
    }

    #[allow(clippy::too_many_lines)]
    fn receive_dns(&mut self, index: usize) -> io::Result<IoProgress> {
        for _ in 0..SOCKET_IO_QUANTUM {
            if self.dns_connections[index]
                .as_ref()
                .is_some_and(|connection| connection.rx_inflight >= PER_CONNECTION_SLOTS)
            {
                return Ok(IoProgress::RxBlocked(RxBlock::ConnectionCredit));
            }
            if self.event_headroom() == 0 {
                return Ok(IoProgress::RxBlocked(RxBlock::GlobalCredit));
            }
            let Some(slot) = self.rx_free.iter().position(|free| *free) else {
                return Ok(IoProgress::RxBlocked(RxBlock::GlobalCredit));
            };
            let slot_u16 = u16::try_from(slot)
                .map_err(|_| io::Error::other("RX slot index exceeds wire width"))?;
            let (capability, resolver) = {
                let connection = self.dns_connections[index]
                    .as_ref()
                    .expect("DNS connection exists");
                (connection.capability, connection.resolver)
            };
            self.state
                .reserve_rx(capability, slot_u16, DNS_RESPONSE_MAX_U32)
                .map_err(state_io_error)?;
            let destination = self
                .ring
                .rx_destination_at(slot_u16, ENDPOINT_SIZE)
                .map_err(ring_io_error)?;
            // SAFETY: The ownership state reserves the fixed slot, the offset
            // and bound fit it, and H2G is guest-read-only until publication.
            let received = unsafe {
                libc::recv(
                    self.dns_connections[index]
                        .as_ref()
                        .expect("DNS connection exists")
                        .socket
                        .as_raw_fd(),
                    destination.cast(),
                    RESPONSE_MAX,
                    libc::MSG_DONTWAIT | libc::MSG_TRUNC,
                )
            };
            if received > 0 {
                let received = usize::try_from(received)
                    .map_err(|_| io::Error::other("DNS receive exceeded fixed slot"))?;
                if received > RESPONSE_MAX {
                    self.state
                        .cancel_rx(capability, slot_u16)
                        .map_err(state_io_error)?;
                    continue;
                }
                let response = self
                    .ring
                    .copy_rx(slot_u16, ENDPOINT_SIZE, received)
                    .map_err(ring_io_error)?;
                let Ok(transaction_id) = validate_response(&response) else {
                    self.state
                        .cancel_rx(capability, slot_u16)
                        .map_err(state_io_error)?;
                    continue;
                };
                let Some(position) = self.dns_connections[index]
                    .as_ref()
                    .expect("DNS connection exists")
                    .outstanding_ids
                    .iter()
                    .position(|id| *id == transaction_id)
                else {
                    self.state
                        .cancel_rx(capability, slot_u16)
                        .map_err(state_io_error)?;
                    continue;
                };
                self.dns_connections[index]
                    .as_mut()
                    .expect("DNS connection exists")
                    .outstanding_ids
                    .remove(position);
                let mut endpoint = [0_u8; ENDPOINT_SIZE];
                endpoint[0..2].copy_from_slice(&2_u16.to_le_bytes());
                endpoint[2..4].copy_from_slice(&resolver.port().to_be_bytes());
                endpoint[4..8].copy_from_slice(&resolver.ip().octets());
                self.ring
                    .write_rx_prefix(slot_u16, &endpoint)
                    .map_err(ring_io_error)?;
                let received_u32 = u32::try_from(received)
                    .map_err(|_| io::Error::other("DNS receive exceeded wire width"))?;
                if !matches!(
                    self.state
                        .complete_rx(capability, slot_u16, received_u32)
                        .map_err(state_io_error)?,
                    RxCompletion::Published { .. }
                ) {
                    continue;
                }
                self.rx_free[slot] = false;
                self.dns_connections[index]
                    .as_mut()
                    .expect("DNS connection exists")
                    .rx_inflight += 1;
                self.queue_event(Event {
                    kind: EventKind::DnsRxReady,
                    capability,
                    slot: slot_u16,
                    status: 0,
                    length: received_u32,
                    sequence: 0,
                })?;
                self.stats.rx_slots.fetch_add(1, Ordering::Relaxed);
                self.stats
                    .rx_bytes
                    .fetch_add(received as u64, Ordering::Relaxed);
                continue;
            }
            let error = io::Error::last_os_error();
            self.state
                .cancel_rx(capability, slot_u16)
                .map_err(state_io_error)?;
            if received < 0 && error.kind() == io::ErrorKind::WouldBlock {
                return Ok(IoProgress::WouldBlock);
            }
            if received == 0 {
                continue;
            }
            self.close_stream(
                Command {
                    sequence: 0,
                    capability,
                    kind: CommandKind::Close,
                },
                io_errno(&error),
            )?;
            return Ok(IoProgress::Idle);
        }
        Ok(IoProgress::Continue)
    }

    fn current_capability(&self, index: usize) -> Option<Capability> {
        self.connections
            .get(index)
            .and_then(Option::as_ref)
            .map(|connection| connection.capability)
            .or_else(|| {
                self.dns_connections
                    .get(index)
                    .and_then(Option::as_ref)
                    .map(|connection| connection.capability)
            })
    }

    fn active_socket_fds(&self) -> usize {
        self.connections.iter().flatten().count() + self.dns_connections.iter().flatten().count()
    }

    fn enqueue_if_runnable(&mut self, capability: Capability) {
        let index = capability.index as usize;
        if self.current_capability(index) != Some(capability) {
            return;
        }
        let state = &mut self.readiness[index];
        let runnable = (state.writable && state.tx_block.is_none())
            || (state.readable && state.rx_block.is_none());
        if runnable && !state.queued {
            state.queued = true;
            self.ready_queue.push_back(capability);
        }
    }

    fn apply_write_progress(&mut self, capability: Capability, progress: IoProgress) {
        let index = capability.index as usize;
        if self.current_capability(index) != Some(capability) {
            return;
        }
        match progress {
            IoProgress::WouldBlock => self.readiness[index].writable = false,
            IoProgress::Continue => self.enqueue_if_runnable(capability),
            IoProgress::Idle => {}
            IoProgress::TxBandwidthBlocked => {
                self.readiness[index].tx_block = Some(TxBlock::Bandwidth);
                self.tx_bandwidth_waiters.push_back(capability);
            }
            IoProgress::RxBlocked(_) => unreachable!("write path returned RX backpressure"),
        }
    }

    fn apply_read_progress(&mut self, capability: Capability, progress: IoProgress) {
        let index = capability.index as usize;
        if self.current_capability(index) != Some(capability) {
            return;
        }
        match progress {
            IoProgress::WouldBlock => {
                self.readiness[index].readable = false;
                self.readiness[index].rx_block = None;
            }
            IoProgress::Continue => self.enqueue_if_runnable(capability),
            IoProgress::RxBlocked(reason) => {
                self.readiness[index].rx_block = Some(reason);
                match reason {
                    RxBlock::GlobalCredit => self.global_rx_waiters.push_back(capability),
                    RxBlock::ConnectionCredit => {
                        self.connection_rx_waiters.push_back(capability);
                    }
                    RxBlock::Bandwidth => self.rx_bandwidth_waiters.push_back(capability),
                }
            }
            IoProgress::TxBandwidthBlocked => {
                unreachable!("read path returned TX bandwidth backpressure")
            }
            IoProgress::Idle => {}
        }
    }

    fn reset_readiness(&mut self, capability: Capability) {
        let index = capability.index as usize;
        if index < self.readiness.len() {
            self.readiness[index] = Readiness::default();
        }
    }

    fn free_rx_slots(&self) -> usize {
        self.rx_free.iter().filter(|free| **free).count()
    }

    fn resume_global_rx_waiters(&mut self) -> usize {
        let capacity = self.free_rx_slots().min(self.event_headroom());
        let mut resumed = 0;
        let mut inspected = 0;
        let candidates = self.global_rx_waiters.len();
        while resumed < capacity && inspected < candidates {
            let capability = self
                .global_rx_waiters
                .pop_front()
                .expect("bounded waiter count checked");
            inspected += 1;
            let index = capability.index as usize;
            if self.current_capability(index) != Some(capability)
                || self.readiness[index].rx_block != Some(RxBlock::GlobalCredit)
            {
                continue;
            }
            self.readiness[index].rx_block = None;
            self.enqueue_if_runnable(capability);
            resumed += 1;
        }
        resumed
    }

    fn resume_connection_rx_waiters(&mut self, capacity: usize) -> usize {
        let mut resumed = 0;
        let mut inspected = 0;
        let candidates = self.connection_rx_waiters.len();
        while resumed < capacity && inspected < candidates {
            let capability = self
                .connection_rx_waiters
                .pop_front()
                .expect("bounded waiter count checked");
            inspected += 1;
            let index = capability.index as usize;
            if self.current_capability(index) != Some(capability)
                || self.readiness[index].rx_block != Some(RxBlock::ConnectionCredit)
            {
                continue;
            }
            if self.rx_inflight(index) >= PER_CONNECTION_SLOTS {
                self.connection_rx_waiters.push_back(capability);
                continue;
            }
            self.readiness[index].rx_block = None;
            self.enqueue_if_runnable(capability);
            resumed += 1;
        }
        resumed
    }

    fn resume_bandwidth_waiters(&mut self) {
        if self.egress_bandwidth.allowance(1) != 0 {
            while let Some(capability) = self.tx_bandwidth_waiters.pop_front() {
                let index = capability.index as usize;
                if self.current_capability(index) != Some(capability)
                    || self.readiness[index].tx_block != Some(TxBlock::Bandwidth)
                {
                    continue;
                }
                self.readiness[index].tx_block = None;
                self.enqueue_if_runnable(capability);
                break;
            }
        }
        if self.ingress_bandwidth.allowance(1) != 0 {
            while let Some(capability) = self.rx_bandwidth_waiters.pop_front() {
                let index = capability.index as usize;
                if self.current_capability(index) != Some(capability)
                    || self.readiness[index].rx_block != Some(RxBlock::Bandwidth)
                {
                    continue;
                }
                self.readiness[index].rx_block = None;
                self.enqueue_if_runnable(capability);
                break;
            }
        }
    }

    fn next_bandwidth_timeout(&mut self) -> Option<Duration> {
        let tx = (!self.tx_bandwidth_waiters.is_empty())
            .then(|| self.egress_bandwidth.delay_until_credit())
            .flatten();
        let rx = (!self.rx_bandwidth_waiters.is_empty())
            .then(|| self.ingress_bandwidth.delay_until_credit())
            .flatten();
        minimum_timeout(tx, rx)
    }

    fn rx_inflight(&self, index: usize) -> usize {
        self.connections
            .get(index)
            .and_then(Option::as_ref)
            .map_or_else(
                || {
                    self.dns_connections
                        .get(index)
                        .and_then(Option::as_ref)
                        .map_or(0, |connection| connection.rx_inflight)
                },
                |connection| connection.rx_inflight,
            )
    }

    fn decrement_rx_inflight(&mut self, capability: Capability) {
        let index = capability.index as usize;
        if let Some(connection) = self.connections.get_mut(index).and_then(Option::as_mut)
            && connection.capability == capability
        {
            connection.rx_inflight = connection.rx_inflight.saturating_sub(1);
            return;
        }
        if let Some(connection) = self.dns_connections.get_mut(index).and_then(Option::as_mut)
            && connection.capability == capability
        {
            connection.rx_inflight = connection.rx_inflight.saturating_sub(1);
        }
    }

    fn queue_error(&mut self, command: Command, errno: i32) -> io::Result<()> {
        let failed_opcode = match command.kind {
            CommandKind::Tx { .. } => Opcode::Tx,
            CommandKind::RxRelease { .. } => Opcode::RxRelease,
            CommandKind::Close => Opcode::Close,
            CommandKind::Connect { .. } => Opcode::Connect,
            CommandKind::Shutdown { .. } => Opcode::Shutdown,
            CommandKind::DnsQuery { .. } => Opcode::DnsQuery,
            CommandKind::IngressAck => Opcode::IngressAck,
            CommandKind::IngressReject => Opcode::IngressReject,
            CommandKind::IngressAccept { .. } => Opcode::IngressAccept,
        };
        self.queue_event(Event {
            kind: EventKind::Error,
            capability: command.capability,
            slot: match command.kind {
                CommandKind::Connect { slot, .. }
                | CommandKind::Tx { slot, .. }
                | CommandKind::RxRelease { slot }
                | CommandKind::DnsQuery { slot, .. } => slot,
                CommandKind::IngressAccept { pending_index, .. } => pending_index,
                CommandKind::Shutdown { .. }
                | CommandKind::Close
                | CommandKind::IngressAck
                | CommandKind::IngressReject => 0,
            },
            status: -errno.abs(),
            length: failed_opcode as u32,
            sequence: command.sequence,
        })
    }

    fn queue_event(&mut self, event: Event) -> io::Result<()> {
        if self.event_headroom() == 0 {
            return Err(io::Error::other(
                "completion reservation invariant violated",
            ));
        }
        self.pending_events.push_back(event);
        Ok(())
    }

    fn flush_events(&mut self) -> io::Result<()> {
        let mut published = 0_u64;
        let mut notify_guest = self.request_credit_irq_pending;
        self.request_credit_irq_pending = false;
        loop {
            while self.pending_events.front().is_some()
                && self.ring.can_publish().map_err(ring_io_error)?
            {
                let event = self.pending_events.pop_front().expect("checked");
                notify_guest |= self.ring.publish(event).map_err(ring_io_error)?;
                published += 1;
            }
            if self.pending_events.is_empty() {
                self.ring.suppress_response_credit_notifications();
                break;
            }
            if !self
                .ring
                .arm_response_credit_notification()
                .map_err(ring_io_error)?
            {
                break;
            }
        }
        self.stats
            .events_published
            .fetch_add(published, Ordering::Relaxed);
        if notify_guest {
            self.irq.notify()?;
            self.stats
                .guest_irq_injections
                .fetch_add(1, Ordering::Relaxed);
        }
        Ok(())
    }
}

fn thread_cpu_clock(worker: &JoinHandle<()>) -> Option<libc::clockid_t> {
    let mut clock = std::mem::MaybeUninit::<libc::clockid_t>::uninit();
    #[cfg(target_env = "musl")]
    let pthread =
        std::ptr::with_exposed_provenance_mut(usize::try_from(worker.as_pthread_t()).ok()?);
    #[cfg(not(target_env = "musl"))]
    let pthread = worker.as_pthread_t();
    // SAFETY: the handle refers to the live worker and `clock` is writable
    // storage for the POSIX thread CPU clock identifier.
    if unsafe { libc::pthread_getcpuclockid(pthread, clock.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: successful `pthread_getcpuclockid` initialized the clock id.
    Some(unsafe { clock.assume_init() })
}

fn clock_cpu_ns(clock: libc::clockid_t) -> Option<u64> {
    let mut value = std::mem::MaybeUninit::<libc::timespec>::uninit();
    // SAFETY: `value` points to writable storage for one `timespec`.
    if unsafe { libc::clock_gettime(clock, value.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: successful `clock_gettime` initialized the complete value.
    let value = unsafe { value.assume_init() };
    u64::try_from(value.tv_sec)
        .ok()?
        .checked_mul(1_000_000_000)?
        .checked_add(u64::try_from(value.tv_nsec).ok()?)
}

fn system_dns_resolver() -> Option<Ipv4Addr> {
    let bytes = fs::read("/etc/resolv.conf").ok()?;
    parse_system_dns_resolver(&bytes)
}

fn tcp_upstream(requested: SocketAddr) -> SocketAddr {
    match requested {
        SocketAddr::V4(endpoint) if *endpoint.ip() == HOST_LOOPBACK_ALIAS => {
            SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, endpoint.port()))
        }
        _ => requested,
    }
}

fn dns_upstream(requested: Ipv4Addr, host_resolver: Option<Ipv4Addr>) -> Ipv4Addr {
    if matches!(requested, HOST_DNS_ALIAS | Ipv4Addr::LOCALHOST) {
        host_resolver.unwrap_or(requested)
    } else {
        requested
    }
}

fn parse_system_dns_resolver(bytes: &[u8]) -> Option<Ipv4Addr> {
    if bytes.len() > RESOLV_CONF_MAX {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    text.lines().find_map(|line| {
        let mut words = line.split_whitespace();
        (words.next()? == "nameserver")
            .then(|| words.next()?.parse().ok())
            .flatten()
    })
}

fn mailbox_errno(error: MailboxError) -> i32 {
    match error {
        MailboxError::CapabilityOutOfRange
        | MailboxError::SlotOutOfRange
        | MailboxError::InvalidLength
        | MailboxError::InvalidProgress => libc::EINVAL,
        MailboxError::CapabilityUnavailable | MailboxError::SlotBusy => libc::EBUSY,
        MailboxError::StaleCapability | MailboxError::SlotOwnershipMismatch => libc::ESTALE,
        MailboxError::CreditExceeded => libc::ENOBUFS,
        MailboxError::WrongPhase => libc::ESHUTDOWN,
        _ => libc::EPROTO,
    }
}

fn io_errno(error: &io::Error) -> i32 {
    error.raw_os_error().unwrap_or(libc::EIO)
}

fn ring_io_error(error: RingError) -> io::Error {
    io::Error::other(format!("stream ring violation: {error}"))
}

fn state_io_error(error: MailboxError) -> io::Error {
    io::Error::other(format!("stream ownership violation: {error:?}"))
}

fn minimum_timeout(first: Option<Duration>, second: Option<Duration>) -> Option<Duration> {
    match (first, second) {
        (Some(first), Some(second)) => Some(first.min(second)),
        (Some(timeout), None) | (None, Some(timeout)) => Some(timeout),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        future::Future,
        io::{self, Read, Write},
        net::{IpAddr, Ipv4Addr, SocketAddrV4, TcpListener, TcpStream as StdTcpStream, UdpSocket},
        num::NonZeroU64,
        os::fd::AsRawFd,
        pin::Pin,
        ptr,
        sync::{
            Arc, Barrier,
            atomic::{AtomicU32, AtomicUsize, Ordering},
        },
        task::{Context as TaskContext, Poll as TaskPoll, Wake, Waker as TaskWaker},
        thread,
        time::{Duration, Instant},
    };

    use mio::{
        Interest, Poll,
        net::{TcpStream as MioTcpStream, UdpSocket as MioUdpSocket},
    };

    use pvm_stream_mailbox::{
        Capability,
        wire::{Command, CommandKind},
    };

    use super::{
        Connection, DnsConnection, GuestNotifier, IngressPermit, PendingDnsQuery, RESOLV_CONF_MAX,
        RxBlock, SocketIngressError, StdUdpSocket, dns_transaction_available, dns_upstream,
        parse_system_dns_resolver, spawn_with_notifier, tcp_upstream,
    };
    use crate::quota::{BandwidthQuota, SocketQuotas};
    use crate::{
        AllowList, DenyAll, DnsAllowList,
        layout::{
            DATA_OFFSET, DESCRIPTOR_SIZE, DESCRIPTORS_OFFSET, G2H_REQUEST_PRODUCER,
            G2H_RESPONSE_CONSUMER, H2G_REQUEST_CONSUMER, H2G_RESPONSE_PRODUCER, RING_ENTRIES,
            SLOT_SIZE, ServiceMemory,
        },
        wire::{Event, EventKind},
    };

    #[derive(Default)]
    struct CountNotifier(AtomicUsize);

    impl GuestNotifier for CountNotifier {
        fn notify(&self) -> io::Result<()> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }

    #[derive(Default)]
    struct CountWake(AtomicUsize);

    impl Wake for CountWake {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }

    #[test]
    fn system_dns_parser_is_ipv4_only_and_bounded() {
        assert_eq!(
            parse_system_dns_resolver(
                b"# generated\nnameserver 2001:db8::53\nnameserver 10.20.30.40 # local\n"
            ),
            Some(Ipv4Addr::new(10, 20, 30, 40))
        );
        assert_eq!(
            parse_system_dns_resolver(&vec![b'x'; RESOLV_CONF_MAX + 1]),
            None
        );
        let host = Ipv4Addr::new(10, 20, 30, 40);
        assert_eq!(dns_upstream(super::HOST_DNS_ALIAS, Some(host)), host);
        assert_eq!(dns_upstream(Ipv4Addr::LOCALHOST, Some(host)), host);
        assert_eq!(
            dns_upstream(Ipv4Addr::new(9, 9, 9, 9), Some(host)),
            Ipv4Addr::new(9, 9, 9, 9)
        );
    }

    #[test]
    fn host_loopback_alias_is_explicit_and_port_preserving() {
        let requested = SocketAddrV4::new(super::HOST_LOOPBACK_ALIAS, 8443);
        assert_eq!(
            tcp_upstream(requested.into()),
            SocketAddrV4::new(Ipv4Addr::LOCALHOST, 8443).into()
        );
        let public = SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 7), 443);
        assert_eq!(tcp_upstream(public.into()), public.into());
    }

    fn connected_tcp_pair() -> (StdTcpStream, StdTcpStream) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("pair listener");
        let address = listener.local_addr().expect("pair address");
        let peer = StdTcpStream::connect(address).expect("pair connect");
        let (injected, _) = listener.accept().expect("pair accept");
        (injected, peer)
    }

    #[test]
    fn ingress_admission_counts_channel_and_pending_entries_together() {
        let counter = Arc::new(AtomicUsize::new(0));
        let mut permits: Vec<_> = (0..super::INGRESS_SLOTS)
            .map(|_| {
                IngressPermit::acquire(&counter, super::INGRESS_SLOTS).expect("bounded permit")
            })
            .collect();
        assert!(IngressPermit::acquire(&counter, super::INGRESS_SLOTS).is_none());
        permits.pop();
        permits
            .push(IngressPermit::acquire(&counter, super::INGRESS_SLOTS).expect("returned permit"));
        assert_eq!(counter.load(Ordering::Acquire), super::INGRESS_SLOTS);
    }

    #[test]
    fn clone_pending_offer_quota_counts_channel_and_staged_streams() {
        let memory = ServiceMemory::new(64).expect("mailbox");
        let broker = super::spawn_with_notifier_and_quotas(
            memory.clone(),
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
            SocketQuotas {
                pending_ingress_offers: 1,
                ..SocketQuotas::default()
            },
        )
        .expect("broker");
        let ingress = broker.ingress_handle();
        let (first, _first_peer) = connected_tcp_pair();
        let first_operation = ingress
            .begin_inject_tcp_with_timeout(first, 8080, Duration::from_secs(1))
            .expect("first bounded offer");
        let mut consumer = 0;
        assert_eq!(
            next_event(&memory, &mut consumer).kind,
            EventKind::IngressOffer
        );
        let (second, _second_peer) = connected_tcp_pair();
        assert!(matches!(
            ingress.begin_inject_tcp(second, 8080),
            Err(SocketIngressError::Capacity)
        ));
        first_operation.cancel();
        assert_eq!(
            next_event(&memory, &mut consumer).kind,
            EventKind::IngressCancel
        );
        let (replacement, _replacement_peer) = connected_tcp_pair();
        let replacement = ingress
            .begin_inject_tcp_with_timeout(replacement, 8080, Duration::from_secs(1))
            .expect("cancel returned clone-local offer quota");
        assert_eq!(
            next_event(&memory, &mut consumer).kind,
            EventKind::IngressOffer
        );
        replacement.cancel();
        assert_eq!(
            next_event(&memory, &mut consumer).kind,
            EventKind::IngressCancel
        );
        broker.shutdown().expect("broker shutdown");
    }

    #[test]
    fn ingress_operation_polls_without_blocking_and_wakes_once() {
        let (reply, mut operation) = super::IngressReply::pair(None);
        let wake_count = Arc::new(CountWake::default());
        let waker = TaskWaker::from(Arc::clone(&wake_count));
        let mut context = TaskContext::from_waker(&waker);

        assert!(matches!(
            Pin::new(&mut operation).poll(&mut context),
            TaskPoll::Pending
        ));
        reply.send(Ok(()));
        assert_eq!(wake_count.0.load(Ordering::Relaxed), 1);
        assert!(matches!(
            Pin::new(&mut operation).poll(&mut context),
            TaskPoll::Ready(Ok(()))
        ));
    }

    #[test]
    fn dropped_ingress_waiter_is_cancelled_and_reclaims_its_offer_generation() {
        let memory = ServiceMemory::new(34).expect("mailbox");
        let broker = spawn_with_notifier(
            memory.clone(),
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("broker");
        let ingress = broker.ingress_handle();
        let (injected, _peer) = connected_tcp_pair();
        let operation = ingress
            .begin_inject_tcp_with_timeout(injected, 8080, Duration::from_secs(5))
            .expect("submit cancellable offer");
        let mut response_consumer = 0;
        let first_offer = next_event(&memory, &mut response_consumer);
        assert_eq!(first_offer.kind, EventKind::IngressOffer);
        let cancelled_at = Instant::now();
        drop(operation);
        let first_cancel = next_event(&memory, &mut response_consumer);
        assert!(cancelled_at.elapsed() < Duration::from_millis(500));
        assert_eq!(first_cancel.kind, EventKind::IngressCancel);
        assert_eq!(first_cancel.capability, first_offer.capability);

        let (replacement, _peer) = connected_tcp_pair();
        let replacement_operation = ingress
            .begin_inject_tcp_with_timeout(replacement, 8080, Duration::from_secs(5))
            .expect("reclaimed pending-offer permit");
        let replacement_offer = next_event(&memory, &mut response_consumer);
        assert_eq!(replacement_offer.kind, EventKind::IngressOffer);
        assert_eq!(
            replacement_offer.capability.index,
            first_offer.capability.index
        );
        assert_eq!(
            replacement_offer.capability.generation,
            first_offer.capability.generation + 1
        );

        publish(
            &memory,
            0,
            Command {
                sequence: 0,
                capability: first_offer.capability,
                kind: CommandKind::IngressAck,
            },
        );
        broker
            .notify_guest_requests()
            .expect("stale-generation doorbell");
        thread::sleep(Duration::from_millis(10));
        assert_eq!(replacement_operation.try_result(), None);
        publish(
            &memory,
            1,
            Command {
                sequence: 1,
                capability: replacement_offer.capability,
                kind: CommandKind::IngressAck,
            },
        );
        broker
            .notify_guest_requests()
            .expect("current-generation doorbell");
        assert_eq!(
            replacement_operation.wait_timeout(Duration::from_millis(100)),
            Ok(())
        );
        broker.shutdown().expect("broker shutdown");
    }

    #[test]
    fn destroy_racing_with_injection_completes_every_waiter() {
        const RACERS: usize = 64;

        let memory = ServiceMemory::new(59).expect("mailbox");
        let broker = spawn_with_notifier(
            memory,
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("broker");
        let ingress = broker.ingress_handle();
        let barrier = Arc::new(Barrier::new(RACERS + 1));
        let racers: Vec<_> = (0..RACERS)
            .map(|_| {
                let ingress = ingress.clone();
                let barrier = Arc::clone(&barrier);
                let (injected, peer) = connected_tcp_pair();
                thread::spawn(move || {
                    barrier.wait();
                    let result = match ingress.begin_inject_tcp_with_timeout(
                        injected,
                        8080,
                        Duration::from_secs(1),
                    ) {
                        Ok(operation) => operation.wait_timeout(Duration::from_millis(500)),
                        Err(error) => Err(error),
                    };
                    drop(peer);
                    result
                })
            })
            .collect();

        barrier.wait();
        broker.shutdown().expect("concurrent broker shutdown");
        for racer in racers {
            assert!(matches!(
                racer.join().expect("inject racer"),
                Err(SocketIngressError::BrokerStopped | SocketIngressError::Capacity)
            ));
        }
    }

    #[test]
    fn destroyed_clone_handle_and_capability_cannot_cross_into_new_session() {
        let old_memory = ServiceMemory::new(60).expect("old mailbox");
        let old_broker = spawn_with_notifier(
            old_memory.clone(),
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("old broker");
        let old_ingress = old_broker.ingress_handle();
        let (old_stream, _old_peer) = connected_tcp_pair();
        let old_operation = old_ingress
            .begin_inject_tcp_with_timeout(old_stream, 8080, Duration::from_secs(1))
            .expect("old offer");
        let mut old_consumer = 0;
        let old_offer = next_event(&old_memory, &mut old_consumer);
        old_broker.shutdown().expect("destroy old clone broker");
        assert_eq!(
            old_operation.wait_timeout(Duration::from_millis(100)),
            Err(SocketIngressError::BrokerStopped)
        );

        let new_memory = ServiceMemory::new(61).expect("new mailbox");
        let new_broker = spawn_with_notifier(
            new_memory.clone(),
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("new broker");
        let (stale_stream, _stale_peer) = connected_tcp_pair();
        assert!(matches!(
            old_ingress.begin_inject_tcp(stale_stream, 8080),
            Err(SocketIngressError::BrokerStopped)
        ));
        assert_eq!(
            atomic(&new_memory.h2g, H2G_RESPONSE_PRODUCER).load(Ordering::Acquire),
            0
        );

        let (new_stream, _new_peer) = connected_tcp_pair();
        let new_operation = new_broker
            .ingress_handle()
            .begin_inject_tcp_with_timeout(new_stream, 8080, Duration::from_secs(1))
            .expect("new offer");
        let mut new_consumer = 0;
        let new_offer = next_event(&new_memory, &mut new_consumer);
        assert_ne!(old_offer.capability.session, new_offer.capability.session);
        assert_eq!(new_operation.try_result(), None);

        publish(
            &new_memory,
            0,
            Command {
                sequence: 1,
                capability: new_offer.capability,
                kind: CommandKind::IngressAck,
            },
        );
        new_broker
            .notify_guest_requests()
            .expect("current-session doorbell");
        assert_eq!(
            new_operation.wait_timeout(Duration::from_millis(100)),
            Ok(())
        );
        new_broker.shutdown().expect("new broker shutdown");
    }

    #[test]
    fn unresponsive_clone_does_not_occupy_another_clone_waiter() {
        let memory_a = ServiceMemory::new(35).expect("first mailbox");
        let broker_a = spawn_with_notifier(
            memory_a.clone(),
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("first broker");
        let (injected_a, _peer_a) = connected_tcp_pair();
        let operation_a = broker_a
            .ingress_handle()
            .begin_inject_tcp_with_timeout(injected_a, 8001, Duration::from_secs(1))
            .expect("submit first offer");
        let mut consumer_a = 0;
        assert_eq!(
            next_event(&memory_a, &mut consumer_a).kind,
            EventKind::IngressOffer
        );

        let memory_b = ServiceMemory::new(36).expect("second mailbox");
        let broker_b = spawn_with_notifier(
            memory_b.clone(),
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("second broker");
        let (injected_b, _peer_b) = connected_tcp_pair();
        let operation_b = broker_b
            .ingress_handle()
            .begin_inject_tcp_with_timeout(injected_b, 8002, Duration::from_secs(1))
            .expect("submit second offer");
        let mut consumer_b = 0;
        let offer_b = next_event(&memory_b, &mut consumer_b);
        assert_eq!(offer_b.kind, EventKind::IngressOffer);
        publish(
            &memory_b,
            0,
            Command {
                sequence: 0,
                capability: offer_b.capability,
                kind: CommandKind::IngressAck,
            },
        );
        broker_b
            .notify_guest_requests()
            .expect("second ACK doorbell");

        assert_eq!(operation_b.wait_timeout(Duration::from_millis(200)), Ok(()));
        assert_eq!(operation_a.try_result(), None);
        broker_a.shutdown().expect("first broker shutdown");
        assert_eq!(
            operation_a.wait_timeout(Duration::from_millis(200)),
            Err(SocketIngressError::BrokerStopped)
        );
        broker_b.shutdown().expect("second broker shutdown");
    }

    #[test]
    fn ingress_deadline_survives_a_full_completion_reservation() {
        let memory = ServiceMemory::new(37).expect("mailbox");
        let mut loop_state = super::BrokerLoop::new(
            Poll::new().expect("poll"),
            memory.clone(),
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("broker loop");
        let placeholder = Event {
            kind: EventKind::Error,
            capability: Capability {
                index: 0,
                generation: 1,
                session: memory.session(),
            },
            slot: 0,
            status: -libc::EAGAIN,
            length: 0,
            sequence: 0,
        };
        for _ in 0..super::MAX_PENDING_EVENTS - 2 {
            loop_state.queue_event(placeholder).expect("reserved event");
        }

        let counter = Arc::new(AtomicUsize::new(0));
        let permit =
            IngressPermit::acquire(&counter, super::INGRESS_SLOTS).expect("ingress permit");
        let (stream, _peer) = connected_tcp_pair();
        let peer = match stream.peer_addr().expect("peer address") {
            std::net::SocketAddr::V4(peer) => peer,
            std::net::SocketAddr::V6(_) => panic!("test pair must be IPv4"),
        };
        let (reply, operation) = super::IngressReply::pair(None);
        loop_state
            .stage_ingress(
                stream,
                8080,
                peer,
                Instant::now() + Duration::from_millis(2),
                reply,
                permit,
            )
            .expect("stage with offer and cancel reservations");
        assert_eq!(loop_state.event_headroom(), 0);

        let extra_permit =
            IngressPermit::acquire(&counter, super::INGRESS_SLOTS).expect("second ingress permit");
        let (extra_stream, _extra_peer) = connected_tcp_pair();
        let extra_peer = match extra_stream.peer_addr().expect("extra peer address") {
            std::net::SocketAddr::V4(peer) => peer,
            std::net::SocketAddr::V6(_) => panic!("test pair must be IPv4"),
        };
        let (extra_reply, extra_operation) = super::IngressReply::pair(None);
        loop_state
            .stage_ingress(
                extra_stream,
                8081,
                extra_peer,
                Instant::now() + Duration::from_secs(1),
                extra_reply,
                extra_permit,
            )
            .expect("fail fast without blocking broker");
        assert_eq!(
            extra_operation.wait_timeout(Duration::from_millis(20)),
            Err(SocketIngressError::Capacity)
        );

        thread::sleep(Duration::from_millis(5));
        loop_state.expire_ingress().expect("expire reserved offer");
        assert_eq!(
            operation.wait_timeout(Duration::from_millis(20)),
            Err(SocketIngressError::TimedOut)
        );
        assert_eq!(loop_state.pending_events.len(), super::MAX_PENDING_EVENTS);
        assert_eq!(
            loop_state.pending_events.back().expect("cancel event").kind,
            EventKind::IngressCancel
        );
    }

    #[test]
    fn hostile_guest_cannot_retain_more_than_the_ingress_permit_limit() {
        let memory = ServiceMemory::new(39).expect("mailbox");
        let broker = spawn_with_notifier(
            memory.clone(),
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("broker");
        let ingress = broker.ingress_handle();
        let operations: Vec<_> = (0..super::INGRESS_SLOTS)
            .map(|_| {
                let (injected, _peer) = connected_tcp_pair();
                ingress
                    .begin_inject_tcp_with_timeout(injected, 8080, Duration::from_secs(1))
                    .expect("immediate bounded submission")
            })
            .collect();

        let mut response_consumer = 0;
        let offers: Vec<_> = (0..super::INGRESS_SLOTS)
            .map(|_| next_event(&memory, &mut response_consumer))
            .collect();
        assert!(
            offers
                .iter()
                .all(|event| event.kind == EventKind::IngressOffer)
        );
        let (extra, _peer) = connected_tcp_pair();
        assert_eq!(
            ingress.inject_tcp_with_timeout(extra, 8080, Duration::from_secs(1)),
            Err(SocketIngressError::Capacity)
        );
        for operation in operations {
            assert_eq!(
                operation.wait_timeout(Duration::from_secs(2)),
                Err(SocketIngressError::TimedOut)
            );
        }
        let cancels: Vec<_> = (0..super::INGRESS_SLOTS)
            .map(|_| next_event(&memory, &mut response_consumer))
            .collect();
        assert!(
            cancels
                .iter()
                .all(|event| event.kind == EventKind::IngressCancel)
        );

        let (returned, _peer) = connected_tcp_pair();
        let ingress_after_timeout = ingress.clone();
        let returned_worker = thread::spawn(move || {
            ingress_after_timeout.inject_tcp_with_timeout(returned, 8080, Duration::from_millis(20))
        });
        assert_eq!(
            next_event(&memory, &mut response_consumer).kind,
            EventKind::IngressOffer
        );
        assert_eq!(
            returned_worker.join().expect("returned permit worker"),
            Err(SocketIngressError::TimedOut)
        );
        assert_eq!(
            next_event(&memory, &mut response_consumer).kind,
            EventKind::IngressCancel
        );
        broker.shutdown().expect("broker shutdown");
    }

    #[test]
    fn bounded_ingress_offer_ack_accept_and_stream_io() {
        let memory = ServiceMemory::new(41).expect("mailbox");
        let notifier = Arc::new(CountNotifier::default());
        let broker = spawn_with_notifier(
            memory.clone(),
            notifier,
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("broker");
        let ingress = broker.ingress_handle();
        let (injected, mut peer) = connected_tcp_pair();
        let injecting = thread::spawn(move || ingress.inject_tcp(injected, 8080));
        let mut response_consumer = 0;
        let offer = next_event(&memory, &mut response_consumer);
        assert_eq!(offer.kind, EventKind::IngressOffer);
        let (_, target, _) = offer.ingress_offer_parts().expect("ingress fields");
        assert_eq!(target, SocketAddrV4::new(Ipv4Addr::LOCALHOST, 8080));

        publish(
            &memory,
            0,
            Command {
                sequence: 0,
                capability: offer.capability,
                kind: CommandKind::IngressAck,
            },
        );
        broker.notify_guest_requests().expect("ack doorbell");
        assert_eq!(injecting.join().expect("inject thread"), Ok(()));

        let child = Capability {
            index: 0,
            generation: 1,
            session: memory.session(),
        };
        publish(
            &memory,
            1,
            Command {
                sequence: 1,
                capability: child,
                kind: CommandKind::IngressAccept {
                    pending_index: u16::try_from(offer.capability.index)
                        .expect("pending index fits wire"),
                    pending_generation: offer.capability.generation,
                },
            },
        );
        broker.notify_guest_requests().expect("accept doorbell");
        let accepted = next_event(&memory, &mut response_consumer);
        assert_eq!(accepted.kind, EventKind::IngressAccepted);
        assert_eq!(accepted.capability, child);

        peer.write_all(b"host-data").expect("write host data");
        let rx = next_event(&memory, &mut response_consumer);
        assert_eq!(rx.kind, EventKind::RxReady);
        // SAFETY: the host producer published this immutable H2G slot.
        let bytes = unsafe {
            memory
                .h2g
                .read_quiescent(
                    DATA_OFFSET + usize::from(rx.slot) * SLOT_SIZE,
                    usize::try_from(rx.length).expect("RX length fits usize"),
                )
                .expect("RX bytes")
        };
        assert_eq!(bytes, b"host-data");
        publish(
            &memory,
            2,
            Command {
                sequence: 2,
                capability: child,
                kind: CommandKind::RxRelease { slot: rx.slot },
            },
        );
        write_bytes(&memory.g2h, DATA_OFFSET, b"guest-data");
        publish(
            &memory,
            3,
            Command {
                sequence: 3,
                capability: child,
                kind: CommandKind::Tx {
                    slot: 0,
                    offset: 0,
                    length: 10,
                },
            },
        );
        broker.notify_guest_requests().expect("I/O doorbell");
        let mut guest_data = [0_u8; 10];
        peer.read_exact(&mut guest_data).expect("read guest data");
        assert_eq!(&guest_data, b"guest-data");
        broker.shutdown().expect("broker shutdown");
    }

    #[test]
    fn unacknowledged_ingress_expires_and_is_cancelled() {
        let memory = ServiceMemory::new(43).expect("mailbox");
        let broker = spawn_with_notifier(
            memory.clone(),
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("broker");
        let ingress = broker.ingress_handle();
        let (injected, _peer) = connected_tcp_pair();
        let injecting = thread::spawn(move || {
            ingress.inject_tcp_with_timeout(injected, 8080, Duration::from_millis(20))
        });
        let mut response_consumer = 0;
        let offer = next_event(&memory, &mut response_consumer);
        assert_eq!(offer.kind, EventKind::IngressOffer);
        assert_eq!(
            injecting.join().expect("inject thread"),
            Err(SocketIngressError::TimedOut)
        );
        let cancel = next_event(&memory, &mut response_consumer);
        assert_eq!(cancel.kind, EventKind::IngressCancel);
        assert_eq!(cancel.capability, offer.capability);
        broker.shutdown().expect("broker shutdown");
    }

    #[allow(clippy::cast_ptr_alignment)]
    fn atomic(memory: &minisandbox_pvm_sys::PvmSharedMemory, offset: usize) -> &AtomicU32 {
        // SAFETY: These ABI offsets are aligned initialized atomic words.
        unsafe { &*memory.as_ptr().as_ptr().add(offset).cast::<AtomicU32>() }
    }

    fn write_bytes(memory: &minisandbox_pvm_sys::PvmSharedMemory, offset: usize, bytes: &[u8]) {
        for (index, byte) in bytes.iter().copied().enumerate() {
            // SAFETY: Every test range is bounded by a fixed descriptor/data slot.
            unsafe { ptr::write_volatile(memory.as_ptr().as_ptr().add(offset + index), byte) };
        }
    }

    fn publish(memory: &ServiceMemory, producer: u32, command: Command) {
        let index = producer as usize % RING_ENTRIES;
        write_bytes(
            &memory.g2h,
            DESCRIPTORS_OFFSET + index * DESCRIPTOR_SIZE,
            &command.encode(),
        );
        atomic(&memory.g2h, G2H_REQUEST_PRODUCER).store(producer + 1, Ordering::Release);
    }

    fn next_event(memory: &ServiceMemory, consumer: &mut u32) -> Event {
        let deadline = Instant::now() + Duration::from_secs(3);
        while atomic(&memory.h2g, H2G_RESPONSE_PRODUCER).load(Ordering::Acquire) == *consumer {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for broker event"
            );
            thread::sleep(Duration::from_millis(1));
        }
        let index = *consumer as usize % RING_ENTRIES;
        let mut bytes = [0_u8; DESCRIPTOR_SIZE];
        let start = DESCRIPTORS_OFFSET + index * DESCRIPTOR_SIZE;
        for (offset, byte) in bytes.iter_mut().enumerate() {
            // SAFETY: Producer Acquire proves this descriptor was initialized.
            *byte = unsafe { ptr::read_volatile(memory.h2g.as_ptr().as_ptr().add(start + offset)) };
        }
        *consumer += 1;
        atomic(&memory.g2h, G2H_RESPONSE_CONSUMER).store(*consumer, Ordering::Release);
        Event::decode(&bytes, memory.session()).expect("canonical host event")
    }

    fn insert_connected_stream(
        loop_state: &mut super::BrokerLoop,
        index: u32,
    ) -> (Capability, StdTcpStream) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("loopback listener");
        let peer = listener.local_addr().expect("listener address");
        let broker_stream = StdTcpStream::connect(peer).expect("connect loopback stream");
        let (server_stream, _) = listener.accept().expect("accept loopback stream");
        broker_stream
            .set_nonblocking(true)
            .expect("nonblocking broker stream");
        let capability = loop_state
            .state
            .open_capability(index)
            .expect("open test capability");
        let poll_token = loop_state
            .allocate_registration_token()
            .expect("allocate test poll token");
        loop_state.registrations.insert(poll_token.0, capability);
        loop_state.connections[index as usize] = Some(Connection {
            stream: MioTcpStream::from_std(broker_stream),
            poll_token,
            capability,
            connect_sequence: 0,
            connect_slot: 0,
            connected: true,
            pending_tx: VecDeque::new(),
            rx_inflight: 0,
            rx_eof: false,
            tx_shutdown: false,
            pending_shutdown: None,
            closing: None,
        });
        (capability, server_stream)
    }

    #[test]
    fn guest_close_drains_every_accepted_tx_slot_before_fin() {
        let memory = ServiceMemory::new(55).expect("mailbox");
        let mut loop_state = super::BrokerLoop::new(
            Poll::new().expect("poll"),
            memory.clone(),
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("broker loop");
        let (capability, mut server) = insert_connected_stream(&mut loop_state, 0);
        let mut expected = Vec::new();
        for slot in 0_u16..4 {
            let payload = vec![u8::try_from(slot + 1).expect("small slot"); SLOT_SIZE];
            write_bytes(
                &memory.g2h,
                DATA_OFFSET + usize::from(slot) * SLOT_SIZE,
                &payload,
            );
            expected.extend_from_slice(&payload);
            loop_state
                .handle_command(Command {
                    sequence: u32::from(slot) + 1,
                    capability,
                    kind: CommandKind::Tx {
                        slot,
                        offset: 0,
                        length: u32::try_from(SLOT_SIZE).expect("fixed slot fits wire"),
                    },
                })
                .expect("accept TX slot");
        }
        loop_state.readiness[0].writable = true;
        loop_state
            .handle_command(Command {
                sequence: 99,
                capability,
                kind: CommandKind::Close,
            })
            .expect("begin graceful close");

        let connection = loop_state.connections[0]
            .as_ref()
            .expect("connection remains while TX drains");
        assert_eq!(connection.pending_tx.len(), 4);
        assert!(connection.closing.is_some());
        assert!(
            loop_state
                .pending_events
                .iter()
                .all(|event| event.kind != EventKind::Closed)
        );

        loop_state.enqueue_if_runnable(capability);
        assert_eq!(
            loop_state
                .service_ready_queue(4)
                .expect("drain close queue"),
            2
        );
        assert!(loop_state.connections[0].is_none());
        assert_eq!(loop_state.state.capability(0), None);
        server
            .set_read_timeout(Some(Duration::from_secs(3)))
            .expect("server read timeout");
        let mut received = Vec::new();
        server
            .read_to_end(&mut received)
            .expect("read drained bytes through FIN");
        assert_eq!(received, expected);
        let kinds: Vec<_> = loop_state
            .pending_events
            .iter()
            .map(|event| event.kind)
            .collect();
        assert_eq!(
            kinds,
            [
                EventKind::TxComplete,
                EventKind::TxComplete,
                EventKind::TxComplete,
                EventKind::TxComplete,
                EventKind::Closed,
            ]
        );
        assert_eq!(
            loop_state
                .pending_events
                .back()
                .expect("close completion")
                .sequence,
            99
        );
    }

    #[test]
    fn peer_half_close_preserves_guest_to_peer_direction_until_guest_close() {
        let memory = ServiceMemory::new(56).expect("mailbox");
        let mut loop_state = super::BrokerLoop::new(
            Poll::new().expect("poll"),
            memory.clone(),
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("broker loop");
        let (capability, mut peer) = insert_connected_stream(&mut loop_state, 0);
        peer.shutdown(std::net::Shutdown::Write)
            .expect("peer half-close");

        assert_eq!(
            loop_state.receive(0).expect("observe peer FIN"),
            super::IoProgress::Idle
        );
        let connection = loop_state.connections[0]
            .as_ref()
            .expect("peer FIN must retain the reverse direction");
        assert!(connection.rx_eof);
        assert!(!connection.tx_shutdown);
        assert_eq!(loop_state.state.capability(0), Some(capability));
        let peer_fin = loop_state.pending_events.back().expect("peer FIN event");
        assert_eq!(peer_fin.kind, EventKind::Closed);
        assert_eq!(peer_fin.status, 0);

        write_bytes(&memory.g2h, DATA_OFFSET, b"after-fin");
        loop_state
            .handle_command(Command {
                sequence: 1,
                capability,
                kind: CommandKind::Tx {
                    slot: 0,
                    offset: 0,
                    length: 9,
                },
            })
            .expect("queue reverse-direction bytes");
        loop_state.readiness[0].writable = true;
        loop_state.enqueue_if_runnable(capability);
        loop_state
            .service_ready_queue(2)
            .expect("flush reverse direction");
        let mut received = [0_u8; 9];
        peer.read_exact(&mut received)
            .expect("peer reads after its FIN");
        assert_eq!(&received, b"after-fin");

        loop_state
            .handle_command(Command {
                sequence: 2,
                capability,
                kind: CommandKind::Close,
            })
            .expect("guest final close");
        assert!(loop_state.connections[0].is_none());
        assert_eq!(loop_state.state.capability(0), None);
        let mut eof = [0_u8; 1];
        assert_eq!(peer.read(&mut eof).expect("peer final EOF"), 0);
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn guest_shutdown_write_drains_tx_before_fin_and_retains_receive_direction() {
        let memory = ServiceMemory::new(57).expect("mailbox");
        let mut loop_state = super::BrokerLoop::new(
            Poll::new().expect("poll"),
            memory.clone(),
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("broker loop");
        let (capability, mut peer) = insert_connected_stream(&mut loop_state, 0);
        let mut expected = Vec::new();
        for slot in 0_u16..4 {
            let payload = vec![u8::try_from(slot + 1).expect("small slot"); SLOT_SIZE];
            write_bytes(
                &memory.g2h,
                DATA_OFFSET + usize::from(slot) * SLOT_SIZE,
                &payload,
            );
            expected.extend_from_slice(&payload);
            loop_state
                .handle_command(Command {
                    sequence: u32::from(slot) + 1,
                    capability,
                    kind: CommandKind::Tx {
                        slot,
                        offset: 0,
                        length: u32::try_from(SLOT_SIZE).expect("fixed slot fits wire"),
                    },
                })
                .expect("queue TX before shutdown");
        }
        loop_state
            .handle_command(Command {
                sequence: 10,
                capability,
                kind: CommandKind::Shutdown { how: 1 },
            })
            .expect("queue SHUT_WR");
        let connection = loop_state.connections[0].as_ref().expect("connection");
        assert!(connection.pending_shutdown.is_some());
        assert!(!connection.tx_shutdown);

        loop_state.readiness[0].writable = true;
        loop_state.enqueue_if_runnable(capability);
        loop_state
            .service_ready_queue(4)
            .expect("drain TX before FIN");
        let connection = loop_state.connections[0]
            .as_ref()
            .expect("SHUT_WR retains receive direction");
        assert!(connection.tx_shutdown);
        assert!(!connection.rx_eof);
        assert!(connection.pending_shutdown.is_none());
        peer.set_read_timeout(Some(Duration::from_secs(3)))
            .expect("peer read timeout");
        let mut received = Vec::new();
        peer.read_to_end(&mut received)
            .expect("payload followed by FIN");
        assert_eq!(received, expected);
        assert_eq!(
            loop_state
                .pending_events
                .iter()
                .filter(|event| event.kind == EventKind::TxComplete)
                .count(),
            4
        );
        assert!(loop_state.pending_events.iter().any(|event| {
            event.kind == EventKind::Shutdown && event.sequence == 10 && event.length == 1
        }));

        peer.write_all(b"response-after-fin")
            .expect("peer reverse-direction response");
        loop_state.readiness[0].readable = true;
        loop_state.enqueue_if_runnable(capability);
        loop_state
            .service_ready_queue(2)
            .expect("receive after SHUT_WR");
        let rx = loop_state
            .pending_events
            .iter()
            .find(|event| event.kind == EventKind::RxReady)
            .copied()
            .expect("reverse-direction RX");
        // SAFETY: the host producer completed and published this fixed RX slot.
        let response = unsafe {
            memory
                .h2g
                .read_quiescent(
                    DATA_OFFSET + usize::from(rx.slot) * SLOT_SIZE,
                    usize::try_from(rx.length).expect("RX length fits usize"),
                )
                .expect("published response")
        };
        assert_eq!(response, b"response-after-fin");
        loop_state
            .handle_command(Command {
                sequence: 11,
                capability,
                kind: CommandKind::RxRelease { slot: rx.slot },
            })
            .expect("release reverse RX");
        loop_state
            .handle_command(Command {
                sequence: 12,
                capability,
                kind: CommandKind::Close,
            })
            .expect("final close");
        assert!(loop_state.connections[0].is_none());
        assert_eq!(loop_state.state.capability(0), None);
    }

    #[test]
    fn peer_reset_terminates_both_directions_and_reclaims_capability() {
        let memory = ServiceMemory::new(58).expect("mailbox");
        let mut loop_state = super::BrokerLoop::new(
            Poll::new().expect("poll"),
            memory,
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("broker loop");
        let (capability, peer) = insert_connected_stream(&mut loop_state, 0);
        let linger = libc::linger {
            l_onoff: 1,
            l_linger: 0,
        };
        let linger_length = libc::socklen_t::try_from(std::mem::size_of_val(&linger))
            .expect("linger length fits socklen_t");
        // SAFETY: `peer` owns a live TCP fd and `linger` has the exact
        // `SO_LINGER` representation and length expected by the kernel.
        let result = unsafe {
            libc::setsockopt(
                peer.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_LINGER,
                std::ptr::from_ref(&linger).cast(),
                linger_length,
            )
        };
        assert_eq!(
            result,
            0,
            "set abortive linger: {}",
            io::Error::last_os_error()
        );
        drop(peer);

        assert_eq!(
            loop_state.receive(0).expect("observe peer RST"),
            super::IoProgress::Idle
        );
        assert!(loop_state.connections[0].is_none());
        assert_eq!(loop_state.state.capability(0), None);
        let reset = loop_state.pending_events.back().expect("RST close event");
        assert_eq!(reset.kind, EventKind::Closed);
        assert_eq!(reset.capability, capability);
        assert_eq!(reset.status, -libc::ECONNRESET);
    }

    #[test]
    fn stale_poll_token_cannot_target_reused_capability_index() {
        let memory = ServiceMemory::new(52).expect("mailbox");
        let mut loop_state = super::BrokerLoop::new(
            Poll::new().expect("poll"),
            memory,
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("broker loop");
        let (old_capability, _old_peer) = insert_connected_stream(&mut loop_state, 0);
        let old_token = loop_state.connections[0]
            .as_ref()
            .expect("old connection")
            .poll_token;
        loop_state
            .close_stream(
                Command {
                    capability: old_capability,
                    sequence: 1,
                    kind: CommandKind::Close,
                },
                0,
            )
            .expect("close old connection");
        loop_state.pending_events.clear();

        let (new_capability, _new_peer) = insert_connected_stream(&mut loop_state, 0);
        let new_token = loop_state.connections[0]
            .as_ref()
            .expect("new connection")
            .poll_token;
        assert_ne!(old_capability, new_capability);
        assert_ne!(old_token, new_token);

        loop_state.mark_socket_ready(old_token, true, true);
        assert_eq!(loop_state.readiness[0], super::Readiness::default());
        assert!(loop_state.ready_queue.is_empty());

        loop_state.mark_socket_ready(new_token, true, false);
        assert!(loop_state.readiness[0].readable);
        assert_eq!(loop_state.ready_queue.pop_front(), Some(new_capability));
    }

    #[test]
    fn slow_completion_consumer_backpressures_request_drain() {
        let memory = ServiceMemory::new(53).expect("mailbox");
        let mut loop_state = super::BrokerLoop::new(
            Poll::new().expect("poll"),
            memory.clone(),
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("broker loop");
        let capability = Capability {
            index: 0,
            generation: 1,
            session: memory.session(),
        };
        publish(
            &memory,
            0,
            Command {
                capability,
                sequence: 1,
                kind: CommandKind::Close,
            },
        );
        atomic(&memory.g2h, G2H_REQUEST_PRODUCER).store(1, Ordering::Release);
        for sequence in 0..super::MAX_PENDING_EVENTS {
            loop_state.pending_events.push_back(Event {
                kind: EventKind::Error,
                capability,
                slot: 0,
                status: -libc::EAGAIN,
                length: 0,
                sequence: u32::try_from(sequence).expect("bounded sequence"),
            });
        }

        assert!(!loop_state.drain_requests().expect("apply backpressure"));
        assert_eq!(
            atomic(&memory.h2g, H2G_REQUEST_CONSUMER).load(Ordering::Acquire),
            0
        );
        for _ in 0..super::MAX_EVENTS_PER_COMMAND {
            loop_state.pending_events.pop_front();
        }
        assert!(!loop_state.drain_requests().expect("resume request drain"));
        assert_eq!(
            atomic(&memory.h2g, H2G_REQUEST_CONSUMER).load(Ordering::Acquire),
            1
        );
        assert!(loop_state.pending_events.len() <= super::MAX_PENDING_EVENTS);
    }

    #[test]
    fn full_completion_backlog_retains_socket_readiness() {
        let memory = ServiceMemory::new(54).expect("mailbox");
        let mut loop_state = super::BrokerLoop::new(
            Poll::new().expect("poll"),
            memory,
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("broker loop");
        let (capability, _peer) = insert_connected_stream(&mut loop_state, 0);
        loop_state.readiness[0].writable = true;
        loop_state.enqueue_if_runnable(capability);
        for sequence in 0..super::MAX_PENDING_EVENTS {
            loop_state.pending_events.push_back(Event {
                kind: EventKind::Error,
                capability,
                slot: 0,
                status: -libc::EAGAIN,
                length: 0,
                sequence: u32::try_from(sequence).expect("bounded sequence"),
            });
        }

        assert_eq!(
            loop_state
                .service_ready_queue(super::READY_TURN_BUDGET)
                .expect("pause readiness"),
            0
        );
        assert_eq!(loop_state.ready_queue.front(), Some(&capability));
        for _ in 0..super::MAX_EVENTS_PER_READY_TURN {
            loop_state.pending_events.pop_front();
        }
        assert_eq!(
            loop_state
                .service_ready_queue(super::READY_TURN_BUDGET)
                .expect("resume readiness"),
            1
        );
        assert!(loop_state.pending_events.len() <= super::MAX_PENDING_EVENTS);
    }

    #[test]
    fn one_readiness_edge_drains_quanta_and_resumes_after_rx_credit() {
        let memory = ServiceMemory::new(44).expect("mailbox");
        let notifier = Arc::new(CountNotifier::default());
        let mut loop_state = super::BrokerLoop::new(
            Poll::new().expect("poll"),
            memory,
            notifier,
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("broker loop");
        let (capability, mut server) = insert_connected_stream(&mut loop_state, 0);
        server
            .write_all(&vec![b'x'; SLOT_SIZE * 5])
            .expect("seed five RX slots");

        loop_state.readiness[0].readable = true;
        loop_state.enqueue_if_runnable(capability);
        loop_state
            .service_ready_queue(16)
            .expect("service retained readiness");
        assert_eq!(loop_state.connections[0].as_ref().unwrap().rx_inflight, 4);
        assert_eq!(
            loop_state
                .pending_events
                .iter()
                .filter(|event| event.kind == EventKind::RxReady)
                .count(),
            4
        );

        let released = loop_state
            .pending_events
            .iter()
            .find(|event| event.kind == EventKind::RxReady)
            .expect("published RX")
            .slot;
        loop_state
            .release_rx(
                Command {
                    sequence: 1,
                    capability,
                    kind: CommandKind::RxRelease { slot: released },
                },
                released,
            )
            .expect("release RX credit");
        loop_state
            .service_ready_queue(16)
            .expect("resume without a second Mio edge");
        assert_eq!(
            loop_state
                .pending_events
                .iter()
                .filter(|event| event.kind == EventKind::RxReady)
                .count(),
            5
        );
    }

    #[test]
    fn ready_queue_round_robins_hot_connections_by_quantum() {
        let memory = ServiceMemory::new(45).expect("mailbox");
        let notifier = Arc::new(CountNotifier::default());
        let mut loop_state = super::BrokerLoop::new(
            Poll::new().expect("poll"),
            memory,
            notifier,
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("broker loop");
        let (first, mut first_server) = insert_connected_stream(&mut loop_state, 0);
        let (second, mut second_server) = insert_connected_stream(&mut loop_state, 1);
        first_server
            .write_all(&vec![b'a'; SLOT_SIZE * 4])
            .expect("seed first stream");
        second_server
            .write_all(&vec![b'b'; SLOT_SIZE * 4])
            .expect("seed second stream");

        loop_state.readiness[0].readable = true;
        loop_state.readiness[1].readable = true;
        loop_state.enqueue_if_runnable(first);
        loop_state.enqueue_if_runnable(second);
        loop_state
            .service_ready_queue(2)
            .expect("one turn per connection");

        let owners: Vec<_> = loop_state
            .pending_events
            .iter()
            .filter(|event| event.kind == EventKind::RxReady)
            .map(|event| event.capability.index)
            .collect();
        assert_eq!(owners, [0, 0, 1, 1]);
        assert_eq!(
            loop_state.ready_queue.iter().copied().collect::<Vec<_>>(),
            [first, second]
        );
    }

    #[test]
    fn host_enforces_per_connection_tx_slot_backpressure() {
        let memory = ServiceMemory::new(46).expect("mailbox");
        let notifier = Arc::new(CountNotifier::default());
        let mut loop_state = super::BrokerLoop::new(
            Poll::new().expect("poll"),
            memory.clone(),
            notifier,
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("broker loop");
        let (capability, _server) = insert_connected_stream(&mut loop_state, 0);

        for slot in 0_u16..5 {
            write_bytes(
                &memory.g2h,
                DATA_OFFSET + usize::from(slot) * SLOT_SIZE,
                &[u8::try_from(slot).expect("small test slot")],
            );
            loop_state
                .handle_command(Command {
                    sequence: u32::from(slot) + 1,
                    capability,
                    kind: CommandKind::Tx {
                        slot,
                        offset: 0,
                        length: 1,
                    },
                })
                .expect("bounded TX submission");
        }

        assert_eq!(
            loop_state.connections[0]
                .as_ref()
                .expect("test connection")
                .pending_tx
                .len(),
            4
        );
        let error = loop_state.pending_events.back().expect("quota error");
        assert_eq!(error.kind, EventKind::Error);
        assert_eq!(error.status, -libc::ENOBUFS);
        assert_eq!(error.sequence, 5);
    }

    #[test]
    fn clone_active_fd_quota_rejects_a_second_socket_before_host_open() {
        let memory = ServiceMemory::new(62).expect("mailbox");
        let mut loop_state = super::BrokerLoop::new_with_quotas(
            Poll::new().expect("poll"),
            memory.clone(),
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
            SocketQuotas {
                active_socket_fds: 1,
                ..SocketQuotas::default()
            },
        )
        .expect("broker loop");
        let (_capability, _peer) = insert_connected_stream(&mut loop_state, 0);
        loop_state
            .handle_command(Command {
                sequence: 9,
                capability: Capability {
                    index: 1,
                    generation: 1,
                    session: memory.session(),
                },
                kind: CommandKind::Connect { slot: 0, length: 8 },
            })
            .expect("bounded connect rejection");
        assert_eq!(loop_state.active_socket_fds(), 1);
        assert_eq!(loop_state.state.capability(1), None);
        let error = loop_state.pending_events.back().expect("FD quota error");
        assert_eq!(error.kind, EventKind::Error);
        assert_eq!(error.status, -libc::EMFILE);
        assert_eq!(error.sequence, 9);
    }

    #[test]
    fn clone_egress_bandwidth_quota_suspends_and_resumes_edge_readiness() {
        let memory = ServiceMemory::new(63).expect("mailbox");
        let mut loop_state = super::BrokerLoop::new_with_quotas(
            Poll::new().expect("poll"),
            memory.clone(),
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
            SocketQuotas {
                egress_bandwidth: Some(BandwidthQuota {
                    bytes_per_second: NonZeroU64::new(1_000).unwrap(),
                    burst_bytes: NonZeroU64::new(4).unwrap(),
                }),
                ..SocketQuotas::default()
            },
        )
        .expect("broker loop");
        let (capability, mut peer) = insert_connected_stream(&mut loop_state, 0);
        write_bytes(&memory.g2h, DATA_OFFSET, b"abcdefgh");
        loop_state
            .handle_command(Command {
                sequence: 1,
                capability,
                kind: CommandKind::Tx {
                    slot: 0,
                    offset: 0,
                    length: 8,
                },
            })
            .expect("submit rate-limited TX");
        loop_state.readiness[0].writable = true;
        loop_state.enqueue_if_runnable(capability);
        loop_state
            .service_ready_queue(1)
            .expect("consume initial burst");
        assert_eq!(
            loop_state.readiness[0].tx_block,
            Some(super::TxBlock::Bandwidth)
        );
        assert!(loop_state.ready_queue.is_empty());
        let mut first = [0_u8; 4];
        peer.read_exact(&mut first).expect("read initial burst");
        assert_eq!(&first, b"abcd");
        peer.set_nonblocking(true).expect("nonblocking peer");
        let mut extra = [0_u8; 1];
        assert_eq!(
            peer.read(&mut extra)
                .expect_err("quota stops fifth byte")
                .kind(),
            io::ErrorKind::WouldBlock
        );

        thread::sleep(Duration::from_millis(10));
        loop_state.resume_bandwidth_waiters();
        assert_eq!(loop_state.ready_queue.front(), Some(&capability));
        loop_state
            .service_ready_queue(1)
            .expect("resume retained writable edge");
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut remaining = Vec::new();
        while remaining.len() < 4 && Instant::now() < deadline {
            match peer.read_to_end(&mut remaining) {
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(1));
                }
                Err(error) => panic!("read resumed bytes: {error}"),
            }
        }
        assert_eq!(remaining, b"efgh");
        assert_eq!(loop_state.stats.tx_bytes.load(Ordering::Relaxed), 8);
    }

    #[test]
    fn clone_ingress_bandwidth_quota_retains_edge_until_refill() {
        let memory = ServiceMemory::new(65).expect("mailbox");
        let mut loop_state = super::BrokerLoop::new_with_quotas(
            Poll::new().expect("poll"),
            memory.clone(),
            Arc::new(CountNotifier::default()),
            Arc::new(DenyAll),
            Arc::new(DenyAll),
            SocketQuotas {
                ingress_bandwidth: Some(BandwidthQuota {
                    bytes_per_second: NonZeroU64::new(1_000).unwrap(),
                    burst_bytes: NonZeroU64::new(4).unwrap(),
                }),
                ..SocketQuotas::default()
            },
        )
        .expect("broker loop");
        let (capability, mut peer) = insert_connected_stream(&mut loop_state, 0);
        peer.write_all(b"abcdefgh").expect("seed ingress bytes");
        loop_state.readiness[0].readable = true;
        loop_state.enqueue_if_runnable(capability);
        loop_state
            .service_ready_queue(1)
            .expect("consume ingress burst");
        assert_eq!(loop_state.readiness[0].rx_block, Some(RxBlock::Bandwidth));
        assert!(loop_state.ready_queue.is_empty());
        let first = loop_state
            .pending_events
            .iter()
            .find(|event| event.kind == EventKind::RxReady)
            .copied()
            .expect("initial burst event");
        assert_eq!(first.length, 4);
        // SAFETY: RX publication completed before the event was queued.
        let first_bytes = unsafe {
            memory
                .h2g
                .read_quiescent(DATA_OFFSET + usize::from(first.slot) * SLOT_SIZE, 4)
                .expect("initial ingress bytes")
        };
        assert_eq!(first_bytes, b"abcd");
        loop_state
            .release_rx(
                Command {
                    sequence: 1,
                    capability,
                    kind: CommandKind::RxRelease { slot: first.slot },
                },
                first.slot,
            )
            .expect("release first ingress slot");

        thread::sleep(Duration::from_millis(10));
        loop_state.resume_bandwidth_waiters();
        assert_eq!(loop_state.ready_queue.front(), Some(&capability));
        loop_state
            .service_ready_queue(1)
            .expect("resume retained readable edge");
        let second = loop_state
            .pending_events
            .iter()
            .filter(|event| event.kind == EventKind::RxReady)
            .nth(1)
            .copied()
            .expect("refilled burst event");
        assert_eq!(second.length, 4);
        // SAFETY: RX publication completed before the event was queued.
        let second_bytes = unsafe {
            memory
                .h2g
                .read_quiescent(DATA_OFFSET + usize::from(second.slot) * SLOT_SIZE, 4)
                .expect("refilled ingress bytes")
        };
        assert_eq!(second_bytes, b"efgh");
        assert_eq!(loop_state.stats.rx_bytes.load(Ordering::Relaxed), 8);
    }

    #[test]
    fn released_global_rx_credit_goes_to_the_queued_connection() {
        let memory = ServiceMemory::new(47).expect("mailbox");
        let notifier = Arc::new(CountNotifier::default());
        let mut loop_state = super::BrokerLoop::new(
            Poll::new().expect("poll"),
            memory,
            notifier,
            Arc::new(DenyAll),
            Arc::new(DenyAll),
        )
        .expect("broker loop");
        let mut capabilities = Vec::new();
        let mut servers = Vec::new();
        for index in 0_u32..9 {
            let (capability, server) = insert_connected_stream(&mut loop_state, index);
            capabilities.push(capability);
            servers.push(server);
        }
        for (index, server) in servers.iter_mut().enumerate().take(8) {
            server
                .write_all(&vec![
                    u8::try_from(index).expect("small index");
                    SLOT_SIZE * 4
                ])
                .expect("fill one connection quota");
            loop_state.readiness[index].readable = true;
            loop_state.enqueue_if_runnable(capabilities[index]);
        }
        loop_state
            .service_ready_queue(64)
            .expect("fill all global RX slots fairly");
        assert_eq!(loop_state.free_rx_slots(), 0);

        servers[8]
            .write_all(&vec![b'q'; SLOT_SIZE])
            .expect("seed queued connection");
        loop_state.readiness[8].readable = true;
        loop_state.enqueue_if_runnable(capabilities[8]);
        loop_state
            .service_ready_queue(1)
            .expect("observe global backpressure");
        assert_eq!(
            loop_state.readiness[8].rx_block,
            Some(super::RxBlock::GlobalCredit)
        );

        let released = loop_state
            .pending_events
            .iter()
            .find(|event| event.kind == EventKind::RxReady && event.capability.index == 0)
            .expect("first connection owns RX")
            .slot;
        loop_state
            .release_rx(
                Command {
                    sequence: 1,
                    capability: capabilities[0],
                    kind: CommandKind::RxRelease { slot: released },
                },
                released,
            )
            .expect("return one global RX credit");
        loop_state
            .service_ready_queue(1)
            .expect("schedule queued connection first");
        assert_eq!(
            loop_state
                .pending_events
                .iter()
                .rev()
                .find(|event| event.kind == EventKind::RxReady)
                .expect("queued connection received data")
                .capability
                .index,
            8
        );
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn loopback_tcp_round_trip_exercises_private_and_shared_tx() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("loopback listener");
        let port = listener.local_addr().expect("listener address").port();
        let large_payload = (0..SLOT_SIZE)
            .map(|index| u8::try_from(index % 251).expect("bounded pattern"))
            .collect::<Vec<_>>();
        let server_payload = large_payload.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept broker connection");
            let mut request = [0_u8; 4];
            stream.read_exact(&mut request).expect("read guest TX");
            assert_eq!(&request, b"ping");
            let mut request = vec![0_u8; SLOT_SIZE];
            stream
                .read_exact(&mut request)
                .expect("read shared-slot guest TX");
            assert_eq!(request, server_payload);
            stream.write_all(b"pong").expect("write guest RX");
        });

        let memory = ServiceMemory::new(41).expect("mailbox");
        let notifier = Arc::new(CountNotifier::default());
        let handle = spawn_with_notifier(
            memory.clone(),
            notifier.clone(),
            Arc::new(AllowList::default().allow(IpAddr::V4(Ipv4Addr::LOCALHOST), port..=port)),
            Arc::new(DenyAll),
        )
        .expect("broker");
        let capability = Capability {
            index: 0,
            generation: 1,
            session: memory.session(),
        };
        let endpoint = [
            2,
            0,
            port.to_be_bytes()[0],
            port.to_be_bytes()[1],
            127,
            0,
            0,
            1,
        ];
        write_bytes(&memory.g2h, DATA_OFFSET, &endpoint);
        publish(
            &memory,
            0,
            Command {
                sequence: 1,
                capability,
                kind: CommandKind::Connect { slot: 0, length: 8 },
            },
        );
        handle.notify_guest_requests().expect("connect wake");
        let mut response_consumer = 0;
        let connected = next_event(&memory, &mut response_consumer);
        assert_eq!(connected.kind, EventKind::Connected);
        assert_eq!(connected.sequence, 1);

        write_bytes(&memory.g2h, DATA_OFFSET + SLOT_SIZE, b"ping");
        publish(
            &memory,
            1,
            Command {
                sequence: 2,
                capability,
                kind: CommandKind::Tx {
                    slot: 1,
                    offset: 0,
                    length: 4,
                },
            },
        );
        write_bytes(&memory.g2h, DATA_OFFSET + 2 * SLOT_SIZE, &large_payload);
        publish(
            &memory,
            2,
            Command {
                sequence: 3,
                capability,
                kind: CommandKind::Tx {
                    slot: 2,
                    offset: 0,
                    length: u32::try_from(SLOT_SIZE).expect("slot size fits wire"),
                },
            },
        );
        handle.notify_guest_requests().expect("TX wake");

        let mut tx_completions = 0;
        let mut rx = None;
        while tx_completions != 2 || rx.is_none() {
            let event = next_event(&memory, &mut response_consumer);
            match event.kind {
                EventKind::TxComplete => tx_completions += 1,
                EventKind::RxReady => rx = Some((event.slot, event.length)),
                EventKind::Closed if rx.is_some() => {}
                other => panic!("unexpected broker event {other:?}: {event:?}"),
            }
        }
        let (rx_slot, rx_length) = rx.expect("RX event");
        assert_eq!(rx_length, 4);
        let rx_length = usize::try_from(rx_length).expect("fixed RX length fits usize");
        let rx_start = DATA_OFFSET + usize::from(rx_slot) * SLOT_SIZE;
        let mut rx_bytes = Vec::with_capacity(rx_length);
        for offset in 0..rx_length {
            // SAFETY: The response producer published this guest-read-only RX
            // slot; volatile reads model the concurrently shared guest side.
            rx_bytes.push(unsafe {
                ptr::read_volatile(memory.h2g.as_ptr().as_ptr().add(rx_start + offset))
            });
        }
        assert_eq!(&rx_bytes, b"pong");
        assert!(notifier.0.load(Ordering::Relaxed) > 0);
        let stats = handle.stats();
        assert_eq!(stats.guest_doorbells, 2);
        assert_eq!(stats.commands_drained, 3);
        assert_eq!(stats.tx_slots, 2);
        assert_eq!(stats.tx_bytes, 4 + SLOT_SIZE as u64);
        assert_eq!(stats.rx_slots, 1);
        assert_eq!(stats.rx_bytes, 4);
        assert!(stats.events_published >= 3);
        assert!(stats.guest_irq_injections > 0);
        assert!(stats.poll_wakeups > 0);
        assert!(stats.reactor_turns > 0);
        assert!(stats.broker_cpu_ns > 0);

        server.join().expect("server");
        handle.shutdown().expect("clean broker shutdown");
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn loopback_dns_round_trip_is_port_53_shaped_and_bounded() {
        let server = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).expect("UDP listener");
        let port = server.local_addr().expect("UDP address").port();
        let responder = thread::spawn(move || {
            let mut query = [0_u8; 512];
            let (length, peer) = server.recv_from(&mut query).expect("receive DNS query");
            assert!(length >= 12);
            let mut response = query[..length].to_vec();
            response[2] |= 0x80;
            response[0..2].copy_from_slice(&0xabcd_u16.to_be_bytes());
            server
                .send_to(&response, peer)
                .expect("send unmatched DNS response");
            response[0..2].copy_from_slice(&0x1234_u16.to_be_bytes());
            server.send_to(&response, peer).expect("send DNS response");
        });

        // The production path fixes DNS to port 53. The unit test drives the
        // same state machine with a loopback ephemeral port by constructing
        // the loop directly; policy/port rejection has separate tests.
        let memory = ServiceMemory::new(42).expect("mailbox");
        let notifier = Arc::new(CountNotifier::default());
        let mut loop_state = super::BrokerLoop::new(
            Poll::new().expect("poll"),
            memory.clone(),
            notifier.clone(),
            Arc::new(DenyAll),
            Arc::new(DnsAllowList::default().allow(Ipv4Addr::LOCALHOST)),
        )
        .expect("broker loop");
        let capability = Capability {
            index: 0,
            generation: 1,
            session: memory.session(),
        };
        let mut query = vec![0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
        query.extend_from_slice(b"\x07example\x03com\0\0\x01\0\x01");
        let query_length = u32::try_from(query.len()).expect("bounded DNS query");
        let endpoint = [
            2,
            0,
            port.to_be_bytes()[0],
            port.to_be_bytes()[1],
            127,
            0,
            0,
            1,
        ];
        write_bytes(&memory.g2h, DATA_OFFSET, &endpoint);
        write_bytes(&memory.g2h, DATA_OFFSET + 8, &query);

        // Exercise the private helper with the test resolver's ephemeral port;
        // public `submit_dns` independently enforces port 53 before this point.
        let socket = StdUdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).expect("bind UDP");
        socket
            .connect((Ipv4Addr::LOCALHOST, port))
            .expect("connect UDP");
        socket.set_nonblocking(true).expect("nonblocking UDP");
        let mut socket = MioUdpSocket::from_std(socket);
        let poll_token = loop_state
            .allocate_registration_token()
            .expect("allocate DNS poll token");
        loop_state
            .poll
            .registry()
            .register(
                &mut socket,
                poll_token,
                Interest::READABLE | Interest::WRITABLE,
            )
            .expect("register UDP");
        loop_state.registrations.insert(poll_token.0, capability);
        loop_state
            .state
            .open_capability(0)
            .expect("open capability");
        loop_state.dns_connections[0] = Some(DnsConnection {
            socket,
            poll_token,
            capability,
            resolver: SocketAddrV4::new(Ipv4Addr::LOCALHOST, port),
            pending_tx: VecDeque::new(),
            outstanding_ids: VecDeque::new(),
            rx_inflight: 0,
        });
        loop_state
            .state
            .submit_tx(capability, 0, 8, query_length)
            .expect("reserve query slot");
        loop_state.dns_connections[0]
            .as_mut()
            .expect("DNS connection")
            .pending_tx
            .push_back(PendingDnsQuery {
                capability,
                slot: 0,
                sequence: 1,
                transaction_id: 0x1234,
                bytes: query.clone(),
            });
        loop_state.flush_dns(0).expect("send DNS query");
        assert!(!dns_transaction_available(
            loop_state.dns_connections[0]
                .as_ref()
                .expect("DNS connection"),
            0x1234
        ));
        let deadline = Instant::now() + Duration::from_secs(3);
        while loop_state.dns_connections[0]
            .as_ref()
            .expect("DNS connection")
            .outstanding_ids
            .contains(&0x1234)
        {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for DNS response"
            );
            thread::sleep(Duration::from_millis(1));
            loop_state.receive_dns(0).expect("receive DNS response");
        }
        assert!(
            loop_state
                .pending_events
                .iter()
                .any(|event| event.kind == EventKind::DnsTxComplete)
        );
        assert!(
            loop_state
                .pending_events
                .iter()
                .any(|event| event.kind == EventKind::DnsRxReady && event.length == query_length)
        );
        assert!(notifier.0.load(Ordering::Relaxed) == 0);
        responder.join().expect("DNS responder");
    }

    #[test]
    fn dns_policy_cannot_authorize_a_non_dns_udp_port() {
        let memory = ServiceMemory::new(43).expect("mailbox");
        let notifier = Arc::new(CountNotifier::default());
        let mut loop_state = super::BrokerLoop::new(
            Poll::new().expect("poll"),
            memory.clone(),
            notifier,
            Arc::new(DenyAll),
            Arc::new(DnsAllowList::default().allow(Ipv4Addr::LOCALHOST)),
        )
        .expect("broker loop");
        let capability = Capability {
            index: 0,
            generation: 1,
            session: memory.session(),
        };
        let mut query = vec![0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
        query.extend_from_slice(b"\x07example\x03com\0\0\x01\0\x01");
        let query_length = u32::try_from(query.len()).expect("bounded DNS query");
        let endpoint = [2, 0, 0x14, 0xe9, 127, 0, 0, 1]; // UDP/5353
        write_bytes(&memory.g2h, DATA_OFFSET, &endpoint);
        write_bytes(&memory.g2h, DATA_OFFSET + 8, &query);
        loop_state
            .handle_command(Command {
                sequence: 1,
                capability,
                kind: CommandKind::DnsQuery {
                    slot: 0,
                    length: query_length,
                },
            })
            .expect("denial event");
        let event = loop_state.pending_events.pop_front().expect("error event");
        assert_eq!(event.kind, EventKind::Error);
        assert_eq!(event.status, -libc::EACCES);
        assert!(loop_state.state.capability(0).is_none());
    }
}
