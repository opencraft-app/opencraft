//! Standalone guest PID 1 entry point.

use std::{env, process::ExitCode};

fn main() -> ExitCode {
    minisandbox_init::entry(env::args_os().skip(1))
}
