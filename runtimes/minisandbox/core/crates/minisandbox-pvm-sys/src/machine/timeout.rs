//! Persistent, thread-directed execution deadlines for PVM vCPUs.

use std::{
    io,
    ops::{Deref, DerefMut},
    time::{Duration, Instant},
};

use crate::{PvmDeviceError, PvmExit, signal::SignalLease};

use super::{PvmMachine, kvm_error};

/// Short waits remain in KVM, where halt polling avoids a host scheduler trip.
/// Longer waits park immediately in userspace so an idle clone does not spend
/// the provider's full halt-poll interval busy waiting.
const MIN_HOST_GUEST_WAIT: Duration = Duration::from_micros(50);
const LINUX_SIGEV_THREAD_ID: libc::c_int = 4;

#[derive(Default)]
pub(super) struct TimeoutTimer {
    timer_id: Option<usize>,
    signal: libc::c_int,
    thread_id: libc::pid_t,
}

/// One wall-clock deadline armed across a complete PVM exit-processing loop.
///
/// The timeout signal is unblocked only while the vCPU is inside `KVM_RUN`.
/// Host-side syscall, device, and hypercall handling therefore cannot be
/// interrupted by the execution watchdog.
pub struct PvmTimedRun<'machine> {
    machine: &'machine mut PvmMachine,
    signal: SignalLease,
    thread_id: libc::pid_t,
    deadline: Instant,
}

impl TimeoutTimer {
    fn arm(
        &mut self,
        signal: libc::c_int,
        thread_id: libc::pid_t,
        timeout: Duration,
    ) -> Result<(), PvmDeviceError> {
        self.bind(signal, thread_id)?;
        let seconds = timeout
            .as_secs()
            .try_into()
            .map_err(|error| kvm_error("convert PVM execution timeout", error))?;
        let specification = libc::itimerspec {
            it_interval: zero_time(),
            it_value: libc::timespec {
                tv_sec: seconds,
                tv_nsec: libc::c_long::from(timeout.subsec_nanos()),
            },
        };
        // SAFETY: `timer_id` identifies the live timer retained by this
        // object, and `specification` is fully initialized. A null old-value
        // pointer means no previous deadline is requested.
        if unsafe {
            libc::timer_settime(
                self.raw_timer_id(),
                0,
                std::ptr::addr_of!(specification),
                std::ptr::null_mut(),
            )
        } != 0
        {
            return Err(kvm_error(
                "arm PVM execution timer",
                io::Error::last_os_error(),
            ));
        }
        Ok(())
    }

    fn bind(&mut self, signal: libc::c_int, thread_id: libc::pid_t) -> Result<(), PvmDeviceError> {
        if self.timer_id.is_some() && self.signal == signal && self.thread_id == thread_id {
            return Ok(());
        }
        self.delete()?;

        // SAFETY: Zero is a valid baseline for sigevent; every field observed
        // by timer_create is assigned below. SIGEV_THREAD_ID is Linux-specific
        // and directs delivery only to the host thread entering KVM_RUN.
        let mut event: libc::sigevent = unsafe { std::mem::zeroed() };
        event.sigev_notify = LINUX_SIGEV_THREAD_ID;
        event.sigev_signo = signal;
        event.sigev_notify_thread_id = thread_id;
        // SAFETY: timer_create writes one owned timer identifier to initialized
        // storage and retains no pointer to the stack-allocated event.
        let mut timer_id: libc::timer_t = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::timer_create(
                libc::CLOCK_MONOTONIC,
                std::ptr::addr_of_mut!(event),
                std::ptr::addr_of_mut!(timer_id),
            )
        } != 0
        {
            return Err(kvm_error(
                "create persistent PVM execution timer",
                io::Error::last_os_error(),
            ));
        }
        self.timer_id = Some(timer_id.expose_provenance());
        self.signal = signal;
        self.thread_id = thread_id;
        Ok(())
    }

    fn disarm(&mut self) -> Result<(), PvmDeviceError> {
        if self.timer_id.is_none() {
            return Ok(());
        }
        let specification = libc::itimerspec {
            it_interval: zero_time(),
            it_value: zero_time(),
        };
        // SAFETY: The retained identifier is live and a zero value disarms
        // the timer without changing its thread or signal binding.
        if unsafe {
            libc::timer_settime(
                self.raw_timer_id(),
                0,
                std::ptr::addr_of!(specification),
                std::ptr::null_mut(),
            )
        } != 0
        {
            return Err(kvm_error(
                "disarm PVM execution timer",
                io::Error::last_os_error(),
            ));
        }
        Ok(())
    }

    fn disarm_or_delete(&mut self) {
        if self.disarm().is_err() {
            let _ = self.delete();
        }
    }

    fn delete(&mut self) -> Result<(), PvmDeviceError> {
        let Some(timer_id) = self.timer_id else {
            return Ok(());
        };
        // SAFETY: The exposed-provenance integer came from one successful
        // timer_create and ownership remains here until successful deletion.
        if unsafe { libc::timer_delete(std::ptr::with_exposed_provenance_mut(timer_id)) } != 0 {
            return Err(kvm_error(
                "delete PVM execution timer",
                io::Error::last_os_error(),
            ));
        }
        self.timer_id = None;
        self.signal = 0;
        self.thread_id = 0;
        Ok(())
    }

    fn raw_timer_id(&self) -> libc::timer_t {
        std::ptr::with_exposed_provenance_mut(
            self.timer_id
                .expect("a PVM execution timer is bound before use"),
        )
    }
}

impl Drop for TimeoutTimer {
    fn drop(&mut self) {
        self.disarm_or_delete();
        let _ = self.delete();
    }
}

impl PvmMachine {
    /// Arms one monotonic timeout across a complete host exit-processing loop.
    ///
    /// The underlying POSIX timer is retained by this machine and rebound only
    /// when the machine moves to another host thread or the process-wide signal
    /// lease changes. Call [`PvmTimedRun::run_once`] repeatedly without
    /// recreating a timer or helper thread for each exit.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Kvm`] when signal or timer setup fails.
    pub fn start_timed_run(
        &mut self,
        timeout: Duration,
    ) -> Result<PvmTimedRun<'_>, PvmDeviceError> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| PvmDeviceError::Kvm {
                operation: "compute PVM execution deadline",
                message: "timeout exceeds the host monotonic clock range".to_owned(),
            })?;
        let signal =
            SignalLease::acquire().map_err(|error| kvm_error("lease PVM timeout signal", error))?;
        let thread_id = current_thread_id()?;
        self.timeout_timer
            .arm(signal.signal(), thread_id, timeout)?;
        self.run_cancel.register(thread_id, signal.signal());
        Ok(PvmTimedRun {
            machine: self,
            signal,
            thread_id,
            deadline,
        })
    }

    /// Runs until one KVM exit or a monotonic host timeout interrupts the vCPU.
    ///
    /// Prefer [`Self::start_timed_run`] when a caller processes several exits
    /// under one deadline. This compatibility wrapper still reuses the
    /// machine's persistent timer and never creates a helper thread.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Kvm`] when signal setup or `KVM_RUN` fails
    /// before the requested timeout fires.
    pub fn run_once_with_timeout(&mut self, timeout: Duration) -> Result<PvmExit, PvmDeviceError> {
        self.start_timed_run(timeout)?.run_once()
    }
}

impl PvmTimedRun<'_> {
    /// Runs until the next host-visible exit or this run's fixed deadline.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Kvm`] when the signal mask or `KVM_RUN`
    /// operation fails before the deadline.
    pub fn run_once(&mut self) -> Result<PvmExit, PvmDeviceError> {
        loop {
            if self.machine.run_cancel.requested() {
                return Ok(PvmExit::Cancelled);
            }
            if Instant::now() >= self.deadline {
                return Ok(PvmExit::TimedOut);
            }
            self.signal
                .unblock()
                .map_err(|error| kvm_error("unblock PVM timeout signal", error))?;
            let result = self.machine.run_once();
            self.signal
                .block()
                .map_err(|error| kvm_error("block PVM timeout signal", error))?;
            if self.machine.run_cancel.requested() {
                return Ok(PvmExit::Cancelled);
            }
            if Instant::now() >= self.deadline {
                return Ok(PvmExit::TimedOut);
            }
            let exit = result?;
            let PvmExit::WaitUntil { timeout_ns } = exit else {
                return Ok(exit);
            };

            // The first wait only enables wake forwarding. Re-enter KVM once
            // so an IRQ that raced the transition is consumed by the existing
            // PVM halt path rather than being delayed until this deadline.
            if self.machine.arm_wait_wake() {
                self.machine.run_stats.wait_until_arms =
                    self.machine.run_stats.wait_until_arms.saturating_add(1);
                continue;
            }

            let requested = Duration::from_nanos(timeout_ns);
            let remaining = self.deadline.saturating_duration_since(Instant::now());
            let wait = requested.min(remaining);
            if wait < MIN_HOST_GUEST_WAIT {
                self.machine.run_stats.wait_until_short =
                    self.machine.run_stats.wait_until_short.saturating_add(1);
                continue;
            }
            self.machine.run_stats.wait_until_parks =
                self.machine.run_stats.wait_until_parks.saturating_add(1);
            if self.machine.wait_for_device_or_timeout(wait)? {
                self.machine.run_stats.wait_device_wakes =
                    self.machine.run_stats.wait_device_wakes.saturating_add(1);
            } else {
                self.machine.run_stats.wait_deadline_wakes =
                    self.machine.run_stats.wait_deadline_wakes.saturating_add(1);
            }
        }
    }
}

impl Deref for PvmTimedRun<'_> {
    type Target = PvmMachine;

    fn deref(&self) -> &Self::Target {
        self.machine
    }
}

impl DerefMut for PvmTimedRun<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.machine
    }
}

impl Drop for PvmTimedRun<'_> {
    fn drop(&mut self) {
        self.machine
            .run_cancel
            .unregister(self.thread_id, self.signal.signal());
        // SignalLease remains alive and the signal remains blocked until after
        // this method, so a queued expiration cannot observe a default action.
        self.machine.timeout_timer.disarm_or_delete();
    }
}

const fn zero_time() -> libc::timespec {
    libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    }
}

fn current_thread_id() -> Result<libc::pid_t, PvmDeviceError> {
    // SAFETY: gettid takes no arguments and returns the calling Linux thread's
    // stable ID, which SIGEV_THREAD_ID requires for directed timer delivery.
    let thread_id = unsafe { libc::syscall(libc::SYS_gettid) };
    if thread_id <= 0 {
        return Err(kvm_error(
            "identify PVM runner thread",
            io::Error::last_os_error(),
        ));
    }
    libc::pid_t::try_from(thread_id).map_err(|error| kvm_error("identify PVM runner thread", error))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use crate::signal::{SIGNAL_TEST_LOCK, SignalLease};

    use super::{TimeoutTimer, current_thread_id};

    #[test]
    fn persistent_timer_reuses_its_binding_and_tracks_thread_migration() {
        let _lock = SIGNAL_TEST_LOCK.lock().expect("signal test lock");
        let lease = SignalLease::acquire().expect("timeout signal lease");
        let first_thread = current_thread_id().expect("runner thread ID");
        let mut timer = TimeoutTimer::default();
        timer
            .arm(lease.signal(), first_thread, Duration::from_mins(1))
            .expect("first timer arm");
        let first_timer = timer.timer_id;
        timer.disarm().expect("first timer disarm");
        timer
            .arm(lease.signal(), first_thread, Duration::from_mins(1))
            .expect("reused timer arm");
        assert_eq!(timer.timer_id, first_timer);
        timer.disarm().expect("reused timer disarm");
        drop(lease);

        let (timer, second_thread) = std::thread::spawn(move || {
            let lease = SignalLease::acquire().expect("migrated timeout signal lease");
            let second_thread = current_thread_id().expect("migrated runner thread ID");
            let mut timer = timer;
            timer
                .arm(lease.signal(), second_thread, Duration::from_mins(1))
                .expect("migrated timer arm");
            assert_eq!(timer.thread_id, second_thread);
            timer.disarm().expect("migrated timer disarm");
            (timer, second_thread)
        })
        .join()
        .expect("migrated timer thread");
        assert_ne!(first_thread, second_thread);
        drop(timer);
    }
}
