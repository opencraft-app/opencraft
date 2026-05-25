//! Process management tool backed by sandbox-host.

use std::time::{Duration, Instant};

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::schema::ToolSchema;
use crate::tools::{ToolContext, ToolHandler, ToolResult};

pub struct ProcessTool;
const DEFAULT_PROCESS_LOG_LIMIT: usize = 64 * 1024;

#[derive(JsonSchema, Deserialize)]
struct ProcessArgs {
    action: String,
    #[serde(
        alias = "processId",
        alias = "session_id",
        alias = "sessionId",
        alias = "id"
    )]
    process_id: Option<String>,
    data: Option<String>,
    input: Option<String>,
    timeout: Option<u64>,
    offset: Option<usize>,
    limit: Option<usize>,
    rows: Option<u16>,
    cols: Option<u16>,
}

#[async_trait]
impl ToolHandler for ProcessTool {
    fn name(&self) -> &str {
        "process"
    }

    fn description(&self) -> &str {
        "Manage background terminal processes. Actions: list, poll, log, wait, kill, write, submit, close."
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema::from_type::<ProcessArgs>("process", "Manage background processes")
    }

    async fn execute(&self, args: Value, context: ToolContext) -> ToolResult {
        let Some(sandbox) = context.sandbox() else {
            return ToolResult::error(
                self.name(),
                "Session sandbox is not available. This tool requires a session-scoped E2B sandbox.",
            );
        };
        if !sandbox.native_host_configured() {
            return ToolResult::error(self.name(), "sandbox-host is required for process");
        }

        let args: ProcessArgs = match serde_json::from_value(args) {
            Ok(value) => value,
            Err(error) => {
                return ToolResult::error(self.name(), format!("Invalid arguments: {}", error))
            }
        };

        let action = args.action.as_str();
        let result = match action {
            "list" => sandbox.native_call("process.list", json!({})).await,
            "poll" => call_with_id(&sandbox, "process.poll", &args).await,
            "log" => call_with_id(&sandbox, "process.log", &args).await,
            "kill" => call_with_id(&sandbox, "process.kill", &args).await,
            "close" => call_with_id(&sandbox, "process.close", &args).await,
            "write" => write_to_process(&sandbox, &args, false).await,
            "submit" => write_to_process(&sandbox, &args, true).await,
            "wait" => wait_for_process(&sandbox, &args).await,
            other => Err(crate::error::Error::InvalidToolArgs {
                name: self.name().to_string(),
                details: format!("unsupported process action: {other}"),
            }),
        };

        match result {
            Ok(value) => ToolResult::success(self.name(), value),
            Err(error) => ToolResult::error(self.name(), error.to_string()),
        }
    }
}

trait ProcessArgsExt {
    fn process_id_or_error(&self) -> crate::error::Result<&str>;
}

impl ProcessArgsExt for ProcessArgs {
    fn process_id_or_error(&self) -> crate::error::Result<&str> {
        self.process_id
            .as_deref()
            .ok_or_else(|| crate::error::Error::InvalidToolArgs {
                name: "process".to_string(),
                details: "missing process_id".to_string(),
            })
    }
}

async fn call_with_id(
    sandbox: &crate::runtime_host::SessionSandbox,
    method: &str,
    args: &ProcessArgs,
) -> crate::error::Result<Value> {
    let process_id = args.process_id_or_error()?;
    let mut payload = json!({"process_id": process_id});
    if let Some(offset) = args.offset {
        payload["offset"] = json!(offset);
    }
    if let Some(limit) = args.limit {
        payload["limit"] = json!(limit);
    } else if method == "process.log" {
        payload["limit"] = json!(DEFAULT_PROCESS_LOG_LIMIT);
    }
    if let Some(rows) = args.rows {
        payload["rows"] = json!(rows);
    }
    if let Some(cols) = args.cols {
        payload["cols"] = json!(cols);
    }
    sandbox.native_call(method, payload).await
}

async fn write_to_process(
    sandbox: &crate::runtime_host::SessionSandbox,
    args: &ProcessArgs,
    append_newline: bool,
) -> crate::error::Result<Value> {
    let process_id = args.process_id_or_error()?;
    let mut input = args
        .input
        .as_deref()
        .or(args.data.as_deref())
        .unwrap_or("")
        .to_string();
    if append_newline && !input.ends_with('\n') {
        input.push('\n');
    }
    sandbox
        .native_call(
            "process.write",
            json!({"process_id": process_id, "input": input}),
        )
        .await
}

async fn wait_for_process(
    sandbox: &crate::runtime_host::SessionSandbox,
    args: &ProcessArgs,
) -> crate::error::Result<Value> {
    let process_id = args.process_id_or_error()?.to_string();
    let timeout = Duration::from_secs(args.timeout.unwrap_or(300).min(3600));
    let deadline = Instant::now() + timeout;
    loop {
        let state = sandbox
            .native_call("process.poll", json!({"process_id": &process_id}))
            .await?;
        if state.get("status").and_then(Value::as_str) != Some("running") {
            let log = sandbox
                .native_call(
                    "process.log",
                    json!({
                        "process_id": process_id,
                        "offset": args.offset,
                        "limit": args.limit.unwrap_or(DEFAULT_PROCESS_LOG_LIMIT)
                    }),
                )
                .await?;
            return Ok(merge_objects(state, json!({"log": log})));
        }
        if Instant::now() >= deadline {
            return Ok(merge_objects(
                state,
                json!({"timed_out": true, "wait_timeout_secs": timeout.as_secs()}),
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn merge_objects(left: Value, right: Value) -> Value {
    let mut merged = serde_json::Map::new();
    if let Some(map) = left.as_object() {
        for (key, value) in map {
            merged.insert(key.clone(), value.clone());
        }
    }
    if let Some(map) = right.as_object() {
        for (key, value) in map {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submit_adds_newline_semantics_are_documented_by_schema() {
        let args: ProcessArgs = serde_json::from_value(json!({
            "action": "submit",
            "process_id": "proc_1",
            "data": "hello"
        }))
        .unwrap();
        assert_eq!(args.process_id_or_error().unwrap(), "proc_1");
        assert_eq!(args.data.as_deref(), Some("hello"));
    }

    #[test]
    fn process_log_has_default_limit() {
        let args: ProcessArgs = serde_json::from_value(json!({
            "action": "log",
            "process_id": "proc_1"
        }))
        .unwrap();
        let mut payload = json!({"process_id": args.process_id_or_error().unwrap()});
        if let Some(limit) = args.limit {
            payload["limit"] = json!(limit);
        } else {
            payload["limit"] = json!(DEFAULT_PROCESS_LOG_LIMIT);
        }
        assert_eq!(payload["limit"], DEFAULT_PROCESS_LOG_LIMIT);
    }
}
