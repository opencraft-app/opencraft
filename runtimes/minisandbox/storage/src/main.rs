//! Command-line checker for the non-authoritative Rust protocol prototype.

use std::{env, process::ExitCode};

#[cfg(feature = "fault-injection")]
use std::path::PathBuf;

#[cfg(feature = "fault-injection")]
use minisandbox_storage_service::sqlite_metastore::{CrashPoint, run_crash_probe};
use minisandbox_storage_service::{InjectedFault, Protocol};
use stateright::{Checker, Model};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("storage-model: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    match arguments.next().as_deref() {
        Some("check") if arguments.next().is_none() => {
            check_safe();
            Ok(())
        }
        Some("counterexample") => {
            let fault = parse_fault(arguments.next().as_deref())?;
            if arguments.next().is_some() {
                return Err(usage());
            }
            show_counterexample(fault)
        }
        #[cfg(feature = "fault-injection")]
        Some("__sqlite-crash-probe") => {
            let database = required_path(arguments.next(), "database path")?;
            let marker = required_path(arguments.next(), "marker path")?;
            let point = arguments
                .next()
                .ok_or_else(|| "missing crash point".to_owned())
                .and_then(|value| CrashPoint::parse(&value).map_err(|error| error.to_string()))?;
            if arguments.next().is_some() {
                return Err("too many crash-probe arguments".to_owned());
            }
            run_crash_probe(&database, &marker, point).map_err(|error| error.to_string())
        }
        _ => Err(usage()),
    }
}

#[cfg(feature = "fault-injection")]
fn required_path(value: Option<String>, name: &str) -> Result<PathBuf, String> {
    value
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| format!("missing {name}"))
}

fn check_safe() {
    let checker = Protocol::safe().checker().spawn_bfs().join();
    checker.assert_properties();
    println!(
        "MINISANDBOX_STORAGE_RUST_PROTOTYPE_OK not_authoritative=true unique_states={} explored_states={} max_depth={}",
        checker.unique_state_count(),
        checker.state_count(),
        checker.max_depth()
    );
}

fn show_counterexample(fault: InjectedFault) -> Result<(), String> {
    let property = fault
        .violated_property()
        .ok_or_else(|| "safe protocol has no expected counterexample".to_owned())?;
    let checker = Protocol::with_fault(fault).checker().spawn_bfs().join();
    let Some(path) = checker.discovery(property) else {
        return Err(format!(
            "checker found no counterexample for {fault:?} against {property}"
        ));
    };
    println!("MINISANDBOX_STORAGE_COUNTEREXAMPLE fault={fault:?} property={property}");
    print!("{path}");
    Ok(())
}

fn parse_fault(value: Option<&str>) -> Result<InjectedFault, String> {
    match value {
        Some("ack-before-sync") => Ok(InjectedFault::AckBeforeCbsSync),
        Some("commit-before-put") => Ok(InjectedFault::CommitBeforeS3Put),
        Some("reclaim-before-manifest") => Ok(InjectedFault::ReclaimBeforeManifest),
        Some("accept-stale-epoch") => Ok(InjectedFault::AcceptStaleEpoch),
        _ => Err(usage()),
    }
}

fn usage() -> String {
    "usage: minisandbox-storage-service check | counterexample <ack-before-sync|commit-before-put|reclaim-before-manifest|accept-stale-epoch>".to_owned()
}
