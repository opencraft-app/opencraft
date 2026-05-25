use std::path::PathBuf;

use anyhow::{bail, Context, Result};

use crate::client::{parse_client_args, ClientArgs};

#[derive(Debug)]
pub(crate) enum CommandMode {
    Daemon(DaemonArgs),
    Client(ClientArgs),
}

#[derive(Debug)]
pub(crate) struct DaemonArgs {
    pub(crate) addr: String,
    pub(crate) session_id: String,
    pub(crate) workspace: Option<PathBuf>,
    pub(crate) memory_dir: Option<PathBuf>,
}

pub(crate) fn parse_command_mode(args: &[String]) -> Result<CommandMode> {
    if args.len() <= 1 {
        bail!("subcommand is required: use 'daemon' or 'client'");
    }

    match args[1].as_str() {
        "daemon" => Ok(CommandMode::Daemon(parse_daemon_args(&args[2..])?)),
        "client" => Ok(CommandMode::Client(parse_client_args(&args[2..])?)),
        other => bail!("unsupported subcommand '{}'", other),
    }
}

fn parse_daemon_args(args: &[String]) -> Result<DaemonArgs> {
    let mut addr = None;
    let mut session_id = None;
    let mut workspace = None;
    let mut memory_dir = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--addr" => {
                addr = Some(take_flag_value(args, &mut index, "--addr")?);
            }
            "--session-id" => {
                session_id = Some(take_flag_value(args, &mut index, "--session-id")?);
            }
            "--workspace" => {
                workspace = Some(PathBuf::from(take_flag_value(
                    args,
                    &mut index,
                    "--workspace",
                )?));
            }
            "--memory-dir" => {
                memory_dir = Some(PathBuf::from(take_flag_value(
                    args,
                    &mut index,
                    "--memory-dir",
                )?));
            }
            other => bail!("unexpected daemon argument '{}'", other),
        }
        index += 1;
    }

    Ok(DaemonArgs {
        addr: addr.context("--addr is required for daemon")?,
        session_id: session_id.context("--session-id is required for daemon")?,
        workspace,
        memory_dir,
    })
}

fn take_flag_value(args: &[String], index: &mut usize, flag: &str) -> Result<String> {
    *index += 1;
    args.get(*index)
        .cloned()
        .with_context(|| format!("missing value for {}", flag))
}
