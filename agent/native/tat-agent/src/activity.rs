use std::sync::OnceLock;

use anyhow::{Result, anyhow};

pub const TAT_TASK: u32 = 1;
pub const TERMINAL_SESSION: u32 = 2;

pub type ActivityAcquire = extern "C" fn(u32) -> u64;
pub type ActivityRelease = extern "C" fn(u64);

struct Callbacks {
    acquire: ActivityAcquire,
    release: ActivityRelease,
}

static CALLBACKS: OnceLock<Callbacks> = OnceLock::new();

pub fn configure(acquire: Option<ActivityAcquire>, release: Option<ActivityRelease>) -> Result<()> {
    let callbacks = Callbacks {
        acquire: acquire.ok_or_else(|| anyhow!("activity acquire callback is required"))?,
        release: release.ok_or_else(|| anyhow!("activity release callback is required"))?,
    };
    CALLBACKS
        .set(callbacks)
        .map_err(|_| anyhow!("activity callbacks are already configured"))
}

pub struct ActivityLease {
    token: u64,
}

impl ActivityLease {
    pub fn acquire(kind: u32) -> Option<Self> {
        let Some(callbacks) = CALLBACKS.get() else {
            return Some(Self { token: 0 });
        };
        let token = (callbacks.acquire)(kind);
        (token != 0).then_some(Self { token })
    }
}

impl Drop for ActivityLease {
    fn drop(&mut self) {
        if self.token != 0
            && let Some(callbacks) = CALLBACKS.get()
        {
            (callbacks.release)(self.token);
        }
    }
}
