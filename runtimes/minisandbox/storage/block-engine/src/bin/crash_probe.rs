//! Hidden SIGKILL crash-probe entry point.

use std::{env, path::PathBuf, process::ExitCode};

use minisandbox_block_engine::{
    CrashPoint, GcCrashPoint, PackCrashPoint, run_gc_crash_probe, run_pack_crash_probe,
    run_write_crash_probe,
};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("minisandbox-block-crash-probe: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    let database = required_path(arguments.next(), "database path")?;
    let marker = required_path(arguments.next(), "marker path")?;
    let point = arguments
        .next()
        .ok_or_else(|| "missing crash point".to_owned())?;
    let object_root = arguments.next().map(PathBuf::from);
    if arguments.next().is_some() {
        return Err("too many crash-probe arguments".to_owned());
    }
    if let Ok(point) = CrashPoint::parse(&point) {
        if object_root.is_some() {
            return Err("write crash probe does not accept an object root".to_owned());
        }
        return run_write_crash_probe(&database, &marker, point).map_err(|error| error.to_string());
    }
    let object_root =
        object_root.ok_or_else(|| "pack/GC crash probe needs an object root".to_owned())?;
    if let Ok(point) = PackCrashPoint::parse(&point) {
        return run_pack_crash_probe(&database, &object_root, &marker, point)
            .map_err(|error| error.to_string());
    }
    let point = GcCrashPoint::parse(&point).map_err(|error| error.to_string())?;
    run_gc_crash_probe(&database, &object_root, &marker, point).map_err(|error| error.to_string())
}

fn required_path(value: Option<String>, name: &str) -> Result<PathBuf, String> {
    value
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| format!("missing {name}"))
}
