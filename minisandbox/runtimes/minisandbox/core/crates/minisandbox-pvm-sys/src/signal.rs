//! Scoped host-signal ownership for interrupting a blocked PVM vCPU.

use std::{io, marker::PhantomData, rc::Rc, sync::Mutex};

static SIGNAL_MANAGER: Mutex<SignalManagerState> = Mutex::new(SignalManagerState {
    signal: None,
    leases: 0,
    previous_action: None,
});

#[cfg(test)]
pub(crate) static SIGNAL_TEST_LOCK: Mutex<()> = Mutex::new(());

struct SignalManagerState {
    signal: Option<libc::c_int>,
    leases: usize,
    previous_action: Option<libc::sigaction>,
}

extern "C" fn interrupt_handler(_signal: libc::c_int) {}

/// One dynamically selected signal installed only for a timed vCPU run.
pub(crate) struct SignalLease {
    signal: libc::c_int,
    previous_mask: libc::sigset_t,
    _thread_bound: PhantomData<Rc<()>>,
}

impl SignalLease {
    /// Installs a non-restarting handler on one currently unused RT signal and
    /// blocks that signal on the calling vCPU thread until `unblock` brackets
    /// an actual `KVM_RUN`.
    pub(crate) fn acquire() -> io::Result<Self> {
        let mut manager = SIGNAL_MANAGER
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let next_lease_count = manager
            .leases
            .checked_add(1)
            .ok_or_else(|| io::Error::other("PVM signal lease count overflowed"))?;
        let mut installed = false;
        let signal = if let Some(signal) = manager.signal {
            signal
        } else {
            let (signal, previous_action) = find_unused_signal()?;
            let _ = one_signal_set(signal)?;
            let action = handler_action()?;
            // SAFETY: Both action pointers address initialized sigaction values
            // and the signal is in libc's current realtime range.
            if unsafe { libc::sigaction(signal, std::ptr::addr_of!(action), std::ptr::null_mut()) }
                != 0
            {
                return Err(io::Error::last_os_error());
            }
            manager.signal = Some(signal);
            manager.previous_action = Some(previous_action);
            installed = true;
            signal
        };

        let set = one_signal_set(signal)?;
        // SAFETY: The set and output mask are valid storage. pthread_sigmask
        // applies only to the current vCPU thread. Keeping the timeout signal
        // blocked here prevents it from interrupting host-side exit handling.
        let mut previous_mask: libc::sigset_t = unsafe { std::mem::zeroed() };
        let mask_result = unsafe {
            libc::pthread_sigmask(
                libc::SIG_BLOCK,
                std::ptr::addr_of!(set),
                std::ptr::addr_of_mut!(previous_mask),
            )
        };
        if mask_result != 0 {
            if installed {
                if let Some(previous_action) = manager.previous_action.take() {
                    // SAFETY: Restore the disposition captured immediately
                    // before our failed attempt to update the thread mask.
                    unsafe {
                        libc::sigaction(
                            signal,
                            std::ptr::addr_of!(previous_action),
                            std::ptr::null_mut(),
                        );
                    }
                }
                manager.signal = None;
            }
            return Err(io::Error::from_raw_os_error(mask_result));
        }
        manager.leases = next_lease_count;
        Ok(Self {
            signal,
            previous_mask,
            _thread_bound: PhantomData,
        })
    }

    pub(crate) const fn signal(&self) -> libc::c_int {
        self.signal
    }

    /// Allows the leased signal to interrupt the calling vCPU thread.
    pub(crate) fn unblock(&self) -> io::Result<()> {
        self.update_mask(libc::SIG_UNBLOCK)
    }

    /// Prevents the leased signal from interrupting host-side exit handling.
    pub(crate) fn block(&self) -> io::Result<()> {
        self.update_mask(libc::SIG_BLOCK)
    }

    fn update_mask(&self, operation: libc::c_int) -> io::Result<()> {
        let set = one_signal_set(self.signal)?;
        // SAFETY: `set` is initialized and pthread_sigmask changes only the
        // calling thread. No previous mask is requested for this transition.
        let result = unsafe {
            libc::pthread_sigmask(operation, std::ptr::addr_of!(set), std::ptr::null_mut())
        };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(result))
        }
    }
}

impl Drop for SignalLease {
    fn drop(&mut self) {
        let Ok(set) = one_signal_set(self.signal) else {
            return;
        };
        // Block before restoring a possibly-default handler, then drain any
        // already-queued timer interrupt. The owning timed run disarmed or
        // deleted its timer before this lease can be dropped.
        let _ = self.block();
        let timeout = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        loop {
            // SAFETY: The signal is blocked on this thread, set is initialized,
            // and timeout requests a non-blocking pending-signal drain.
            let result = unsafe {
                libc::sigtimedwait(
                    std::ptr::addr_of!(set),
                    std::ptr::null_mut(),
                    std::ptr::addr_of!(timeout),
                )
            };
            if result != self.signal {
                break;
            }
        }

        let mut manager = SIGNAL_MANAGER
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if manager.signal == Some(self.signal) && manager.leases > 0 {
            manager.leases -= 1;
            if manager.leases == 0 {
                if let Some(previous_action) = manager.previous_action.take() {
                    // SAFETY: The last process-wide lease restores the exact
                    // action captured before the manager installed its handler.
                    unsafe {
                        libc::sigaction(
                            self.signal,
                            std::ptr::addr_of!(previous_action),
                            std::ptr::null_mut(),
                        );
                    }
                }
                manager.signal = None;
            }
        }
        // SAFETY: Restore the exact calling-thread mask captured by `acquire`.
        unsafe {
            libc::pthread_sigmask(
                libc::SIG_SETMASK,
                std::ptr::addr_of!(self.previous_mask),
                std::ptr::null_mut(),
            );
        }
    }
}

fn find_unused_signal() -> io::Result<(libc::c_int, libc::sigaction)> {
    for signal in libc::SIGRTMIN()..=libc::SIGRTMAX() {
        let previous_action = query_action(signal)?;
        if previous_action.sa_sigaction == libc::SIG_DFL {
            return Ok((signal, previous_action));
        }
    }
    Err(io::Error::other(
        "no unused realtime signal is available for PVM preemption",
    ))
}

fn query_action(signal: libc::c_int) -> io::Result<libc::sigaction> {
    // SAFETY: Zeroed storage is written completely by successful sigaction.
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    // SAFETY: A null new action queries the valid realtime signal disposition.
    if unsafe { libc::sigaction(signal, std::ptr::null(), std::ptr::addr_of_mut!(action)) } == 0 {
        Ok(action)
    } else {
        Err(io::Error::last_os_error())
    }
}

fn handler_action() -> io::Result<libc::sigaction> {
    // SAFETY: Remaining fields are initialized before installation.
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = interrupt_handler as *const () as libc::sighandler_t;
    action.sa_flags = 0;
    // SAFETY: The action mask is valid writable storage.
    if unsafe { libc::sigemptyset(std::ptr::addr_of_mut!(action.sa_mask)) } == 0 {
        Ok(action)
    } else {
        Err(io::Error::last_os_error())
    }
}

fn one_signal_set(signal: libc::c_int) -> io::Result<libc::sigset_t> {
    // SAFETY: The set is initialized by sigemptyset before it is observed.
    let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
    // SAFETY: `set` is writable and signal is from the current realtime range.
    if unsafe { libc::sigemptyset(std::ptr::addr_of_mut!(set)) } != 0
        || unsafe { libc::sigaddset(std::ptr::addr_of_mut!(set), signal) } != 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(set)
    }
}

#[cfg(test)]
mod tests {
    use super::{SIGNAL_TEST_LOCK, SignalLease, query_action};
    use std::sync::{Arc, Barrier, mpsc};

    extern "C" fn host_handler(_signal: libc::c_int) {}

    #[test]
    fn lease_uses_a_realtime_signal_and_restores_its_disposition() {
        let _lock = SIGNAL_TEST_LOCK.lock().expect("signal test lock");
        let lease = SignalLease::acquire().expect("one realtime signal should be available");
        let signal = lease.signal();
        assert!((libc::SIGRTMIN()..=libc::SIGRTMAX()).contains(&signal));
        drop(lease);

        // SAFETY: `action` is writable sigaction storage and `signal` was a
        // valid realtime signal selected above.
        let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
        assert_eq!(
            unsafe { libc::sigaction(signal, std::ptr::null(), std::ptr::addr_of_mut!(action),) },
            0
        );
        assert_eq!(action.sa_sigaction, libc::SIG_DFL);
    }

    #[test]
    fn lease_skips_a_signal_with_a_host_handler() {
        let _lock = SIGNAL_TEST_LOCK.lock().expect("signal test lock");
        let occupied = (libc::SIGRTMIN()..=libc::SIGRTMAX())
            .find(|signal| {
                query_action(*signal).is_ok_and(|action| action.sa_sigaction == libc::SIG_DFL)
            })
            .expect("one default realtime signal should be available");
        let previous = query_action(occupied).expect("query occupied signal");
        // SAFETY: All fields are initialized before sigaction observes them.
        let mut host_action: libc::sigaction = unsafe { std::mem::zeroed() };
        host_action.sa_sigaction = host_handler as *const () as libc::sighandler_t;
        // SAFETY: The mask and action address live initialized storage.
        assert_eq!(
            unsafe { libc::sigemptyset(std::ptr::addr_of_mut!(host_action.sa_mask)) },
            0
        );
        assert_eq!(
            // SAFETY: The action and mask are fully initialized above.
            unsafe {
                libc::sigaction(
                    occupied,
                    std::ptr::addr_of!(host_action),
                    std::ptr::null_mut(),
                )
            },
            0
        );

        let lease = SignalLease::acquire().expect("another realtime signal should be available");
        assert_ne!(lease.signal(), occupied);
        assert_eq!(
            query_action(occupied)
                .expect("query host action")
                .sa_sigaction,
            host_action.sa_sigaction
        );
        drop(lease);
        assert_eq!(
            query_action(occupied)
                .expect("query host action after drop")
                .sa_sigaction,
            host_action.sa_sigaction
        );

        // SAFETY: Restore the exact disposition captured before the test.
        assert_eq!(
            unsafe {
                libc::sigaction(occupied, std::ptr::addr_of!(previous), std::ptr::null_mut())
            },
            0
        );
    }

    #[test]
    fn concurrent_leases_share_one_handler_until_the_last_drop() {
        const THREADS: usize = 8;
        let _lock = SIGNAL_TEST_LOCK.lock().expect("signal test lock");
        let ready = Arc::new(Barrier::new(THREADS + 1));
        let release = Arc::new(Barrier::new(THREADS + 1));
        let (sender, receiver) = mpsc::channel();
        let threads: Vec<_> = (0..THREADS)
            .map(|_| {
                let ready = Arc::clone(&ready);
                let release = Arc::clone(&release);
                let sender = sender.clone();
                std::thread::spawn(move || {
                    let lease =
                        SignalLease::acquire().expect("one shared realtime signal is available");
                    sender.send(lease.signal()).expect("report leased signal");
                    ready.wait();
                    release.wait();
                    drop(lease);
                })
            })
            .collect();
        drop(sender);
        let signals: Vec<_> = receiver.iter().take(THREADS).collect();
        ready.wait();
        assert_eq!(signals.len(), THREADS);
        assert!(signals.iter().all(|signal| *signal == signals[0]));
        assert_ne!(
            query_action(signals[0])
                .expect("query shared manager action")
                .sa_sigaction,
            libc::SIG_DFL
        );
        release.wait();
        for thread in threads {
            thread.join().expect("lease thread completes");
        }
        assert_eq!(
            query_action(signals[0])
                .expect("query action after final drop")
                .sa_sigaction,
            libc::SIG_DFL
        );
    }
}
