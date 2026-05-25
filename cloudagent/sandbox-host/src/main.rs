use std::env;
use std::io::{self, Write};
use std::process;

use cloudagent_sandbox_host::{run_cli, CliIo};

fn main() {
    let code = match run_cli(
        env::args().skip(1).collect(),
        CliIo {
            stdout: &mut io::stdout(),
            stderr: &mut io::stderr(),
        },
    ) {
        Ok(()) => 0,
        Err(err) => {
            let _ = writeln!(io::stderr(), "sandbox-host: {err}");
            1
        }
    };
    process::exit(code);
}
