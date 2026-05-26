use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;

use crate::error::{Error, Result};
use crate::runtime_host::e2b::CommandResult;

pub(super) fn connect_envelope(data: &[u8], flags: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 5);
    out.push(flags);
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(data);
    out
}

pub(super) fn read_connect_command_stream(raw: &[u8]) -> Result<CommandResult> {
    let mut cursor = 0usize;
    let mut result = CommandResult::default();

    while cursor + 5 <= raw.len() {
        let flags = raw[cursor];
        cursor += 1;
        let size = u32::from_be_bytes([
            raw[cursor],
            raw[cursor + 1],
            raw[cursor + 2],
            raw[cursor + 3],
        ]) as usize;
        cursor += 4;
        if cursor + size > raw.len() {
            break;
        }
        let payload = &raw[cursor..cursor + size];
        cursor += size;

        if flags & 0b0000_0010 != 0 {
            break;
        }

        #[derive(Deserialize)]
        struct Envelope {
            event: Event,
        }

        #[derive(Deserialize)]
        struct Event {
            #[allow(dead_code)]
            start: Option<StreamStart>,
            data: Option<StreamData>,
            end: Option<StreamEnd>,
        }

        #[derive(Deserialize)]
        struct StreamStart {
            #[allow(dead_code)]
            pid: Option<u32>,
        }

        #[derive(Deserialize)]
        struct StreamData {
            stdout: Option<String>,
            stderr: Option<String>,
        }

        #[derive(Deserialize)]
        struct StreamEnd {
            #[serde(rename = "exitCode", default)]
            exit_code: Option<i32>,
            exited: bool,
            status: String,
            error: Option<String>,
        }

        let envelope: Envelope = serde_json::from_slice(payload)
            .map_err(|error| Error::ParseResponse(error.to_string()))?;

        if let Some(data) = envelope.event.data {
            if let Some(stdout) = data.stdout {
                result.stdout.push_str(&decode_connect_string(&stdout)?);
            }
            if let Some(stderr) = data.stderr {
                result.stderr.push_str(&decode_connect_string(&stderr)?);
            }
        }
        if let Some(end) = envelope.event.end {
            result.exited = end.exited;
            result.status = end.status;
            if let Some(exit_code) = end
                .exit_code
                .or_else(|| parse_exit_code_from_status(&result.status))
            {
                result.exit_code = exit_code;
            }
            if let Some(error) = end.error.filter(|value| !value.is_empty()) {
                if let Some(exit_code) = parse_exit_code_from_status(&error) {
                    result.exit_code = exit_code;
                    if result.status.is_empty() {
                        result.status = error;
                    }
                } else {
                    return Err(Error::Agent(error));
                }
            }
        }
    }

    Ok(result)
}

fn parse_exit_code_from_status(status: &str) -> Option<i32> {
    let trimmed = status.trim();
    if let Some(value) = trimmed.strip_prefix("exit status ") {
        return value.trim().parse::<i32>().ok();
    }
    None
}

fn decode_connect_string(value: &str) -> Result<String> {
    let decoded = STANDARD
        .decode(value)
        .map_err(|error| Error::ParseResponse(error.to_string()))?;
    String::from_utf8(decoded).map_err(|error| Error::ParseResponse(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_exit_code_and_stdout_frames() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&connect_envelope(
            serde_json::to_vec(&serde_json::json!({
                "event": {"data": {"stdout": STANDARD.encode("hello\n")}}
            }))
            .unwrap()
            .as_slice(),
            0,
        ));
        bytes.extend_from_slice(&connect_envelope(
            serde_json::to_vec(&serde_json::json!({
                "event": {"end": {"exitCode": 0, "exited": true, "status": "done"}}
            }))
            .unwrap()
            .as_slice(),
            0,
        ));

        let result = read_connect_command_stream(&bytes).unwrap();
        assert_eq!(result.stdout, "hello\n");
        assert_eq!(result.exit_code, 0);
        assert!(result.exited);
    }
}
