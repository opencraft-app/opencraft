//! Terminal/shell command execution tool.

use std::collections::HashMap;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::runtime_config;
use crate::schema::ToolSchema;
use crate::tools::{ToolContext, ToolHandler, ToolResult};

pub struct TerminalTool;

#[derive(JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalArgs {
    command: String,
    working_dir: Option<String>,
    env_vars: Option<HashMap<String, String>>,
    timeout: Option<u64>,
    max_output: Option<usize>,
    use_shell: Option<bool>,
    background: Option<bool>,
    pty: Option<bool>,
    rows: Option<u16>,
    cols: Option<u16>,
}

#[async_trait]
impl ToolHandler for TerminalTool {
    fn name(&self) -> &str {
        "terminal"
    }

    fn description(&self) -> &str {
        "Execute a command in the configured E2B sandbox and return its output. Supports custom working directory and environment variables."
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema::from_type::<TerminalArgs>("terminal", "Execute shell command")
    }

    async fn execute(&self, args: Value, context: ToolContext) -> ToolResult {
        let Some(sandbox) = context.sandbox() else {
            return ToolResult::error(
                self.name(),
                "Session sandbox is not available. This tool now requires a session-scoped E2B sandbox.",
            );
        };

        let args: TerminalArgs = match serde_json::from_value(args) {
            Ok(value) => value,
            Err(error) => {
                return ToolResult::error(self.name(), format!("Invalid arguments: {}", error))
            }
        };
        let command = match build_command(&args, &sandbox) {
            Ok(command) => command,
            Err(error) => return ToolResult::error(self.name(), error.to_string()),
        };
        let timeout_secs = args
            .timeout
            .unwrap_or(runtime_config().tools.terminal.max_timeout_secs)
            .min(runtime_config().tools.terminal.max_timeout_secs);
        let max_output = args
            .max_output
            .unwrap_or(runtime_config().tools.terminal.max_output_bytes);

        if !sandbox.native_host_configured() {
            return ToolResult::error(
                self.name(),
                "sandbox-host is required for terminal execution",
            );
        }
        let method = if args.background.unwrap_or(false) {
            "process.start"
        } else {
            "process.exec"
        };
        let output = match sandbox
            .native_call(
                method,
                terminal_payload(&args, command, timeout_secs, max_output),
            )
            .await
        {
            Ok(value) => value,
            Err(error) => return ToolResult::error(self.name(), error.to_string()),
        };
        if args.background.unwrap_or(false) {
            return ToolResult::success(
                self.name(),
                json!({
                    "success": true,
                    "background": true,
                    "process_id": output.get("process_id").cloned().unwrap_or(Value::Null),
                    "status": output.get("status").cloned().unwrap_or(json!("running")),
                    "kind": output.get("kind").cloned().unwrap_or(Value::Null),
                    "runtime": "sandbox-host",
                }),
            );
        }
        let exit_code = output.get("exit_code").and_then(Value::as_i64).unwrap_or(1) as i32;
        let stdout = output
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let (stdout, stdout_truncated_by_adapter) = truncate_with_metadata(stdout, max_output);
        let stdout_truncated = stdout_truncated_by_adapter
            || output
                .get("output_truncated")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        ToolResult::success(
            self.name(),
            json!({
                "success": exit_code == 0,
                "exit_code": exit_code,
                "stdout": stdout,
                "stdout_truncated": stdout_truncated,
                "stdout_next_offset": output.get("output_next_offset").cloned().unwrap_or(Value::Null),
                "stdout_dropped_bytes": output.get("output_dropped_bytes").cloned().unwrap_or(json!(0)),
                "stderr": "",
                "runtime": "sandbox-host",
            }),
        )
    }
}

fn build_command(
    args: &TerminalArgs,
    sandbox: &crate::runtime_host::SessionSandbox,
) -> crate::error::Result<String> {
    let working_dir = match args.working_dir.as_deref() {
        Some(path) => {
            let resolved = sandbox.resolve_working_dir(Some(path))?;
            format!("cd {} && ", shell_quote(&resolved))
        }
        None => String::new(),
    };
    let env_prefix = shell_env_prefix(args.env_vars.as_ref())?;
    let command = if args.use_shell.unwrap_or(true) {
        args.command.clone()
    } else {
        shell_words::split(&args.command)
            .map(|parts| {
                parts
                    .into_iter()
                    .map(|part| shell_quote(&part))
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_else(|_| args.command.clone())
    };
    Ok(format!("{}{}{}", working_dir, env_prefix, command))
}

fn terminal_payload(
    args: &TerminalArgs,
    command: String,
    timeout_secs: u64,
    output_limit: usize,
) -> Value {
    let mut payload = json!({
        "command": command,
        "timeout_ms": timeout_secs.saturating_mul(1000),
        "output_limit": output_limit,
        "pty": args.pty.unwrap_or(false),
    });
    if let Some(rows) = args.rows {
        payload["rows"] = json!(rows);
    }
    if let Some(cols) = args.cols {
        payload["cols"] = json!(cols);
    }
    payload
}

fn shell_env_prefix(env_vars: Option<&HashMap<String, String>>) -> crate::error::Result<String> {
    let Some(env_vars) = env_vars else {
        return Ok(String::new());
    };
    if env_vars.is_empty() {
        return Ok(String::new());
    }
    let mut pairs = Vec::with_capacity(env_vars.len());
    let mut keys: Vec<_> = env_vars.keys().collect();
    keys.sort();
    for key in keys {
        if !is_valid_env_key(key) {
            return Err(crate::error::Error::InvalidToolArgs {
                name: "terminal".to_string(),
                details: format!("invalid environment variable name: {key}"),
            });
        }
        let value = env_vars.get(key).cloned().unwrap_or_default();
        pairs.push(format!("{key}={}", shell_quote(&value)));
    }
    Ok(format!("{} ", pairs.join(" ")))
}

fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn shell_quote(value: &str) -> String {
    let escaped = value.replace('\'', "'\"'\"'");
    format!("'{}'", escaped)
}

fn truncate_with_metadata(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}\n[output truncated]", &value[..end]), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_working_dir_command() {
        let sandbox =
            crate::runtime_host::test_session_sandbox("/workspace/session_1", "/Users/demo/repo");
        let command = build_command(
            &TerminalArgs {
                command: "pwd".to_string(),
                working_dir: Some("/Users/demo/repo/src".to_string()),
                env_vars: None,
                timeout: None,
                max_output: None,
                use_shell: Some(true),
                background: None,
                pty: None,
                rows: None,
                cols: None,
            },
            &sandbox,
        )
        .unwrap();
        assert_eq!(command, "cd '/workspace/session_1/src' && pwd");
    }

    #[test]
    fn terminal_payload_carries_output_limit() {
        let payload = terminal_payload(
            &TerminalArgs {
                command: "yes".to_string(),
                working_dir: None,
                env_vars: None,
                timeout: None,
                max_output: Some(1234),
                use_shell: Some(true),
                background: None,
                pty: None,
                rows: None,
                cols: None,
            },
            "yes".to_string(),
            10,
            1234,
        );
        assert_eq!(payload["output_limit"], 1234);
    }
}
