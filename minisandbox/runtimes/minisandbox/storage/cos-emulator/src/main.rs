//! Standalone command-line process for the COS consistency emulator.

use std::{env, net::SocketAddr, path::PathBuf, process::ExitCode, thread};

use minisandbox_cos_emulator::http::EmulatorServer;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("cos-emulator: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    if arguments.next().as_deref() != Some("serve") {
        return Err(usage());
    }
    let mut root = None;
    let mut data = "127.0.0.1:0".parse::<SocketAddr>().map_err(|_| usage())?;
    let mut control = "127.0.0.1:0".parse::<SocketAddr>().map_err(|_| usage())?;
    let mut token = None;
    let mut workers = 4_usize;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--root" => root = Some(required_value(&mut arguments, "--root")?.into()),
            "--data" => {
                data = required_value(&mut arguments, "--data")?
                    .parse()
                    .map_err(|_| "invalid --data address".to_owned())?;
            }
            "--control" => {
                control = required_value(&mut arguments, "--control")?
                    .parse()
                    .map_err(|_| "invalid --control address".to_owned())?;
            }
            "--token" => token = Some(required_value(&mut arguments, "--token")?),
            "--workers" => {
                workers = required_value(&mut arguments, "--workers")?
                    .parse()
                    .map_err(|_| "invalid --workers value".to_owned())?;
            }
            _ => return Err(usage()),
        }
    }
    let root: PathBuf = root.ok_or_else(|| "missing --root".to_owned())?;
    let token = token.ok_or_else(|| "missing --token".to_owned())?;
    let server = EmulatorServer::start(root, data, control, token, workers)
        .map_err(|error| error.to_string())?;
    println!("MINISANDBOX_COS_EMULATOR_READY");
    println!("COS_EMULATOR_DATA_ADDR={}", server.data_addr());
    println!("COS_EMULATOR_CONTROL_ADDR={}", server.control_addr());
    loop {
        thread::park();
    }
}

fn required_value(
    arguments: &mut impl Iterator<Item = String>,
    name: &str,
) -> Result<String, String> {
    arguments
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing value for {name}"))
}

fn usage() -> String {
    "usage: minisandbox-cos-emulator serve --root <directory> --token <secret> [--data 127.0.0.1:0] [--control 127.0.0.1:0] [--workers 4]".to_owned()
}
