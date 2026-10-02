//! Local terminal mode scoped to the disposable console runner.

use std::io::{self, IsTerminal};

/// Restores the caller's terminal settings when the runner detaches normally.
pub struct RawTerminal {
    original: Option<libc::termios>,
}

impl RawTerminal {
    /// Switches an interactive stdin terminal to byte-at-a-time, no-local-echo mode.
    ///
    /// Pipes and redirected input are left unchanged.
    pub fn enable() -> io::Result<Self> {
        if !io::stdin().is_terminal() {
            return Ok(Self { original: None });
        }
        // SAFETY: `tcgetattr` initializes the complete termios object for the
        // live stdin descriptor. No pointer escapes this call.
        let mut original = unsafe { std::mem::zeroed::<libc::termios>() };
        if unsafe { libc::tcgetattr(libc::STDIN_FILENO, &raw mut original) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let mut raw = original;
        // SAFETY: `raw` is an initialized local termios value.
        unsafe { libc::cfmakeraw(&raw mut raw) };
        // SAFETY: stdin was established as a terminal above and `raw` remains
        // valid for the duration of this call.
        if unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &raw const raw) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            original: Some(original),
        })
    }
}

impl Drop for RawTerminal {
    fn drop(&mut self) {
        let Some(original) = self.original.as_ref() else {
            return;
        };
        // SAFETY: `original` was returned for this same live terminal. Drop
        // cannot report an error, so restoration is best-effort.
        let _ = unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, original) };
    }
}
