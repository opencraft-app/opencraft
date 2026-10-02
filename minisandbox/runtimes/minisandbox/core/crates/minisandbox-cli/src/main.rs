//! Minisandbox command-line entry point.

use std::{env, ffi::OsStr, process::ExitCode};

const USAGE: &str = "Usage:\n  minisandbox init [--mode warm|console] [-- PROGRAM [ARG...]]\n";

fn main() -> ExitCode {
    let mut arguments = env::args_os().skip(1);
    match arguments.next() {
        Some(command) if command == "init" => minisandbox_init::entry(arguments),
        Some(command) if command == "-h" || command == "--help" => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        Some(command) => unknown_command(&command),
        None => {
            eprint!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn unknown_command(command: &OsStr) -> ExitCode {
    eprintln!(
        "minisandbox: unknown command {}\n{USAGE}",
        command.to_string_lossy()
    );
    ExitCode::from(2)
}
