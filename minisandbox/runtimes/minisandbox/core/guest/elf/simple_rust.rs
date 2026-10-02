use std::process::ExitCode;

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.len() != 1 || arguments[0] != "/minisandbox/program" {
        return ExitCode::from(120);
    }
    let values = vec![2_u64, 3, 5, 7, 11, 13];
    if values.into_iter().sum::<u64>() != 41 {
        return ExitCode::from(121);
    }
    let output = String::from("ordinary-rust\n");
    print!("{output}");
    ExitCode::from(46)
}
