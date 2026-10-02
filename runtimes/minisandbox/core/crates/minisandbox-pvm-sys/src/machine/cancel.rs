//! One-shot, host-only cancellation for a running PVM vCPU.

use std::{
    fmt, io,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use kvm_ioctls::{Kvm, KvmRunWrapper, VcpuFd};
use vmm_sys_util::eventfd::EventFd;

use crate::PvmDeviceError;

use super::kvm_error;

#[derive(Clone, Copy)]
struct Runner {
    thread_id: libc::pid_t,
    signal: libc::c_int,
}

struct CancellationInner {
    run: Option<KvmRunWrapper>,
    runner: Option<Runner>,
}

/// Shared state behind one terminal runner-cancellation capability.
pub(super) struct PvmRunCancellation {
    requested: AtomicBool,
    inner: Mutex<CancellationInner>,
    wait_wake: Arc<EventFd>,
}

/// A cloneable, host-only capability that stops one PVM runner.
///
/// Cancellation is terminal and idempotent: once requested, every current or
/// future timed run for the machine returns [`crate::PvmExit::Cancelled`]. The
/// handle carries no guest address, interrupt number, or hypercall argument.
/// It is intended for sandbox destruction, terminal request deadlines, host
/// shutdown, and quota eviction—not for pausing and later reusing a sandbox.
#[derive(Clone)]
pub struct PvmRunCanceller {
    state: Arc<PvmRunCancellation>,
}

impl PvmRunCancellation {
    pub(super) fn new(
        kvm: &Kvm,
        vcpu: &VcpuFd,
        wait_wake: Arc<EventFd>,
    ) -> Result<Self, PvmDeviceError> {
        let run_size = kvm
            .get_vcpu_mmap_size()
            .map_err(|error| kvm_error("get cancellation run mapping size", error))?;
        let run = KvmRunWrapper::mmap_from_fd(vcpu, run_size)
            .map_err(|error| kvm_error("map cancellation run state", error))?;
        Ok(Self {
            requested: AtomicBool::new(false),
            inner: Mutex::new(CancellationInner {
                run: Some(run),
                runner: None,
            }),
            wait_wake,
        })
    }

    #[cfg(test)]
    fn detached(wait_wake: Arc<EventFd>) -> Self {
        Self {
            requested: AtomicBool::new(false),
            inner: Mutex::new(CancellationInner {
                run: None,
                runner: None,
            }),
            wait_wake,
        }
    }

    pub(super) fn handle(self: &Arc<Self>) -> PvmRunCanceller {
        PvmRunCanceller {
            state: Arc::clone(self),
        }
    }

    pub(super) fn requested(&self) -> bool {
        self.requested.load(Ordering::Acquire)
    }

    /// Publishes the only host thread that cancellation is allowed to signal.
    ///
    /// The second mapping of `kvm_run` closes the race between checking the
    /// cancellation bit and entering KVM: a pre-entry request leaves
    /// `immediate_exit` set, while an in-flight request sets it before sending
    /// the non-restarting signal.
    pub(super) fn register(&self, thread_id: libc::pid_t, signal: libc::c_int) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        debug_assert!(inner.runner.is_none());
        inner.runner = Some(Runner { thread_id, signal });
        let immediate_exit = u8::from(self.requested());
        if let Some(run) = inner.run.as_mut() {
            run.as_mut_ref().immediate_exit = immediate_exit;
        }
    }

    pub(super) fn unregister(&self, thread_id: libc::pid_t, signal: libc::c_int) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(runner) = inner.runner {
            debug_assert_eq!(runner.thread_id, thread_id);
            debug_assert_eq!(runner.signal, signal);
        }
        inner.runner = None;
    }

    /// Removes the auxiliary `kvm_run` mapping before the owning vCPU closes.
    pub(super) fn detach(&self) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        debug_assert!(inner.runner.is_none());
        inner.runner = None;
        inner.run = None;
    }
}

impl PvmRunCanceller {
    /// Requests terminal cancellation and wakes every place the runner can park.
    ///
    /// Returns `true` for the first request and `false` for repeated requests.
    /// A successful return guarantees that the cancellation bit and KVM's
    /// `immediate_exit` flag were published before any runner signal was sent.
    ///
    /// # Errors
    ///
    /// Returns an I/O error only if waking the fixed eventfd or signaling the
    /// currently registered runner thread fails.
    pub fn cancel(&self) -> io::Result<bool> {
        let first = !self.state.requested.swap(true, Ordering::AcqRel);
        let mut inner = self
            .state
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(run) = inner.run.as_mut() {
            run.as_mut_ref().immediate_exit = 1;
        }

        // Keep registration locked through tgkill. This prevents the timed
        // run from dropping the leased signal handler or allowing TID reuse
        // between reading the fixed target and delivering the signal.
        let signal_result = if let Some(runner) = inner.runner {
            // SAFETY: tgkill receives the current process ID, a runner TID
            // registered while its signal lease is live, and that lease's
            // validated realtime signal number.
            let result = unsafe {
                libc::syscall(
                    libc::SYS_tgkill,
                    libc::getpid(),
                    runner.thread_id,
                    runner.signal,
                )
            };
            (result != 0).then(io::Error::last_os_error)
        } else {
            None
        };
        drop(inner);

        // WAIT_UNTIL parks in ppoll rather than KVM_RUN, so it needs a second
        // fixed wake path. A saturated eventfd already represents success.
        let wake_result = self.state.wait_wake.write(1).or_else(|error| {
            if error.kind() == io::ErrorKind::WouldBlock {
                Ok(())
            } else {
                Err(error)
            }
        });
        if let Some(error) = signal_result {
            return Err(error);
        }
        wake_result?;
        Ok(first)
    }

    /// Returns whether terminal cancellation has already been requested.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.state.requested()
    }
}

impl fmt::Debug for PvmRunCanceller {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PvmRunCanceller")
            .field("cancelled", &self.is_cancelled())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use vmm_sys_util::eventfd::{EFD_CLOEXEC, EFD_NONBLOCK, EventFd};

    use super::PvmRunCancellation;

    #[test]
    fn detached_cancellation_is_terminal_idempotent_and_wakes_waiters() {
        let wake = Arc::new(EventFd::new(EFD_CLOEXEC | EFD_NONBLOCK).expect("eventfd"));
        let state = Arc::new(PvmRunCancellation::detached(Arc::clone(&wake)));
        let canceller = state.handle();

        assert!(!canceller.is_cancelled());
        assert!(canceller.cancel().expect("first cancellation"));
        assert!(canceller.is_cancelled());
        assert_eq!(wake.read().expect("first wake"), 1);

        assert!(!canceller.cancel().expect("repeated cancellation"));
        assert_eq!(wake.read().expect("repeated wake"), 1);
    }
}
