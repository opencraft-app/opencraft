use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
const DEFAULT_PROCESS_LOG_BYTES: usize = 64 * 1024;
const MAX_SEARCH_LINE_BYTES: usize = 500;

pub struct CliIo<'a> {
    pub stdout: &'a mut dyn Write,
    pub stderr: &'a mut dyn Write,
}

#[derive(Clone)]
pub struct Config {
    pub addr: String,
    pub workspace: PathBuf,
    pub policy: Policy,
}

#[derive(Clone, Serialize)]
pub struct Policy {
    pub default_timeout_ms: u64,
    pub max_timeout_ms: u64,
    pub max_command_bytes: usize,
    pub max_output_bytes: usize,
    pub max_read_bytes: usize,
    pub max_search_results: usize,
    pub max_background_processes: usize,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            default_timeout_ms: 30_000,
            max_timeout_ms: 300_000,
            max_command_bytes: 32 * 1024,
            max_output_bytes: 256 * 1024,
            max_read_bytes: 128 * 1024,
            max_search_results: 200,
            max_background_processes: 16,
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            addr: "127.0.0.1:19091".to_string(),
            workspace: PathBuf::from("/workspace"),
            policy: Policy::default(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

#[derive(Serialize)]
struct ApiResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ApiError>,
}

type ApiResult = Result<Value, ApiError>;

impl ApiError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

#[derive(Clone)]
pub struct Host {
    cfg: Config,
    fs: SandboxFs,
    processes: ProcessManager,
    started_at_ms: u128,
}

impl Host {
    pub fn new(mut cfg: Config) -> Result<Self, ApiError> {
        if cfg.addr.trim().is_empty() {
            cfg.addr = Config::default().addr;
        }
        if cfg.workspace.as_os_str().is_empty() {
            cfg.workspace = PathBuf::from(".");
        }
        fs::create_dir_all(&cfg.workspace)
            .map_err(|err| ApiError::new("workspace_create_failed", err.to_string()))?;
        cfg.workspace = fs::canonicalize(&cfg.workspace)
            .map_err(|err| ApiError::new("workspace_resolve_failed", err.to_string()))?;
        let started_at_ms = now_ms();
        Ok(Self {
            fs: SandboxFs::new(cfg.workspace.clone(), cfg.policy.clone()),
            processes: ProcessManager::new(cfg.workspace.clone(), cfg.policy.clone()),
            cfg,
            started_at_ms,
        })
    }

    pub fn serve(&self) -> Result<(), ApiError> {
        let listener = TcpListener::bind(&self.cfg.addr)
            .map_err(|err| ApiError::new("listen_failed", err.to_string()))?;
        for stream in listener.incoming() {
            let host = self.clone();
            match stream {
                Ok(stream) => {
                    thread::spawn(move || {
                        let _ = host.handle_stream(stream);
                    });
                }
                Err(err) => eprintln!("sandbox-host: accept failed: {err}"),
            }
        }
        Ok(())
    }

    pub fn dispatch(&self, method: &str, params: Value) -> ApiResult {
        match method {
            "host.info" | "native.host.info" => Ok(json!({
                "workspace": self.cfg.workspace,
                "started_at_ms": self.started_at_ms,
                "capabilities": [
                    "host.info",
                    "fs.read",
                    "fs.write",
                    "fs.stat",
                    "fs.blob",
                    "fs.list",
                    "fs.search",
                    "fs.patch",
                    "process.exec",
                    "process.start",
                    "process.poll",
                    "process.log",
                    "process.write",
                    "process.resize",
                    "process.kill",
                    "process.list",
                    "process.close"
                ],
                "policy": self.cfg.policy
            })),
            "fs.read" | "native.fs.read" => self.fs.read(params),
            "fs.write" | "native.fs.write" => self.fs.write(params),
            "fs.stat" | "native.fs.stat" => self.fs.stat(params),
            "fs.list" | "native.fs.list" => self.fs.list(params),
            "fs.search" | "native.fs.search" => self.fs.search(params),
            "fs.patch" | "native.fs.patch" => self.fs.patch(params),
            "process.exec" | "terminal.exec" | "native.process.exec" | "native.terminal.exec" => {
                self.processes.exec(params)
            }
            "process.start" | "native.process.start" => self.processes.start(params),
            "process.poll" | "native.process.poll" => self.processes.poll(params),
            "process.log" | "native.process.log" => self.processes.log(params),
            "process.write" | "native.process.write" => self.processes.write_stdin(params),
            "process.resize" | "native.process.resize" => self.processes.resize(params),
            "process.kill" | "native.process.kill" => self.processes.kill(params),
            "process.list" | "native.process.list" => self.processes.list(params),
            "process.close" | "native.process.close" => self.processes.close_stdin(params),
            _ => Err(ApiError::new(
                "unknown_method",
                format!("unknown native method {method}"),
            )),
        }
    }

    fn handle_stream(&self, mut stream: TcpStream) -> Result<(), ApiError> {
        let req = read_http_request(&mut stream)?;
        let (path, query) = split_path_query(&req.path);
        if path == "/v1/fs/blob" {
            return match req.method.as_str() {
                "GET" => {
                    let raw = self.fs.read_blob_from_query(query);
                    write_blob_http_response(&mut stream, raw)
                }
                "PUT" | "POST" => {
                    let result = self.fs.write_blob_from_query(query, &req.body);
                    write_http_response(&mut stream, result)
                }
                _ => write_http_response(
                    &mut stream,
                    Err(ApiError::new(
                        "not_found",
                        format!("unknown endpoint {} {}", req.method, req.path),
                    )),
                ),
            };
        }
        let response = match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/health") => Ok(json!({"status": "ok"})),
            ("GET", "/v1/host") => self.dispatch("host.info", json!({})),
            ("POST", "/v1/native") => {
                let body: Value = serde_json::from_slice(&req.body)
                    .map_err(|err| ApiError::new("invalid_json", err.to_string()))?;
                let method = body
                    .get("method")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ApiError::new("invalid_request", "missing method"))?;
                let params = body.get("params").cloned().unwrap_or_else(|| json!({}));
                self.dispatch(method, params)
            }
            ("POST", path) => {
                let method = path_method(path)?;
                let params = decode_params(&req.body)?;
                self.dispatch(method, params)
            }
            _ => Err(ApiError::new(
                "not_found",
                format!("unknown endpoint {} {}", req.method, req.path),
            )),
        };
        write_http_response(&mut stream, response)
    }
}

pub fn run_cli(args: Vec<String>, mut io: CliIo<'_>) -> Result<(), ApiError> {
    if args.is_empty() || is_help(&args[0]) {
        writeln!(
            io.stderr,
            "Usage:\n  sandbox-host serve --addr 127.0.0.1:19091 --workspace /workspace\n  sandbox-host call --url http://127.0.0.1:19091 --method fs.read --json '{{\"path\":\"README.md\"}}'"
        )
        .map_err(|err| ApiError::new("io_error", err.to_string()))?;
        return Ok(());
    }
    match args[0].as_str() {
        "serve" => {
            let cfg = parse_serve_args(&args[1..])?;
            Host::new(cfg)?.serve()
        }
        "call" => run_call(&args[1..], &mut io),
        other => Err(ApiError::new(
            "invalid_command",
            format!("unknown command {other}"),
        )),
    }
}

fn parse_serve_args(args: &[String]) -> Result<Config, ApiError> {
    let mut cfg = Config::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--addr" => {
                i += 1;
                cfg.addr = take_arg(args, i, "--addr")?.to_string();
            }
            "--workspace" => {
                i += 1;
                cfg.workspace = PathBuf::from(take_arg(args, i, "--workspace")?);
            }
            "--max-output-bytes" => {
                i += 1;
                cfg.policy.max_output_bytes =
                    parse_usize(take_arg(args, i, "--max-output-bytes")?)?;
            }
            "--default-timeout-ms" => {
                i += 1;
                cfg.policy.default_timeout_ms =
                    parse_u64(take_arg(args, i, "--default-timeout-ms")?)?;
            }
            "--max-timeout-ms" => {
                i += 1;
                cfg.policy.max_timeout_ms = parse_u64(take_arg(args, i, "--max-timeout-ms")?)?;
            }
            flag => {
                return Err(ApiError::new(
                    "invalid_flag",
                    format!("unknown flag {flag}"),
                ))
            }
        }
        i += 1;
    }
    Ok(cfg)
}

fn run_call(args: &[String], io: &mut CliIo<'_>) -> Result<(), ApiError> {
    let mut url = "http://127.0.0.1:19091".to_string();
    let mut method = String::new();
    let mut payload = "{}".to_string();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--url" => {
                i += 1;
                url = take_arg(args, i, "--url")?.to_string();
            }
            "--method" => {
                i += 1;
                method = take_arg(args, i, "--method")?.to_string();
            }
            "--json" => {
                i += 1;
                payload = take_arg(args, i, "--json")?.to_string();
            }
            flag => {
                return Err(ApiError::new(
                    "invalid_flag",
                    format!("unknown flag {flag}"),
                ))
            }
        }
        i += 1;
    }
    if method.is_empty() {
        return Err(ApiError::new("invalid_request", "missing --method"));
    }
    let params: Value = serde_json::from_str(&payload)
        .map_err(|err| ApiError::new("invalid_json", err.to_string()))?;
    let request = json!({"method": method, "params": params}).to_string();
    let (status, body) = http_post(
        &format!("{}/v1/native", url.trim_end_matches('/')),
        request.as_bytes(),
    )?;
    io.stdout
        .write_all(&body)
        .map_err(|err| ApiError::new("io_error", err.to_string()))?;
    if !body.ends_with(b"\n") {
        io.stdout
            .write_all(b"\n")
            .map_err(|err| ApiError::new("io_error", err.to_string()))?;
    }
    if !(200..300).contains(&status) {
        return Err(ApiError::new(
            "http_error",
            format!("sandbox-host returned HTTP {status}"),
        ));
    }
    Ok(())
}

#[derive(Clone)]
struct SandboxFs {
    root: PathBuf,
    policy: Policy,
}

impl SandboxFs {
    fn new(root: PathBuf, policy: Policy) -> Self {
        Self { root, policy }
    }

    fn read(&self, params: Value) -> ApiResult {
        let path = self.resolve_existing(str_param(&params, "path").unwrap_or("."))?;
        self.ensure_readable_text_file(&path)?;
        let offset = usize_param(&params, "offset").unwrap_or(1).max(1);
        let limit = usize_param(&params, "limit").unwrap_or(200).max(1);
        let bytes = fs::read(&path).map_err(io_api_error)?;
        if looks_binary(&bytes) {
            return Err(ApiError::new(
                "binary_file",
                "refusing to read binary-looking file as text",
            ));
        }
        let total_bytes = bytes.len();
        let truncated_by_bytes = bytes.len() > self.policy.max_read_bytes;
        let bytes = &bytes[..bytes.len().min(self.policy.max_read_bytes)];
        let text = String::from_utf8_lossy(bytes);
        let lines: Vec<&str> = text.lines().collect();
        let start = offset.saturating_sub(1).min(lines.len());
        let end = (start + limit).min(lines.len());
        let truncated = truncated_by_bytes || end < lines.len();
        Ok(json!({
            "path": self.display_path(&path),
            "content": lines[start..end].join("\n"),
            "start_line": start + 1,
            "end_line": end,
            "total_lines": lines.len(),
            "total_bytes": total_bytes,
            "max_read_bytes": self.policy.max_read_bytes,
            "truncated": truncated,
            "truncated_by_bytes": truncated_by_bytes,
            "next_offset": if truncated { Some(end + 1) } else { None::<usize> },
            "hint": if truncated { Some("Call read_file again with offset=next_offset to continue.") } else { None::<&str> }
        }))
    }

    fn write(&self, params: Value) -> ApiResult {
        let raw_path = str_param(&params, "path")
            .ok_or_else(|| ApiError::new("invalid_request", "missing path"))?;
        let content = str_param(&params, "content").unwrap_or("");
        let append = bool_param(&params, "append").unwrap_or(false);
        let path = self.resolve_for_write(raw_path)?;
        self.ensure_safe_write_path(&path)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(io_api_error)?;
        }
        let mut options = fs::OpenOptions::new();
        options.create(true).write(true);
        if append {
            options.append(true);
        } else {
            options.truncate(true);
        }
        let mut file = options.open(&path).map_err(io_api_error)?;
        file.write_all(content.as_bytes()).map_err(io_api_error)?;
        let file_size = fs::metadata(&path).map_err(io_api_error)?.len();
        Ok(json!({
            "path": self.display_path(&path),
            "bytes": content.len(),
            "file_size": file_size,
            "append": append
        }))
    }

    fn stat(&self, params: Value) -> ApiResult {
        let raw_path = str_param(&params, "path")
            .ok_or_else(|| ApiError::new("invalid_request", "missing path"))?;
        let path = self.resolve_existing(raw_path)?;
        let metadata = fs::metadata(&path).map_err(io_api_error)?;
        Ok(json!({
            "path": self.display_path(&path),
            "is_file": metadata.is_file(),
            "is_dir": metadata.is_dir(),
            "is_symlink": fs::symlink_metadata(&path)
                .map(|metadata| metadata.file_type().is_symlink())
                .unwrap_or(false),
            "size": metadata.len(),
            "readonly": metadata.permissions().readonly()
        }))
    }

    fn read_blob_from_query(&self, query: Option<&str>) -> Result<Vec<u8>, ApiError> {
        let raw_path = query_param(query, "path")
            .ok_or_else(|| ApiError::new("invalid_request", "missing path"))?;
        let path = self.resolve_existing(&raw_path)?;
        self.ensure_readable_regular_file(&path)?;
        fs::read(path).map_err(io_api_error)
    }

    fn write_blob_from_query(&self, query: Option<&str>, body: &[u8]) -> ApiResult {
        let raw_path = query_param(query, "path")
            .ok_or_else(|| ApiError::new("invalid_request", "missing path"))?;
        let path = self.resolve_for_write(&raw_path)?;
        self.ensure_safe_write_path(&path)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(io_api_error)?;
        }
        fs::write(&path, body).map_err(io_api_error)?;
        let file_size = fs::metadata(&path).map_err(io_api_error)?.len();
        Ok(json!({
            "path": self.display_path(&path),
            "bytes": body.len(),
            "file_size": file_size
        }))
    }

    fn list(&self, params: Value) -> ApiResult {
        let path = self.resolve_existing(str_param(&params, "path").unwrap_or("."))?;
        let recursive = bool_param(&params, "recursive").unwrap_or(false);
        let max = usize_param(&params, "max_results").unwrap_or(200).max(1);
        let mut entries = Vec::new();
        self.collect_entries(&path, recursive, max, &mut entries)?;
        let truncated = entries.len() >= max;
        Ok(json!({"path": self.display_path(&path), "entries": entries, "truncated": truncated}))
    }

    fn search(&self, params: Value) -> ApiResult {
        let path = self.resolve_existing(str_param(&params, "path").unwrap_or("."))?;
        let pattern = str_param(&params, "pattern")
            .ok_or_else(|| ApiError::new("invalid_request", "missing pattern"))?;
        let target = str_param(&params, "target").unwrap_or("content");
        let case_sensitive = bool_param(&params, "case_sensitive").unwrap_or(true);
        let file_glob = str_param(&params, "file_glob");
        let limit = usize_param(&params, "limit")
            .or_else(|| usize_param(&params, "max_results"))
            .unwrap_or(50)
            .min(self.policy.max_search_results)
            .max(1);
        let offset = usize_param(&params, "offset").unwrap_or(0);
        let output_mode = str_param(&params, "output_mode").unwrap_or("content");
        let content_output = matches!(target, "content" | "grep");
        let content_detail_output = content_output && output_mode == "content";
        let scan_limit = if content_detail_output || !content_output {
            offset
                .saturating_add(limit)
                .min(self.policy.max_search_results)
                .max(1)
        } else {
            self.policy.max_search_results.max(1)
        };
        let context = if content_detail_output {
            usize_param(&params, "context").unwrap_or(0).min(20)
        } else {
            0
        };
        let mut matches = Vec::new();
        match target {
            "content" | "grep" => self.search_content_path(
                &path,
                pattern,
                case_sensitive,
                file_glob,
                scan_limit,
                context,
                &mut matches,
            )?,
            "files" | "find" => self.search_file_path(
                &path,
                pattern,
                case_sensitive,
                file_glob,
                scan_limit,
                &mut matches,
            )?,
            other => {
                return Err(ApiError::new(
                    "invalid_request",
                    format!("unsupported search target {other}"),
                ))
            }
        }
        let scanned_count = matches.len();
        let scan_truncated = scanned_count >= scan_limit;

        let result = if matches!(target, "content" | "grep") {
            match output_mode {
                "content" => {
                    let page = page_values(&matches, offset, limit);
                    let page_len = page.len();
                    json!({
                        "path": self.display_path(&path),
                        "target": "content",
                        "output_mode": "content",
                        "count": page_len,
                        "total_count": scanned_count,
                        "matches": page,
                        "offset": offset,
                        "limit": limit,
                        "truncated": scan_truncated || scanned_count > offset.saturating_add(limit),
                        "next_offset": if scan_truncated || scanned_count > offset.saturating_add(limit) { Some(offset.saturating_add(limit)) } else { None },
                    })
                }
                "files_only" => {
                    let mut seen = HashSet::new();
                    let mut files = Vec::new();
                    for entry in &matches {
                        if let Some(path) = entry.get("path").and_then(Value::as_str) {
                            if seen.insert(path.to_string()) {
                                files.push(Value::String(path.to_string()));
                            }
                        }
                    }
                    let total_count = files.len();
                    let page = page_values(&files, offset, limit);
                    let page_len = page.len();
                    json!({
                        "path": self.display_path(&path),
                        "target": "content",
                        "output_mode": "files_only",
                        "count": page_len,
                        "total_count": total_count,
                        "files": page,
                        "offset": offset,
                        "limit": limit,
                        "truncated": scan_truncated || total_count > offset.saturating_add(limit),
                        "next_offset": if scan_truncated || total_count > offset.saturating_add(limit) { Some(offset.saturating_add(limit)) } else { None },
                    })
                }
                "count" => {
                    let mut counts = Map::new();
                    for entry in &matches {
                        if let Some(path) = entry.get("path").and_then(Value::as_str) {
                            let next = counts.get(path).and_then(Value::as_u64).unwrap_or(0) + 1;
                            counts.insert(path.to_string(), Value::from(next));
                        }
                    }
                    json!({
                        "path": self.display_path(&path),
                        "target": "content",
                        "output_mode": "count",
                        "count": scanned_count,
                        "total_count": scanned_count,
                        "counts": counts,
                        "offset": offset,
                        "limit": limit,
                        "truncated": scan_truncated,
                        "next_offset": if scan_truncated { Some(offset.saturating_add(limit)) } else { None },
                    })
                }
                other => {
                    return Err(ApiError::new(
                        "invalid_request",
                        format!("unsupported search output_mode {other}"),
                    ))
                }
            }
        } else {
            let page = page_values(&matches, offset, limit);
            let page_len = page.len();
            json!({
                "path": self.display_path(&path),
                "target": "files",
                "count": page_len,
                "total_count": scanned_count,
                "matches": page,
                "offset": offset,
                "limit": limit,
                "truncated": scan_truncated || scanned_count > offset.saturating_add(limit),
                "next_offset": if scan_truncated || scanned_count > offset.saturating_add(limit) { Some(offset.saturating_add(limit)) } else { None },
            })
        };
        Ok(result)
    }

    fn patch(&self, params: Value) -> ApiResult {
        let raw_path = str_param(&params, "path")
            .ok_or_else(|| ApiError::new("invalid_request", "missing path"))?;
        let old_text = str_param(&params, "old_text")
            .or_else(|| str_param(&params, "find"))
            .ok_or_else(|| ApiError::new("invalid_request", "missing old_text"))?;
        let new_text = str_param(&params, "new_text")
            .or_else(|| str_param(&params, "replace"))
            .unwrap_or("");
        if old_text.is_empty() {
            return Err(ApiError::new(
                "invalid_request",
                "old_text must not be empty",
            ));
        }
        let replace_all = bool_param(&params, "replace_all").unwrap_or(false);
        let path = self.resolve_existing(raw_path)?;
        self.ensure_readable_text_file(&path)?;
        self.ensure_safe_write_path(&path)?;
        let bytes = fs::read(&path).map_err(io_api_error)?;
        if looks_binary(&bytes) {
            return Err(ApiError::new(
                "binary_file",
                "refusing to patch binary-looking file as text",
            ));
        }
        let content = String::from_utf8(bytes)
            .map_err(|_| ApiError::new("binary_file", "file is not valid UTF-8 text"))?;
        let exact_count = content.matches(old_text).count();
        let (updated, replacements, match_type) = if exact_count > 0 {
            if exact_count > 1 && !replace_all {
                return Err(ApiError::new(
                    "patch_ambiguous",
                    format!("old_text matched {exact_count} times; set replace_all=true"),
                ));
            }
            let updated = if replace_all {
                content.replace(old_text, new_text)
            } else {
                content.replacen(old_text, new_text, 1)
            };
            (updated, if replace_all { exact_count } else { 1 }, "exact")
        } else {
            match fuzzy_replace(&content, old_text, new_text) {
                Some((updated, replacements)) => {
                    if replacements > 1 && !replace_all {
                        return Err(ApiError::new(
                            "patch_ambiguous",
                            format!(
                                "old_text matched {replacements} times fuzzily; set replace_all=true"
                            ),
                        ));
                    }
                    (updated, replacements, "fuzzy")
                }
                None => return Err(ApiError::new("patch_not_found", "old_text not found")),
            }
        };
        fs::write(&path, updated.as_bytes()).map_err(io_api_error)?;
        Ok(json!({
            "path": self.display_path(&path),
            "replacements": replacements,
            "match_type": match_type,
            "file_size": updated.len()
        }))
    }

    fn collect_entries(
        &self,
        path: &Path,
        recursive: bool,
        max: usize,
        entries: &mut Vec<Value>,
    ) -> Result<(), ApiError> {
        if entries.len() >= max {
            return Ok(());
        }
        let link_metadata = fs::symlink_metadata(path).map_err(io_api_error)?;
        if link_metadata.file_type().is_symlink() {
            return Ok(());
        }
        let metadata = fs::metadata(path).map_err(io_api_error)?;
        if metadata.is_file() {
            entries.push(
                json!({"path": self.display_path(path), "type": "file", "size": metadata.len()}),
            );
            return Ok(());
        }
        for item in fs::read_dir(path).map_err(io_api_error)? {
            if entries.len() >= max {
                break;
            }
            let item = item.map_err(io_api_error)?;
            let child = item.path();
            let link_metadata = fs::symlink_metadata(&child).map_err(io_api_error)?;
            if link_metadata.file_type().is_symlink() {
                continue;
            }
            let metadata = link_metadata;
            let is_dir = metadata.is_dir();
            entries.push(json!({
                "path": self.display_path(&child),
                "name": item.file_name().to_string_lossy(),
                "type": if is_dir { "dir" } else { "file" },
                "size": metadata.len()
            }));
            if recursive && is_dir && !is_skipped_dir(&child) {
                self.collect_entries(&child, true, max, entries)?;
            }
        }
        Ok(())
    }

    fn search_content_path(
        &self,
        path: &Path,
        pattern: &str,
        case_sensitive: bool,
        file_glob: Option<&str>,
        max: usize,
        context: usize,
        matches: &mut Vec<Value>,
    ) -> Result<(), ApiError> {
        if matches.len() >= max {
            return Ok(());
        }
        let link_metadata = fs::symlink_metadata(path).map_err(io_api_error)?;
        if link_metadata.file_type().is_symlink() {
            return Ok(());
        }
        let metadata = fs::metadata(path).map_err(io_api_error)?;
        if metadata.is_file() {
            if !glob_matches_path(path, file_glob) {
                return Ok(());
            }
            if self.ensure_readable_text_file(path).is_err() {
                return Ok(());
            }
            let bytes = match fs::read(path) {
                Ok(bytes) => bytes,
                Err(_) => return Ok(()),
            };
            if looks_binary(&bytes) {
                return Ok(());
            }
            let text = String::from_utf8_lossy(&bytes);
            let needle = if case_sensitive {
                pattern.to_string()
            } else {
                pattern.to_lowercase()
            };
            let lines: Vec<&str> = text.lines().collect();
            let mut emitted_lines = HashSet::new();
            for (idx, line) in lines.iter().enumerate() {
                let haystack = if case_sensitive {
                    (*line).to_string()
                } else {
                    line.to_lowercase()
                };
                if haystack.contains(&needle) {
                    let start = idx.saturating_sub(context);
                    let end = (idx + context + 1).min(lines.len());
                    for context_idx in start..end {
                        if matches.len() >= max {
                            break;
                        }
                        if !emitted_lines.insert(context_idx) {
                            continue;
                        }
                        let (text, line_truncated) =
                            truncate_text_for_tool_line(lines[context_idx], MAX_SEARCH_LINE_BYTES);
                        matches.push(json!({
                            "path": self.display_path(path),
                            "line": context_idx + 1,
                            "text": text,
                            "line_truncated": line_truncated,
                            "is_context": context_idx != idx
                        }));
                    }
                    if matches.len() >= max {
                        break;
                    }
                }
            }
            return Ok(());
        }
        for item in fs::read_dir(path).map_err(io_api_error)? {
            if matches.len() >= max {
                break;
            }
            let child = item.map_err(io_api_error)?.path();
            let link_metadata = match fs::symlink_metadata(&child) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if link_metadata.file_type().is_symlink() {
                continue;
            }
            if link_metadata.is_dir() && is_skipped_dir(&child) {
                continue;
            }
            self.search_content_path(
                &child,
                pattern,
                case_sensitive,
                file_glob,
                max,
                context,
                matches,
            )?;
        }
        Ok(())
    }

    fn search_file_path(
        &self,
        path: &Path,
        pattern: &str,
        case_sensitive: bool,
        file_glob: Option<&str>,
        max: usize,
        matches: &mut Vec<Value>,
    ) -> Result<(), ApiError> {
        if matches.len() >= max {
            return Ok(());
        }
        let link_metadata = fs::symlink_metadata(path).map_err(io_api_error)?;
        if link_metadata.file_type().is_symlink() {
            return Ok(());
        }
        let metadata = fs::metadata(path).map_err(io_api_error)?;
        if metadata.is_file() {
            if self.path_matches_file_search(path, pattern, case_sensitive, file_glob) {
                matches.push(json!({
                    "path": self.display_path(path),
                    "name": path.file_name().and_then(|name| name.to_str()).unwrap_or(""),
                    "type": "file",
                    "size": metadata.len()
                }));
            }
            return Ok(());
        }
        for item in fs::read_dir(path).map_err(io_api_error)? {
            if matches.len() >= max {
                break;
            }
            let item = item.map_err(io_api_error)?;
            let child = item.path();
            let link_metadata = fs::symlink_metadata(&child).map_err(io_api_error)?;
            if link_metadata.file_type().is_symlink() {
                continue;
            }
            let metadata = item.metadata().map_err(io_api_error)?;
            let is_dir = metadata.is_dir();
            if self.path_matches_file_search(&child, pattern, case_sensitive, file_glob) {
                matches.push(json!({
                    "path": self.display_path(&child),
                    "name": item.file_name().to_string_lossy(),
                    "type": if is_dir { "dir" } else { "file" },
                    "size": metadata.len()
                }));
                if matches.len() >= max {
                    break;
                }
            }
            if is_dir && !is_skipped_dir(&child) {
                self.search_file_path(&child, pattern, case_sensitive, file_glob, max, matches)?;
            }
        }
        Ok(())
    }

    fn path_matches_file_search(
        &self,
        path: &Path,
        pattern: &str,
        case_sensitive: bool,
        file_glob: Option<&str>,
    ) -> bool {
        if !glob_matches_path(path, file_glob) {
            return false;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        let display = self.display_path(path);
        contains_match(name, pattern, case_sensitive)
            || contains_match(&display, pattern, case_sensitive)
    }

    fn resolve_existing(&self, raw: &str) -> Result<PathBuf, ApiError> {
        let candidate = self.lexical_join(raw)?;
        let resolved = fs::canonicalize(&candidate).map_err(io_api_error)?;
        if !resolved.starts_with(&self.root) {
            return Err(ApiError::new(
                "path_outside_workspace",
                "path escapes workspace",
            ));
        }
        Ok(resolved)
    }

    fn resolve_for_write(&self, raw: &str) -> Result<PathBuf, ApiError> {
        let candidate = self.lexical_join(raw)?;
        if fs::symlink_metadata(&candidate).is_ok() {
            let resolved = fs::canonicalize(&candidate).map_err(io_api_error)?;
            if !resolved.starts_with(&self.root) {
                return Err(ApiError::new(
                    "path_outside_workspace",
                    "path escapes workspace",
                ));
            }
            return Ok(resolved);
        }
        let parent = candidate.parent().unwrap_or(&self.root);
        let resolved_parent = if parent.exists() {
            fs::canonicalize(parent).map_err(io_api_error)?
        } else {
            let nearest = nearest_existing_parent(parent)?;
            fs::canonicalize(nearest).map_err(io_api_error)?
        };
        if !resolved_parent.starts_with(&self.root) {
            return Err(ApiError::new(
                "path_outside_workspace",
                "path escapes workspace",
            ));
        }
        Ok(candidate)
    }

    fn lexical_join(&self, raw: &str) -> Result<PathBuf, ApiError> {
        let raw_path = Path::new(if raw.trim().is_empty() { "." } else { raw });
        let joined = if raw_path.is_absolute() {
            raw_path.to_path_buf()
        } else {
            self.root.join(raw_path)
        };
        let normalized = normalize_path(&joined);
        if !normalized.starts_with(&self.root) {
            return Err(ApiError::new(
                "path_outside_workspace",
                "path escapes workspace",
            ));
        }
        Ok(normalized)
    }

    fn display_path(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .to_string_lossy()
            .trim_start_matches('/')
            .to_string()
    }

    fn ensure_readable_text_file(&self, path: &Path) -> Result<(), ApiError> {
        self.ensure_readable_regular_file(path)
    }

    fn ensure_readable_regular_file(&self, path: &Path) -> Result<(), ApiError> {
        let metadata = fs::metadata(path).map_err(io_api_error)?;
        if is_device_path(path) || is_special_file(&metadata) {
            return Err(ApiError::new(
                "unsafe_device_path",
                "refusing to read device or special file",
            ));
        }
        if !metadata.is_file() {
            return Err(ApiError::new("not_a_file", "path is not a regular file"));
        }
        Ok(())
    }

    fn ensure_safe_write_path(&self, path: &Path) -> Result<(), ApiError> {
        if is_sensitive_system_path(path) {
            return Err(ApiError::new(
                "sensitive_path_denied",
                "refusing to write sensitive system path",
            ));
        }
        Ok(())
    }
}

#[derive(Clone)]
struct ProcessManager {
    root: PathBuf,
    policy: Policy,
    jobs: Arc<Mutex<HashMap<String, Arc<Job>>>>,
}

struct Job {
    id: String,
    kind: ProcessKind,
    command: String,
    started_at_ms: u128,
    child: Mutex<ManagedChild>,
    stdin: Mutex<Option<Box<dyn Write + Send>>>,
    pty_master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    output: Mutex<OutputBuffer>,
    state: Mutex<JobState>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum ProcessKind {
    Pipe,
    Pty,
}

enum ManagedChild {
    Pipe(Child),
    Pty(Box<dyn portable_pty::Child + Send + Sync>),
}

impl ManagedChild {
    fn try_wait(&mut self) -> std::io::Result<Option<i32>> {
        match self {
            ManagedChild::Pipe(child) => Ok(child.try_wait()?.map(|status| {
                status
                    .code()
                    .unwrap_or(if status.success() { 0 } else { 1 })
            })),
            ManagedChild::Pty(child) => Ok(child
                .try_wait()?
                .map(|status| i32::try_from(status.exit_code()).unwrap_or(1))),
        }
    }

    fn kill(&mut self) -> std::io::Result<()> {
        match self {
            ManagedChild::Pipe(child) => child.kill(),
            ManagedChild::Pty(child) => child.kill(),
        }
    }
}

#[derive(Clone, Serialize)]
struct JobState {
    status: String,
    exit_code: Option<i32>,
    timed_out: bool,
}

struct OutputBuffer {
    bytes: Vec<u8>,
    cap: usize,
    dropped_bytes: usize,
}

impl ProcessManager {
    fn new(root: PathBuf, policy: Policy) -> Self {
        Self {
            root,
            policy,
            jobs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn exec(&self, params: Value) -> ApiResult {
        let timeout_ms = u64_param(&params, "timeout_ms").unwrap_or(self.policy.default_timeout_ms);
        let timeout_ms = timeout_ms.min(self.policy.max_timeout_ms);
        let output_limit = usize_param(&params, "output_limit")
            .or_else(|| usize_param(&params, "limit"))
            .unwrap_or(DEFAULT_PROCESS_LOG_BYTES)
            .min(self.policy.max_output_bytes)
            .max(1);
        let result = self.start(params)?;
        let process_id = result
            .get("process_id")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::new("internal_error", "process id missing"))?
            .to_string();
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let state = self.poll(json!({"process_id": process_id}))?;
            if state.get("status").and_then(Value::as_str) != Some("running") {
                let log = self.log(json!({"process_id": process_id, "limit": output_limit}))?;
                return Ok(merge_objects(
                    state,
                    json!({
                        "output": log.get("output").cloned().unwrap_or(json!("")),
                        "output_offset": log.get("offset").cloned().unwrap_or(json!(0)),
                        "output_next_offset": log.get("next_offset").cloned().unwrap_or(json!(0)),
                        "output_dropped_bytes": log.get("dropped_bytes").cloned().unwrap_or(json!(0)),
                        "output_truncated": log.get("truncated").cloned().unwrap_or(json!(false)),
                    }),
                ));
            }
            if Instant::now() >= deadline {
                let _ = self.kill(json!({"process_id": process_id}));
                let log = self.log(json!({"process_id": process_id, "limit": output_limit}))?;
                return Ok(merge_objects(
                    self.poll(json!({"process_id": process_id}))?,
                    json!({
                        "timed_out": true,
                        "output": log.get("output").cloned().unwrap_or(json!("")),
                        "output_offset": log.get("offset").cloned().unwrap_or(json!(0)),
                        "output_next_offset": log.get("next_offset").cloned().unwrap_or(json!(0)),
                        "output_dropped_bytes": log.get("dropped_bytes").cloned().unwrap_or(json!(0)),
                        "output_truncated": log.get("truncated").cloned().unwrap_or(json!(false)),
                    }),
                ));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn start(&self, params: Value) -> ApiResult {
        let command = str_param(&params, "command")
            .ok_or_else(|| ApiError::new("invalid_request", "missing command"))?
            .to_string();
        if command.len() > self.policy.max_command_bytes {
            return Err(ApiError::new(
                "command_too_large",
                "command exceeds policy limit",
            ));
        }
        if self.running_count() >= self.policy.max_background_processes {
            return Err(ApiError::new("process_limit", "too many running processes"));
        }
        if bool_param(&params, "pty").unwrap_or(false) {
            return self.start_pty(&command, params);
        }
        self.start_pipe(&command)
    }

    fn start_pipe(&self, command: &str) -> ApiResult {
        let id = next_id("proc");
        let shell = shell_path();
        let mut child = Command::new(shell)
            .arg("-lc")
            .arg(command)
            .current_dir(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(io_api_error)?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdin = child.stdin.take();
        let job = Arc::new(Job {
            id: id.clone(),
            kind: ProcessKind::Pipe,
            command: command.to_string(),
            started_at_ms: now_ms(),
            child: Mutex::new(ManagedChild::Pipe(child)),
            stdin: Mutex::new(stdin.map(|stdin| Box::new(stdin) as Box<dyn Write + Send>)),
            pty_master: Mutex::new(None),
            output: Mutex::new(OutputBuffer::new(self.policy.max_output_bytes)),
            state: Mutex::new(JobState {
                status: "running".to_string(),
                exit_code: None,
                timed_out: false,
            }),
        });
        if let Some(stdout) = stdout {
            spawn_output_reader(job.clone(), stdout);
        }
        if let Some(stderr) = stderr {
            spawn_output_reader(job.clone(), stderr);
        }
        spawn_reaper(job.clone());
        self.jobs
            .lock()
            .map_err(lock_error)?
            .insert(id.clone(), job);
        Ok(json!({"process_id": id, "kind": "pipe", "status": "running"}))
    }

    fn start_pty(&self, command: &str, params: Value) -> ApiResult {
        let id = next_id("proc");
        let rows = u16_param(&params, "rows").unwrap_or(24).max(1);
        let cols = u16_param(&params, "cols").unwrap_or(80).max(1);
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(anyhow_api_error)?;
        let mut cmd = CommandBuilder::new(shell_path());
        cmd.arg("-lc");
        cmd.arg(command);
        cmd.cwd(&self.root);
        let child = pair.slave.spawn_command(cmd).map_err(anyhow_api_error)?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(anyhow_api_error)?;
        let writer = pair.master.take_writer().map_err(anyhow_api_error)?;
        let job = Arc::new(Job {
            id: id.clone(),
            kind: ProcessKind::Pty,
            command: command.to_string(),
            started_at_ms: now_ms(),
            child: Mutex::new(ManagedChild::Pty(child)),
            stdin: Mutex::new(Some(writer)),
            pty_master: Mutex::new(Some(pair.master)),
            output: Mutex::new(OutputBuffer::new(self.policy.max_output_bytes)),
            state: Mutex::new(JobState {
                status: "running".to_string(),
                exit_code: None,
                timed_out: false,
            }),
        });
        spawn_output_reader(job.clone(), reader);
        spawn_reaper(job.clone());
        self.jobs
            .lock()
            .map_err(lock_error)?
            .insert(id.clone(), job);
        Ok(
            json!({"process_id": id, "kind": "pty", "status": "running", "rows": rows, "cols": cols}),
        )
    }

    fn poll(&self, params: Value) -> ApiResult {
        let job = self.job_from_params(&params)?;
        let state = job.state.lock().map_err(lock_error)?.clone();
        Ok(json!({
            "process_id": job.id,
            "kind": job.kind,
            "command": job.command,
            "started_at_ms": job.started_at_ms,
            "status": state.status,
            "exit_code": state.exit_code,
            "timed_out": state.timed_out
        }))
    }

    fn log(&self, params: Value) -> ApiResult {
        let job = self.job_from_params(&params)?;
        let offset = usize_param(&params, "offset").unwrap_or(0);
        let limit = usize_param(&params, "limit")
            .unwrap_or(DEFAULT_PROCESS_LOG_BYTES)
            .min(self.policy.max_output_bytes)
            .max(1);
        let output = job
            .output
            .lock()
            .map_err(lock_error)?
            .snapshot_range(offset, limit);
        Ok(json!({
            "process_id": job.id,
            "output": output.0,
            "offset": offset,
            "next_offset": output.2,
            "dropped_bytes": output.1,
            "truncated": output.3
        }))
    }

    fn write_stdin(&self, params: Value) -> ApiResult {
        let job = self.job_from_params(&params)?;
        let input = str_param(&params, "input").unwrap_or("");
        let mut guard = job.stdin.lock().map_err(lock_error)?;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| ApiError::new("stdin_closed", "process stdin is closed"))?;
        stdin.write_all(input.as_bytes()).map_err(io_api_error)?;
        stdin.flush().map_err(io_api_error)?;
        Ok(json!({"process_id": job.id, "bytes": input.len()}))
    }

    fn resize(&self, params: Value) -> ApiResult {
        let job = self.job_from_params(&params)?;
        let rows = u16_param(&params, "rows").unwrap_or(24).max(1);
        let cols = u16_param(&params, "cols").unwrap_or(80).max(1);
        let guard = job.pty_master.lock().map_err(lock_error)?;
        let master = guard
            .as_ref()
            .ok_or_else(|| ApiError::new("not_a_pty", "process is not a pty"))?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(anyhow_api_error)?;
        Ok(json!({"process_id": job.id, "rows": rows, "cols": cols}))
    }

    fn kill(&self, params: Value) -> ApiResult {
        let job = self.job_from_params(&params)?;
        {
            let mut state = job.state.lock().map_err(lock_error)?;
            state.status = "killed".to_string();
        }
        let _ = job.child.lock().map_err(lock_error)?.kill();
        Ok(json!({"process_id": job.id, "status": "killed"}))
    }

    fn list(&self, _params: Value) -> ApiResult {
        let jobs = self.jobs.lock().map_err(lock_error)?;
        let mut processes = Vec::with_capacity(jobs.len());
        for job in jobs.values() {
            let state = job.state.lock().map_err(lock_error)?.clone();
            processes.push(json!({
                "process_id": job.id,
                "kind": job.kind,
                "command": job.command,
                "started_at_ms": job.started_at_ms,
                "status": state.status,
                "exit_code": state.exit_code,
                "timed_out": state.timed_out
            }));
        }
        processes.sort_by(|a, b| {
            a.get("started_at_ms")
                .and_then(Value::as_u64)
                .cmp(&b.get("started_at_ms").and_then(Value::as_u64))
        });
        let count = processes.len();
        Ok(json!({"processes": processes, "count": count}))
    }

    fn close_stdin(&self, params: Value) -> ApiResult {
        let job = self.job_from_params(&params)?;
        let mut guard = job.stdin.lock().map_err(lock_error)?;
        let was_open = guard.is_some();
        *guard = None;
        Ok(json!({"process_id": job.id, "stdin_closed": true, "was_open": was_open}))
    }

    fn job_from_params(&self, params: &Value) -> Result<Arc<Job>, ApiError> {
        let id = str_param(params, "process_id")
            .or_else(|| str_param(params, "id"))
            .ok_or_else(|| ApiError::new("invalid_request", "missing process_id"))?;
        self.jobs
            .lock()
            .map_err(lock_error)?
            .get(id)
            .cloned()
            .ok_or_else(|| ApiError::new("unknown_process", format!("unknown process {id}")))
    }

    fn running_count(&self) -> usize {
        self.jobs
            .lock()
            .map(|jobs| {
                jobs.values()
                    .filter(|job| {
                        job.state
                            .lock()
                            .map(|state| state.status == "running")
                            .unwrap_or(false)
                    })
                    .count()
            })
            .unwrap_or(0)
    }
}

impl OutputBuffer {
    fn new(cap: usize) -> Self {
        Self {
            bytes: Vec::new(),
            cap,
            dropped_bytes: 0,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.bytes.extend_from_slice(bytes);
        if self.bytes.len() > self.cap {
            let drain = self.bytes.len() - self.cap;
            self.bytes.drain(0..drain);
            self.dropped_bytes += drain;
        }
    }

    fn snapshot_range(&self, offset: usize, limit: usize) -> (String, usize, usize, bool) {
        let start = offset.min(self.bytes.len());
        let end = start.saturating_add(limit).min(self.bytes.len());
        let truncated = end < self.bytes.len();
        (
            String::from_utf8_lossy(&self.bytes[start..end]).to_string(),
            self.dropped_bytes,
            end,
            truncated,
        )
    }
}

fn spawn_output_reader(job: Arc<Job>, mut reader: impl Read + Send + 'static) {
    thread::spawn(move || {
        let mut buf = [0_u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(mut output) = job.output.lock() {
                        output.push(&buf[..n]);
                    }
                }
                Err(_) => break,
            }
        }
    });
}

fn spawn_reaper(job: Arc<Job>) {
    thread::spawn(move || loop {
        let exit_code = {
            let mut child = match job.child.lock() {
                Ok(child) => child,
                Err(_) => return,
            };
            match child.try_wait() {
                Ok(status) => status,
                Err(_) => None,
            }
        };
        if let Some(exit_code) = exit_code {
            if let Ok(mut state) = job.state.lock() {
                if state.status == "running" {
                    state.status = "exited".to_string();
                }
                state.exit_code = Some(exit_code);
            }
            return;
        }
        thread::sleep(Duration::from_millis(20));
    });
}

fn path_method(path: &str) -> Result<&'static str, ApiError> {
    match path {
        "/v1/exec" | "/v1/process/exec" => Ok("process.exec"),
        "/v1/process/start" => Ok("process.start"),
        "/v1/process/poll" => Ok("process.poll"),
        "/v1/process/log" => Ok("process.log"),
        "/v1/process/write" => Ok("process.write"),
        "/v1/process/resize" => Ok("process.resize"),
        "/v1/process/kill" => Ok("process.kill"),
        "/v1/process/list" => Ok("process.list"),
        "/v1/process/close" => Ok("process.close"),
        "/v1/fs/read" => Ok("fs.read"),
        "/v1/fs/write" => Ok("fs.write"),
        "/v1/fs/stat" => Ok("fs.stat"),
        "/v1/fs/list" => Ok("fs.list"),
        "/v1/fs/search" => Ok("fs.search"),
        "/v1/fs/patch" => Ok("fs.patch"),
        _ => Err(ApiError::new(
            "not_found",
            format!("unknown endpoint {path}"),
        )),
    }
}

fn split_path_query(path: &str) -> (&str, Option<&str>) {
    match path.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (path, None),
    }
}

struct HttpRequest {
    method: String,
    path: String,
    body: Vec<u8>,
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, ApiError> {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(io_api_error)?;
    let mut buf = Vec::new();
    let mut tmp = [0_u8; 4096];
    let header_end;
    loop {
        let n = stream.read(&mut tmp).map_err(io_api_error)?;
        if n == 0 {
            return Err(ApiError::new("bad_request", "connection closed"));
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find_header_end(&buf) {
            header_end = pos;
            break;
        }
        if buf.len() > 64 * 1024 {
            return Err(ApiError::new("bad_request", "headers too large"));
        }
    }
    let header = String::from_utf8_lossy(&buf[..header_end]);
    let mut lines = header.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| ApiError::new("bad_request", "missing request line"))?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut content_length = 0_usize;
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("content-length") {
                content_length = value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| ApiError::new("bad_request", "invalid content-length"))?;
            }
        }
    }
    let body_start = header_end + 4;
    while buf.len() < body_start + content_length {
        let n = stream.read(&mut tmp).map_err(io_api_error)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    let body = buf[body_start..buf.len().min(body_start + content_length)].to_vec();
    Ok(HttpRequest { method, path, body })
}

fn write_http_response(stream: &mut TcpStream, result: ApiResult) -> Result<(), ApiError> {
    let (status, response) = match result {
        Ok(result) => (
            "200 OK",
            ApiResponse {
                ok: true,
                result: Some(result),
                error: None,
            },
        ),
        Err(error) => (
            status_for_error(&error),
            ApiResponse {
                ok: false,
                result: None,
                error: Some(error),
            },
        ),
    };
    let body = serde_json::to_vec(&response)
        .map_err(|err| ApiError::new("json_encode_failed", err.to_string()))?;
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .map_err(io_api_error)?;
    stream.write_all(&body).map_err(io_api_error)?;
    stream.write_all(b"\n").map_err(io_api_error)
}

fn write_blob_http_response(
    stream: &mut TcpStream,
    result: Result<Vec<u8>, ApiError>,
) -> Result<(), ApiError> {
    match result {
        Ok(body) => {
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .map_err(io_api_error)?;
            stream.write_all(&body).map_err(io_api_error)
        }
        Err(error) => write_http_response(stream, Err(error)),
    }
}

fn http_post(url: &str, body: &[u8]) -> Result<(u16, Vec<u8>), ApiError> {
    let url = url
        .strip_prefix("http://")
        .ok_or_else(|| ApiError::new("invalid_url", "only http:// URLs are supported"))?;
    let (host_port, path) = url.split_once('/').unwrap_or((url, ""));
    let mut stream = TcpStream::connect(host_port).map_err(io_api_error)?;
    write!(
        stream,
        "POST /{} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        path,
        host_port,
        body.len()
    )
    .map_err(io_api_error)?;
    stream.write_all(body).map_err(io_api_error)?;
    let mut resp = Vec::new();
    stream.read_to_end(&mut resp).map_err(io_api_error)?;
    let status = parse_http_status(&resp)?;
    let body_start = find_header_end(&resp)
        .map(|pos| pos + 4)
        .ok_or_else(|| ApiError::new("bad_response", "missing response headers"))?;
    Ok((status, resp[body_start..].to_vec()))
}

fn parse_http_status(resp: &[u8]) -> Result<u16, ApiError> {
    let header_end = find_header_end(resp)
        .ok_or_else(|| ApiError::new("bad_response", "missing response headers"))?;
    let header = String::from_utf8_lossy(&resp[..header_end]);
    let status = header
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| ApiError::new("bad_response", "missing HTTP status"))?;
    status
        .parse()
        .map_err(|_| ApiError::new("bad_response", "invalid HTTP status"))
}

fn status_for_error(error: &ApiError) -> &'static str {
    match error.code.as_str() {
        "bad_request" | "invalid_json" | "invalid_request" | "invalid_flag" => "400 Bad Request",
        "not_found" | "unknown_process" => "404 Not Found",
        "path_outside_workspace" | "permission_denied" => "403 Forbidden",
        _ => "500 Internal Server Error",
    }
}

fn decode_params(body: &[u8]) -> Result<Value, ApiError> {
    if body.is_empty() {
        return Ok(json!({}));
    }
    let raw: Value = serde_json::from_slice(body)
        .map_err(|err| ApiError::new("invalid_json", err.to_string()))?;
    Ok(raw.get("params").cloned().unwrap_or(raw))
}

fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    let query = query?;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if percent_decode_query_component(key).ok().as_deref() == Some(name) {
            return percent_decode_query_component(value).ok();
        }
    }
    None
}

fn percent_decode_query_component(input: &str) -> Result<String, ApiError> {
    let mut out = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hi = hex_value(bytes[index + 1])
                    .ok_or_else(|| ApiError::new("invalid_request", "invalid percent escape"))?;
                let lo = hex_value(bytes[index + 2])
                    .ok_or_else(|| ApiError::new("invalid_request", "invalid percent escape"))?;
                out.push((hi << 4) | lo);
                index += 3;
            }
            b'%' => return Err(ApiError::new("invalid_request", "truncated percent escape")),
            other => {
                out.push(other);
                index += 1;
            }
        }
    }
    String::from_utf8(out).map_err(|err| ApiError::new("invalid_request", err.to_string()))
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn nearest_existing_parent(path: &Path) -> Result<&Path, ApiError> {
    let mut current = path;
    loop {
        if current.exists() {
            return Ok(current);
        }
        current = current
            .parent()
            .ok_or_else(|| ApiError::new("not_found", "no existing parent directory"))?;
    }
}

fn is_skipped_dir(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    matches!(name, ".git" | "node_modules" | "target" | "__pycache__")
}

fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    if bytes.iter().take(8192).any(|byte| *byte == 0) {
        return true;
    }
    std::str::from_utf8(bytes).is_err()
}

fn is_device_path(path: &Path) -> bool {
    path.starts_with("/dev")
}

#[cfg(unix)]
fn is_special_file(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::FileTypeExt;
    let file_type = metadata.file_type();
    file_type.is_block_device()
        || file_type.is_char_device()
        || file_type.is_fifo()
        || file_type.is_socket()
}

#[cfg(not(unix))]
fn is_special_file(_metadata: &fs::Metadata) -> bool {
    false
}

fn is_sensitive_system_path(path: &Path) -> bool {
    [
        "/etc", "/boot", "/proc", "/sys", "/dev", "/run", "/var/run", "/var/lib", "/usr", "/bin",
        "/sbin", "/lib", "/lib64",
    ]
    .iter()
    .any(|prefix| path.starts_with(prefix))
        || path == Path::new("/var/run/docker.sock")
        || path == Path::new("/run/docker.sock")
}

fn contains_match(haystack: &str, needle: &str, case_sensitive: bool) -> bool {
    if case_sensitive {
        haystack.contains(needle)
    } else {
        haystack.to_lowercase().contains(&needle.to_lowercase())
    }
}

fn glob_matches_path(path: &Path, pattern: Option<&str>) -> bool {
    let Some(pattern) = pattern.filter(|value| !value.trim().is_empty()) else {
        return true;
    };
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let path = path.to_string_lossy();
    wildcard_match(pattern, name) || wildcard_match(pattern, &path)
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    let (mut pi, mut vi) = (0, 0);
    let mut star = None;
    let mut star_vi = 0;
    while vi < value.len() {
        if pi < pattern.len() && (pattern[pi] == b'?' || pattern[pi] == value[vi]) {
            pi += 1;
            vi += 1;
        } else if pi < pattern.len() && pattern[pi] == b'*' {
            star = Some(pi);
            pi += 1;
            star_vi = vi;
        } else if let Some(star_pi) = star {
            pi = star_pi + 1;
            star_vi += 1;
            vi = star_vi;
        } else {
            return false;
        }
    }
    while pi < pattern.len() && pattern[pi] == b'*' {
        pi += 1;
    }
    pi == pattern.len()
}

fn normalize_whitespace(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n")
}

fn fuzzy_replace(content: &str, find: &str, replace: &str) -> Option<(String, usize)> {
    let normalized_find = normalize_whitespace(find);
    if normalized_find.is_empty() {
        return None;
    }
    let content_lines: Vec<&str> = content.lines().collect();
    let find_lines: Vec<&str> = normalized_find.lines().collect();
    if find_lines.is_empty() {
        return None;
    }

    let mut replacements = 0;
    let mut result_lines = Vec::new();
    let mut index = 0;
    while index < content_lines.len() {
        let mut matched = index + find_lines.len() <= content_lines.len();
        if matched {
            for (offset, find_line) in find_lines.iter().enumerate() {
                let normalized_line = content_lines[index + offset]
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                if normalized_line != *find_line {
                    matched = false;
                    break;
                }
            }
        }
        if matched {
            result_lines.extend(replace.lines().map(str::to_string));
            index += find_lines.len();
            replacements += 1;
        } else {
            result_lines.push(content_lines[index].to_string());
            index += 1;
        }
    }

    if replacements == 0 {
        return None;
    }
    let mut result = result_lines.join("\n");
    if content.ends_with('\n') && !result.ends_with('\n') {
        result.push('\n');
    }
    Some((result, replacements))
}

fn str_param<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str)
}

fn bool_param(params: &Value, key: &str) -> Option<bool> {
    params.get(key).and_then(Value::as_bool)
}

fn usize_param(params: &Value, key: &str) -> Option<usize> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|v| usize::try_from(v).ok())
}

fn u64_param(params: &Value, key: &str) -> Option<u64> {
    params.get(key).and_then(Value::as_u64)
}

fn u16_param(params: &Value, key: &str) -> Option<u16> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|v| u16::try_from(v).ok())
}

fn take_arg<'a>(args: &'a [String], index: usize, flag: &str) -> Result<&'a str, ApiError> {
    args.get(index)
        .map(String::as_str)
        .ok_or_else(|| ApiError::new("invalid_flag", format!("{flag} requires a value")))
}

fn parse_usize(value: &str) -> Result<usize, ApiError> {
    value
        .parse()
        .map_err(|_| ApiError::new("invalid_flag", format!("invalid integer {value}")))
}

fn parse_u64(value: &str) -> Result<u64, ApiError> {
    value
        .parse()
        .map_err(|_| ApiError::new("invalid_flag", format!("invalid integer {value}")))
}

fn is_help(arg: &str) -> bool {
    matches!(arg, "-h" | "--help" | "help")
}

fn io_api_error(err: std::io::Error) -> ApiError {
    match err.kind() {
        std::io::ErrorKind::NotFound => ApiError::new("not_found", err.to_string()),
        std::io::ErrorKind::PermissionDenied => ApiError::new("permission_denied", err.to_string()),
        _ => ApiError::new("io_error", err.to_string()),
    }
}

fn anyhow_api_error(err: anyhow::Error) -> ApiError {
    ApiError::new("pty_error", err.to_string())
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> ApiError {
    ApiError::new("lock_poisoned", "internal lock poisoned")
}

fn next_id(prefix: &str) -> String {
    format!(
        "{}_{}_{}",
        prefix,
        now_ms(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn shell_path() -> &'static str {
    if Path::new("/bin/bash").exists() {
        "/bin/bash"
    } else {
        "/bin/sh"
    }
}

fn merge_objects(left: Value, right: Value) -> Value {
    let mut merged = Map::new();
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

fn page_values(values: &[Value], offset: usize, limit: usize) -> Vec<Value> {
    values.iter().skip(offset).take(limit).cloned().collect()
}

fn truncate_text_for_tool_line(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}...[line truncated]", &value[..end]), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> Host {
        let root = std::env::temp_dir().join(next_id("sandbox_host_test"));
        Host::new(Config {
            workspace: root,
            ..Config::default()
        })
        .unwrap()
    }

    #[test]
    fn fs_write_read_and_escape_guard() {
        let host = host();
        host.dispatch(
            "fs.write",
            json!({"path": "notes/a.txt", "content": "alpha\nbeta\n"}),
        )
        .unwrap();
        let read = host
            .dispatch("fs.read", json!({"path": "notes/a.txt"}))
            .unwrap();
        assert_eq!(read["content"], "alpha\nbeta");
        let escaped = host.dispatch("fs.read", json!({"path": "../outside"}));
        assert_eq!(escaped.unwrap_err().code, "path_outside_workspace");
    }

    #[test]
    fn fs_stat_and_blob_round_trip_binary_without_text_read() {
        let host = host();
        let payload = vec![0_u8, 1, 2, 3, 255];
        let written = host
            .fs
            .write_blob_from_query(Some("path=bin%2Fblob.bin"), &payload)
            .unwrap();
        assert_eq!(written["path"], "bin/blob.bin");
        assert_eq!(written["bytes"], payload.len());

        let stat = host
            .dispatch("fs.stat", json!({"path": "bin/blob.bin"}))
            .unwrap();
        assert_eq!(stat["is_file"], true);
        assert_eq!(stat["size"], payload.len());

        let read = host
            .fs
            .read_blob_from_query(Some("path=bin%2Fblob.bin"))
            .unwrap();
        assert_eq!(read, payload);

        let text_read = host.dispatch("fs.read", json!({"path": "bin/blob.bin"}));
        assert_eq!(text_read.unwrap_err().code, "binary_file");
    }

    #[test]
    fn fs_patch_and_search() {
        let host = host();
        host.dispatch(
            "fs.write",
            json!({"path": "a.txt", "content": "hello world\n"}),
        )
        .unwrap();
        host.dispatch(
            "fs.patch",
            json!({"path": "a.txt", "old_text": "world", "new_text": "sandbox"}),
        )
        .unwrap();
        let search = host
            .dispatch("fs.search", json!({"path": ".", "pattern": "sandbox"}))
            .unwrap();
        assert_eq!(search["count"], 1);
        let files = host
            .dispatch(
                "fs.search",
                json!({"path": ".", "target": "files", "pattern": "a", "file_glob": "*.txt"}),
            )
            .unwrap();
        assert_eq!(files["target"], "files");
        assert_eq!(files["count"], 1);
        assert_eq!(files["matches"][0]["path"], "a.txt");
    }

    #[test]
    fn fs_search_supports_pagination_context_and_output_modes() {
        let host = host();
        host.dispatch(
            "fs.write",
            json!({"path": "a.txt", "content": "one\nneedle one\ntwo\nneedle two\nthree\n"}),
        )
        .unwrap();
        host.dispatch(
            "fs.write",
            json!({"path": "b.txt", "content": "needle three\n"}),
        )
        .unwrap();

        let page = host
            .dispatch(
                "fs.search",
                json!({
                    "path": "a.txt",
                    "pattern": "needle",
                    "limit": 2,
                    "offset": 1,
                    "context": 1
                }),
            )
            .unwrap();
        assert_eq!(page["target"], "content");
        assert_eq!(page["output_mode"], "content");
        assert_eq!(page["offset"], 1);
        assert_eq!(page["limit"], 2);
        assert_eq!(page["count"], 2);
        assert_eq!(page["matches"][0]["path"], "a.txt");
        assert_eq!(page["matches"][0]["line"], 2);
        assert_eq!(page["matches"][0]["is_context"], false);
        assert_eq!(page["truncated"], true);
        assert_eq!(page["next_offset"], 3);

        let files_only = host
            .dispatch(
                "fs.search",
                json!({
                    "path": ".",
                    "pattern": "needle",
                    "output_mode": "files_only",
                    "limit": 10
                }),
            )
            .unwrap();
        let files = files_only["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        assert!(files.contains(&Value::String("a.txt".to_string())));
        assert!(files.contains(&Value::String("b.txt".to_string())));

        let counts = host
            .dispatch(
                "fs.search",
                json!({"path": ".", "pattern": "needle", "output_mode": "count"}),
            )
            .unwrap();
        assert_eq!(counts["counts"]["a.txt"], 2);
        assert_eq!(counts["counts"]["b.txt"], 1);
        assert_eq!(counts["total_count"], 3);
    }

    #[test]
    fn fs_search_truncates_very_long_matching_lines() {
        let host = host();
        let long_line = format!("needle {}", "x".repeat(900));
        host.dispatch(
            "fs.write",
            json!({"path": "long.txt", "content": long_line}),
        )
        .unwrap();

        let search = host
            .dispatch("fs.search", json!({"path": ".", "pattern": "needle"}))
            .unwrap();
        let text = search["matches"][0]["text"].as_str().unwrap();
        assert!(text.len() < 600);
        assert!(text.ends_with("[line truncated]"));
        assert_eq!(search["matches"][0]["line_truncated"], true);
    }

    #[test]
    fn process_exec_defaults_to_bounded_output() {
        let host = host();
        let result = host
            .dispatch(
                "process.exec",
                json!({"command": "head -c 70000 /dev/zero | tr '\\0' a"}),
            )
            .unwrap();
        let output = result["output"].as_str().unwrap();
        assert!(output.len() <= DEFAULT_PROCESS_LOG_BYTES);
        assert_eq!(result["output_truncated"], true);
        assert_eq!(result["output_next_offset"], DEFAULT_PROCESS_LOG_BYTES);
    }

    #[test]
    fn fs_patch_supports_fuzzy_match_and_file_size() {
        let host = host();
        host.dispatch(
            "fs.write",
            json!({"path": "fuzzy.txt", "content": "hello,   world\n"}),
        )
        .unwrap();
        let patched = host
            .dispatch(
                "fs.patch",
                json!({"path": "fuzzy.txt", "old_text": "hello, world", "new_text": "hi"}),
            )
            .unwrap();
        assert_eq!(patched["match_type"], "fuzzy");
        assert_eq!(patched["replacements"], 1);
        assert!(patched["file_size"].as_u64().unwrap() > 0);
    }

    #[test]
    fn fs_read_rejects_binary_files() {
        let host = host();
        let path = host.cfg.workspace.join("blob.bin");
        fs::write(&path, [0_u8, 1, 2, 3]).unwrap();
        let error = host
            .dispatch("fs.read", json!({"path": "blob.bin"}))
            .unwrap_err();
        assert_eq!(error.code, "binary_file");
    }

    #[test]
    #[cfg(unix)]
    fn fs_read_rejects_device_paths() {
        if !Path::new("/dev/zero").exists() {
            return;
        }
        let host = Host::new(Config {
            workspace: PathBuf::from("/"),
            ..Config::default()
        })
        .unwrap();
        let error = host
            .dispatch("fs.read", json!({"path": "/dev/zero"}))
            .unwrap_err();
        assert_eq!(error.code, "unsafe_device_path");
    }

    #[test]
    fn fs_write_rejects_sensitive_system_paths() {
        let host = Host::new(Config {
            workspace: PathBuf::from("/"),
            ..Config::default()
        })
        .unwrap();
        let error = host
            .dispatch(
                "fs.write",
                json!({"path": "/etc/cloudagent-sandbox-host-test", "content": "no"}),
            )
            .unwrap_err();
        assert_eq!(error.code, "sensitive_path_denied");
    }

    #[test]
    #[cfg(unix)]
    fn fs_write_rejects_symlink_escape() {
        let host = host();
        let outside = std::env::temp_dir().join(next_id("outside_write_target"));
        fs::write(&outside, "outside").unwrap();
        std::os::unix::fs::symlink(&outside, host.cfg.workspace.join("link")).unwrap();
        let error = host
            .dispatch("fs.write", json!({"path": "link", "content": "escape"}))
            .unwrap_err();
        assert_eq!(error.code, "path_outside_workspace");
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside");
        let _ = fs::remove_file(outside);
    }

    #[test]
    #[cfg(unix)]
    fn fs_search_skips_symlinked_paths() {
        let host = host();
        let outside_dir = std::env::temp_dir().join(next_id("outside_search_dir"));
        fs::create_dir_all(&outside_dir).unwrap();
        fs::write(outside_dir.join("secret.txt"), "needle").unwrap();
        std::os::unix::fs::symlink(&outside_dir, host.cfg.workspace.join("linked")).unwrap();
        let search = host
            .dispatch("fs.search", json!({"path": ".", "pattern": "needle"}))
            .unwrap();
        assert_eq!(search["count"], 0);
        let files = host
            .dispatch(
                "fs.search",
                json!({"path": ".", "target": "files", "pattern": "secret"}),
            )
            .unwrap();
        assert_eq!(files["count"], 0);
        let _ = fs::remove_file(host.cfg.workspace.join("linked"));
        let _ = fs::remove_dir_all(outside_dir);
    }

    #[test]
    fn process_exec_returns_output() {
        let host = host();
        let result = host
            .dispatch("process.exec", json!({"command": "printf hello"}))
            .unwrap();
        assert_eq!(result["status"], "exited");
        assert_eq!(result["exit_code"], 0);
        assert_eq!(result["output"], "hello");
    }

    #[test]
    fn process_pty_exec_reports_tty_and_resize() {
        let host = host();
        let started = host
            .dispatch(
                "process.start",
                json!({"command": "test -t 0 && printf pty-ok", "pty": true, "rows": 12, "cols": 40}),
            )
            .unwrap();
        assert_eq!(started["kind"], "pty");
        let id = started["process_id"].as_str().unwrap();
        host.dispatch(
            "process.resize",
            json!({"process_id": id, "rows": 24, "cols": 80}),
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let polled = host
                .dispatch("process.poll", json!({"process_id": id}))
                .unwrap();
            if polled["status"] != "running" {
                break;
            }
            assert!(Instant::now() < deadline, "pty process did not exit");
            thread::sleep(Duration::from_millis(20));
        }
        let log = host
            .dispatch("process.log", json!({"process_id": id}))
            .unwrap();
        assert!(log["output"].as_str().unwrap().contains("pty-ok"));
    }

    #[test]
    fn process_start_poll_and_kill() {
        let host = host();
        let started = host
            .dispatch("process.start", json!({"command": "sleep 5"}))
            .unwrap();
        let id = started["process_id"].as_str().unwrap();
        let polled = host
            .dispatch("process.poll", json!({"process_id": id}))
            .unwrap();
        assert_eq!(polled["status"], "running");
        let killed = host
            .dispatch("process.kill", json!({"process_id": id}))
            .unwrap();
        assert_eq!(killed["status"], "killed");
    }

    #[test]
    fn process_list_and_close_stdin() {
        let host = host();
        let started = host
            .dispatch("process.start", json!({"command": "cat"}))
            .unwrap();
        let id = started["process_id"].as_str().unwrap();
        let listed = host.dispatch("process.list", json!({})).unwrap();
        assert_eq!(listed["count"], 1);
        assert_eq!(listed["processes"][0]["process_id"], id);
        let closed = host
            .dispatch("process.close", json!({"process_id": id}))
            .unwrap();
        assert_eq!(closed["stdin_closed"], true);
        let write_error = host
            .dispatch("process.write", json!({"process_id": id, "input": "hello"}))
            .unwrap_err();
        assert_eq!(write_error.code, "stdin_closed");
        let _ = host.dispatch("process.kill", json!({"process_id": id}));
    }
}
