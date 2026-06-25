use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Map, Value, json};
use sqlx::{Row, SqlitePool, sqlite::SqlitePoolOptions};
use thiserror::Error;
use tokio::{
    fs::{self, OpenOptions},
    io::AsyncWriteExt,
    sync::Mutex,
};
use tracing::{
    Event, Level, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{Layer, layer::Context, registry::LookupSpan};

const RAW_JSONL_MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum ObservabilityError {
    #[error("sql error: {0}")]
    Sql(#[from] sqlx::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, ObservabilityError>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TraceContext {
    pub trace_id: String,
    pub span_id: String,
    pub trace_flags: String,
}

#[derive(Clone, Debug)]
pub struct ManualSpan {
    pub trace: TraceContext,
    pub parent_span_id: Option<String>,
    pub name: String,
    pub start_time: DateTime<Utc>,
    pub end_time: DateTime<Utc>,
    pub status_code: Option<String>,
    pub status_message: Option<String>,
    pub session_id: Option<String>,
    pub backend: Option<String>,
    pub error_message: Option<String>,
    pub attributes: Value,
}

#[derive(Clone, Debug)]
pub struct ManualLog {
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
    pub severity: Option<String>,
    pub body: Option<String>,
    pub session_id: Option<String>,
    pub backend: Option<String>,
    pub error_message: Option<String>,
    pub attributes: Value,
    pub raw: Value,
}

#[derive(Clone)]
pub struct ObservabilityStore {
    pool: SqlitePool,
    raw: Option<RawJsonlStore>,
}

#[derive(Clone)]
struct RawJsonlStore {
    dir: Arc<PathBuf>,
    lock: Arc<Mutex<()>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct IngestSummary {
    pub accepted: bool,
    pub spans: usize,
    pub logs: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct ObservabilityStatus {
    pub enabled: bool,
    pub spans: i64,
    pub logs: i64,
    pub raw_dir: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TraceDetail {
    pub trace_id: String,
    pub spans: Vec<SpanRecord>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ErrorRecord {
    pub source: String,
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
    pub name: String,
    pub message: String,
    pub session_id: Option<String>,
    pub backend: Option<String>,
    pub observed_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SpanRecord {
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub name: String,
    pub start_time_unix_nano: Option<i64>,
    pub end_time_unix_nano: Option<i64>,
    pub duration_ms: Option<f64>,
    pub status_code: Option<String>,
    pub status_message: Option<String>,
    pub session_id: Option<String>,
    pub backend: Option<String>,
    pub error_message: Option<String>,
    pub attributes: Value,
    pub observed_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
struct LogRecord {
    trace_id: Option<String>,
    span_id: Option<String>,
    severity: Option<String>,
    body: Option<String>,
    session_id: Option<String>,
    backend: Option<String>,
    error_message: Option<String>,
    attributes: Value,
    raw: Value,
}

impl ObservabilityStore {
    pub async fn connect_for_database_url(database_url: &str) -> Result<Self> {
        let raw_dir = raw_dir_for_database_url(database_url);
        Self::connect(database_url, raw_dir.as_deref()).await
    }

    pub async fn connect(database_url: &str, raw_dir: Option<&Path>) -> Result<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(database_url)
            .await?;
        let store = Self {
            pool,
            raw: raw_dir.map(|dir| RawJsonlStore {
                dir: Arc::new(dir.to_path_buf()),
                lock: Arc::new(Mutex::new(())),
            }),
        };
        store.migrate().await?;
        Ok(store)
    }

    async fn migrate(&self) -> Result<()> {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS observability_spans (
                trace_id TEXT NOT NULL,
                span_id TEXT NOT NULL,
                parent_span_id TEXT,
                name TEXT NOT NULL,
                start_time_unix_nano INTEGER,
                end_time_unix_nano INTEGER,
                duration_ms REAL,
                status_code TEXT,
                status_message TEXT,
                session_id TEXT,
                backend TEXT,
                error_message TEXT,
                attributes_json TEXT NOT NULL,
                raw_json TEXT NOT NULL,
                observed_at TEXT NOT NULL,
                PRIMARY KEY(trace_id, span_id)
            );

            CREATE INDEX IF NOT EXISTS idx_observability_spans_trace
                ON observability_spans(trace_id, start_time_unix_nano);

            CREATE INDEX IF NOT EXISTS idx_observability_spans_errors
                ON observability_spans(observed_at)
                WHERE error_message IS NOT NULL OR status_code = 'ERROR';

            CREATE TABLE IF NOT EXISTS observability_logs (
                id TEXT PRIMARY KEY,
                trace_id TEXT,
                span_id TEXT,
                severity TEXT,
                body TEXT,
                session_id TEXT,
                backend TEXT,
                error_message TEXT,
                attributes_json TEXT NOT NULL,
                raw_json TEXT NOT NULL,
                observed_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_observability_logs_errors
                ON observability_logs(observed_at)
                WHERE error_message IS NOT NULL OR severity IN ('ERROR', 'FATAL');
            "#,
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn ingest_traces(&self, payload: Value) -> Result<IngestSummary> {
        if let Some(raw) = &self.raw {
            raw.append("traces.jsonl", &payload).await?;
        }

        let spans = extract_spans(&payload);
        for span in &spans {
            self.insert_span(span).await?;
        }

        Ok(IngestSummary {
            accepted: true,
            spans: spans.len(),
            logs: 0,
        })
    }

    pub async fn ingest_logs(&self, payload: Value) -> Result<IngestSummary> {
        if let Some(raw) = &self.raw {
            raw.append("logs.jsonl", &payload).await?;
        }

        let logs = extract_logs(&payload);
        for log in &logs {
            self.insert_log(log).await?;
        }

        Ok(IngestSummary {
            accepted: true,
            spans: 0,
            logs: logs.len(),
        })
    }

    pub async fn record_span(&self, span: ManualSpan) -> Result<()> {
        let start = span.start_time.timestamp_nanos_opt();
        let end = span.end_time.timestamp_nanos_opt();
        let duration_ms = start
            .zip(end)
            .map(|(start, end)| ((end - start).max(0) as f64) / 1_000_000.0);
        self.insert_span(&SpanRecordForInsert {
            trace_id: span.trace.trace_id,
            span_id: new_span_id(),
            parent_span_id: span.parent_span_id.or(Some(span.trace.span_id)),
            name: span.name,
            start_time_unix_nano: start,
            end_time_unix_nano: end,
            duration_ms,
            status_code: span.status_code,
            status_message: span.status_message,
            session_id: span.session_id,
            backend: span.backend,
            error_message: span.error_message,
            attributes: span.attributes,
            raw: json!({
                "source": "vela.manual",
                "trace_flags": span.trace.trace_flags,
            }),
            observed_at: Utc::now(),
        })
        .await
    }

    pub async fn record_log(&self, log: ManualLog) -> Result<()> {
        if let Some(raw) = &self.raw {
            raw.append("logs.jsonl", &log.raw).await?;
        }
        self.insert_log(&LogRecord {
            trace_id: log.trace_id,
            span_id: log.span_id,
            severity: log.severity,
            body: log.body,
            session_id: log.session_id,
            backend: log.backend,
            error_message: log.error_message,
            attributes: log.attributes,
            raw: log.raw,
        })
        .await
    }

    pub async fn status(&self) -> Result<ObservabilityStatus> {
        let spans = count_table(&self.pool, "observability_spans").await?;
        let logs = count_table(&self.pool, "observability_logs").await?;
        Ok(ObservabilityStatus {
            enabled: true,
            spans,
            logs,
            raw_dir: self.raw.as_ref().map(|raw| raw.dir.display().to_string()),
        })
    }

    pub async fn trace_detail(&self, trace_id: &str) -> Result<Option<TraceDetail>> {
        let rows = sqlx::query(
            r#"
            SELECT trace_id, span_id, parent_span_id, name, start_time_unix_nano,
                   end_time_unix_nano, duration_ms, status_code, status_message,
                   session_id, backend, error_message, attributes_json, observed_at
            FROM observability_spans
            WHERE trace_id = ?1
            ORDER BY start_time_unix_nano IS NULL, start_time_unix_nano, observed_at
            "#,
        )
        .bind(trace_id)
        .fetch_all(&self.pool)
        .await?;
        if rows.is_empty() {
            return Ok(None);
        }
        let mut spans = Vec::with_capacity(rows.len());
        for row in rows {
            spans.push(span_from_row(row)?);
        }
        Ok(Some(TraceDetail {
            trace_id: trace_id.to_string(),
            spans,
        }))
    }

    pub async fn recent_errors(&self, limit: usize) -> Result<Vec<ErrorRecord>> {
        let limit = limit.clamp(1, 500) as i64;
        let rows = sqlx::query(
            r#"
            SELECT 'span' AS source, trace_id, span_id, name,
                   COALESCE(error_message, status_message, status_code, 'span failed') AS message,
                   session_id, backend, observed_at
            FROM observability_spans
            WHERE error_message IS NOT NULL OR status_code = 'ERROR'
            UNION ALL
            SELECT 'log' AS source, trace_id, span_id, COALESCE(severity, 'log') AS name,
                   COALESCE(error_message, body, 'log error') AS message,
                   session_id, backend, observed_at
            FROM observability_logs
            WHERE error_message IS NOT NULL OR severity IN ('ERROR', 'FATAL')
            ORDER BY observed_at DESC
            LIMIT ?1
            "#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(error_from_row).collect()
    }

    async fn insert_span(&self, span: &SpanRecordForInsert) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO observability_spans (
                trace_id, span_id, parent_span_id, name, start_time_unix_nano,
                end_time_unix_nano, duration_ms, status_code, status_message,
                session_id, backend, error_message, attributes_json, raw_json, observed_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
            ON CONFLICT(trace_id, span_id) DO UPDATE SET
                parent_span_id = excluded.parent_span_id,
                name = excluded.name,
                start_time_unix_nano = excluded.start_time_unix_nano,
                end_time_unix_nano = excluded.end_time_unix_nano,
                duration_ms = excluded.duration_ms,
                status_code = excluded.status_code,
                status_message = excluded.status_message,
                session_id = excluded.session_id,
                backend = excluded.backend,
                error_message = excluded.error_message,
                attributes_json = excluded.attributes_json,
                raw_json = excluded.raw_json,
                observed_at = excluded.observed_at
            "#,
        )
        .bind(&span.trace_id)
        .bind(&span.span_id)
        .bind(&span.parent_span_id)
        .bind(&span.name)
        .bind(span.start_time_unix_nano)
        .bind(span.end_time_unix_nano)
        .bind(span.duration_ms)
        .bind(&span.status_code)
        .bind(&span.status_message)
        .bind(&span.session_id)
        .bind(&span.backend)
        .bind(&span.error_message)
        .bind(serde_json::to_string(&span.attributes)?)
        .bind(serde_json::to_string(&span.raw)?)
        .bind(span.observed_at.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn insert_log(&self, log: &LogRecord) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO observability_logs (
                id, trace_id, span_id, severity, body, session_id, backend,
                error_message, attributes_json, raw_json, observed_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            "#,
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&log.trace_id)
        .bind(&log.span_id)
        .bind(&log.severity)
        .bind(&log.body)
        .bind(&log.session_id)
        .bind(&log.backend)
        .bind(&log.error_message)
        .bind(serde_json::to_string(&log.attributes)?)
        .bind(serde_json::to_string(&log.raw)?)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[derive(Clone)]
pub struct TracingLogLayer {
    store: ObservabilityStore,
}

pub fn tracing_log_layer(store: ObservabilityStore) -> TracingLogLayer {
    TracingLogLayer { store }
}

impl<S> Layer<S> for TracingLogLayer
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let log = tracing_event_to_log(event, ctx);
        let store = self.store.clone();
        tokio::spawn(async move {
            let _ = store.record_log(log).await;
        });
    }
}

pub fn parse_traceparent(value: &str) -> Option<TraceContext> {
    let mut parts = value.split('-');
    let version = parts.next()?;
    let trace_id = parts.next()?;
    let span_id = parts.next()?;
    let trace_flags = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if version != "00" {
        return None;
    }
    if trace_id.len() != 32
        || span_id.len() != 16
        || trace_flags.len() != 2
        || !trace_id.chars().all(|value| value.is_ascii_hexdigit())
        || !span_id.chars().all(|value| value.is_ascii_hexdigit())
        || !trace_flags.chars().all(|value| value.is_ascii_hexdigit())
        || trace_id.chars().all(|value| value == '0')
        || span_id.chars().all(|value| value == '0')
    {
        return None;
    }
    Some(TraceContext {
        trace_id: trace_id.to_string(),
        span_id: span_id.to_string(),
        trace_flags: trace_flags.to_string(),
    })
}

fn tracing_event_to_log<S>(event: &Event<'_>, ctx: Context<'_, S>) -> ManualLog
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
    let metadata = event.metadata();
    let mut visitor = TracingFieldVisitor::default();
    event.record(&mut visitor);

    let mut attributes = visitor.fields.clone();
    attributes.insert(
        "rust.target".to_string(),
        Value::String(metadata.target().to_string()),
    );
    attributes.insert(
        "rust.level".to_string(),
        Value::String(metadata.level().as_str().to_string()),
    );
    if let Some(module_path) = metadata.module_path() {
        attributes.insert(
            "rust.module_path".to_string(),
            Value::String(module_path.to_string()),
        );
    }
    if let Some(file) = metadata.file() {
        attributes.insert("code.filepath".to_string(), Value::String(file.to_string()));
    }
    if let Some(line) = metadata.line() {
        attributes.insert("code.lineno".to_string(), json!(line));
    }
    if let Some(scope) = ctx.event_scope(event) {
        let span_names = scope
            .from_root()
            .map(|span| Value::String(span.name().to_string()))
            .collect::<Vec<_>>();
        if !span_names.is_empty() {
            attributes.insert("tracing.span.stack".to_string(), Value::Array(span_names));
        }
    }

    let severity = Some(metadata.level().as_str().to_string());
    let body = visitor
        .message
        .clone()
        .or_else(|| visitor.error_message.clone())
        .or_else(|| Some(metadata.name().to_string()));
    let error_message = visitor
        .error_message
        .clone()
        .or_else(|| body.clone().filter(|_| *metadata.level() == Level::ERROR));
    let attributes_value = Value::Object(attributes);
    ManualLog {
        trace_id: visitor.trace_id,
        span_id: visitor.span_id,
        severity,
        body,
        session_id: visitor.session_id,
        backend: visitor.backend,
        error_message,
        attributes: attributes_value.clone(),
        raw: json!({
            "source": "rust.tracing",
            "target": metadata.target(),
            "level": metadata.level().as_str(),
            "name": metadata.name(),
            "fields": attributes_value,
        }),
    }
}

#[derive(Default)]
struct TracingFieldVisitor {
    fields: Map<String, Value>,
    message: Option<String>,
    trace_id: Option<String>,
    span_id: Option<String>,
    session_id: Option<String>,
    backend: Option<String>,
    error_message: Option<String>,
}

impl TracingFieldVisitor {
    fn record_json(&mut self, field: &Field, value: Value) {
        let name = field.name();
        let text = json_value_text(&value);
        match name {
            "message" => self.message = Some(text.clone()),
            "trace_id" | "trace.id" | "otel.trace_id" => self.trace_id = Some(text.clone()),
            "span_id" | "span.id" | "otel.span_id" => self.span_id = Some(text.clone()),
            "session_id" | "session.id" | "vela.session_id" => self.session_id = Some(text.clone()),
            "backend" | "backend.kind" | "vela.backend" => self.backend = Some(text.clone()),
            "error" | "error.message" | "exception.message" => {
                self.error_message = Some(text.clone())
            }
            _ => {}
        }
        self.fields.insert(name.to_string(), value);
    }
}

impl Visit for TracingFieldVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.record_json(field, Value::String(format!("{value:?}")));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.record_json(field, Value::String(value.to_string()));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.record_json(field, json!(value));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.record_json(field, json!(value));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.record_json(field, json!(value));
    }

    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.record_json(field, Value::String(value.to_string()));
    }
}

impl RawJsonlStore {
    async fn append(&self, file_name: &str, payload: &Value) -> Result<()> {
        let _guard = self.lock.lock().await;
        fs::create_dir_all(&*self.dir).await?;
        let path = self.dir.join(file_name);
        let line = json!({
            "observed_at": Utc::now(),
            "payload": payload,
        });
        let mut line = serde_json::to_string(&line)?;
        line.push('\n');
        rotate_jsonl_if_needed(&path, line.len() as u64, RAW_JSONL_MAX_BYTES).await?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .await?;
        file.write_all(line.as_bytes()).await?;
        Ok(())
    }
}

async fn rotate_jsonl_if_needed(path: &Path, incoming_bytes: u64, max_bytes: u64) -> Result<()> {
    let Ok(metadata) = fs::metadata(path).await else {
        return Ok(());
    };
    if metadata.len() == 0 || metadata.len().saturating_add(incoming_bytes) <= max_bytes {
        return Ok(());
    }
    let rotated = path.with_file_name(format!(
        "{}.1",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("observability.jsonl")
    ));
    match fs::remove_file(&rotated).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    fs::rename(path, rotated).await?;
    Ok(())
}

#[derive(Debug)]
struct SpanRecordForInsert {
    trace_id: String,
    span_id: String,
    parent_span_id: Option<String>,
    name: String,
    start_time_unix_nano: Option<i64>,
    end_time_unix_nano: Option<i64>,
    duration_ms: Option<f64>,
    status_code: Option<String>,
    status_message: Option<String>,
    session_id: Option<String>,
    backend: Option<String>,
    error_message: Option<String>,
    attributes: Value,
    raw: Value,
    observed_at: DateTime<Utc>,
}

fn extract_spans(payload: &Value) -> Vec<SpanRecordForInsert> {
    let mut spans = Vec::new();
    for resource_span in array_field(payload, "resourceSpans") {
        let resource_attrs = attributes_map(resource_span.pointer("/resource/attributes"));
        for scope_span in array_field(resource_span, "scopeSpans") {
            for span in array_field(scope_span, "spans") {
                let Some(trace_id) = string_field(span, "traceId") else {
                    continue;
                };
                let Some(span_id) = string_field(span, "spanId") else {
                    continue;
                };
                let name = string_field(span, "name").unwrap_or_else(|| "span".to_string());
                let mut attrs = resource_attrs.clone();
                attrs.extend(attributes_map(span.get("attributes")));
                let attributes = Value::Object(attrs.clone());
                let status_code = span
                    .pointer("/status/code")
                    .and_then(status_code_string)
                    .map(normalize_status_code);
                let status_message = span
                    .pointer("/status/message")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let start_time_unix_nano = i64_string_or_number(span.get("startTimeUnixNano"));
                let end_time_unix_nano = i64_string_or_number(span.get("endTimeUnixNano"));
                let duration_ms = start_time_unix_nano
                    .zip(end_time_unix_nano)
                    .map(|(start, end)| ((end - start).max(0) as f64) / 1_000_000.0);
                let error_message = error_message_from_attrs(&attrs).or_else(|| {
                    status_message
                        .clone()
                        .filter(|_| status_code.as_deref() == Some("ERROR"))
                });
                spans.push(SpanRecordForInsert {
                    trace_id,
                    span_id,
                    parent_span_id: string_field(span, "parentSpanId"),
                    name,
                    start_time_unix_nano,
                    end_time_unix_nano,
                    duration_ms,
                    status_code,
                    status_message,
                    session_id: attr_string(
                        &attrs,
                        &["session.id", "session_id", "vela.session_id"],
                    ),
                    backend: attr_string(&attrs, &["backend", "backend.kind", "vela.backend"]),
                    error_message,
                    attributes,
                    raw: span.clone(),
                    observed_at: Utc::now(),
                });
            }
        }
    }
    spans
}

fn extract_logs(payload: &Value) -> Vec<LogRecord> {
    let mut logs = Vec::new();
    for resource_log in array_field(payload, "resourceLogs") {
        let resource_attrs = attributes_map(resource_log.pointer("/resource/attributes"));
        for scope_log in array_field(resource_log, "scopeLogs") {
            for log in array_field(scope_log, "logRecords") {
                let mut attrs = resource_attrs.clone();
                attrs.extend(attributes_map(log.get("attributes")));
                let body = log
                    .get("body")
                    .and_then(otlp_value_to_json)
                    .map(|value| json_value_text(&value));
                let severity = string_field(log, "severityText").or_else(|| {
                    log.get("severityNumber")
                        .and_then(i64_from_value)
                        .map(|number| severity_from_number(number).to_string())
                });
                let error_message = error_message_from_attrs(&attrs).or_else(|| {
                    body.clone()
                        .filter(|_| matches!(severity.as_deref(), Some("ERROR" | "FATAL")))
                });
                logs.push(LogRecord {
                    trace_id: string_field(log, "traceId"),
                    span_id: string_field(log, "spanId"),
                    severity,
                    body,
                    session_id: attr_string(
                        &attrs,
                        &["session.id", "session_id", "vela.session_id"],
                    ),
                    backend: attr_string(&attrs, &["backend", "backend.kind", "vela.backend"]),
                    error_message,
                    attributes: Value::Object(attrs),
                    raw: log.clone(),
                });
            }
        }
    }
    logs
}

fn attributes_map(value: Option<&Value>) -> Map<String, Value> {
    let mut attrs = Map::new();
    let Some(values) = value.and_then(Value::as_array) else {
        return attrs;
    };
    for attr in values {
        let Some(key) = string_field(attr, "key") else {
            continue;
        };
        let Some(value) = attr.get("value").and_then(otlp_value_to_json) else {
            continue;
        };
        attrs.insert(key, value);
    }
    attrs
}

fn otlp_value_to_json(value: &Value) -> Option<Value> {
    if let Some(value) = value.get("stringValue").and_then(Value::as_str) {
        return Some(Value::String(value.to_string()));
    }
    if let Some(value) = value.get("intValue").and_then(i64_from_value) {
        return Some(json!(value));
    }
    if let Some(value) = value.get("doubleValue").and_then(Value::as_f64) {
        return Some(json!(value));
    }
    if let Some(value) = value.get("boolValue").and_then(Value::as_bool) {
        return Some(json!(value));
    }
    if let Some(array) = value
        .pointer("/arrayValue/values")
        .and_then(Value::as_array)
    {
        return Some(Value::Array(
            array.iter().filter_map(otlp_value_to_json).collect(),
        ));
    }
    value.get("kvlistValue").cloned()
}

fn array_field<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn i64_string_or_number(value: Option<&Value>) -> Option<i64> {
    value.and_then(i64_from_value)
}

fn i64_from_value(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64(),
        Value::String(value) => value.parse::<i64>().ok(),
        _ => None,
    }
}

fn status_code_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.to_string()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn normalize_status_code(value: String) -> String {
    match value.as_str() {
        "2" | "STATUS_CODE_ERROR" => "ERROR".to_string(),
        "1" | "STATUS_CODE_OK" => "OK".to_string(),
        "0" | "STATUS_CODE_UNSET" => "UNSET".to_string(),
        value => value.to_string(),
    }
}

fn error_message_from_attrs(attrs: &Map<String, Value>) -> Option<String> {
    attr_string(
        attrs,
        &[
            "exception.message",
            "error.message",
            "error",
            "vela.error.message",
        ],
    )
}

fn attr_string(attrs: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = attrs.get(*key).map(json_value_text) {
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn json_value_text(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

fn severity_from_number(number: i64) -> &'static str {
    match number {
        21..=24 => "FATAL",
        17..=20 => "ERROR",
        13..=16 => "WARN",
        9..=12 => "INFO",
        5..=8 => "DEBUG",
        1..=4 => "TRACE",
        _ => "UNSPECIFIED",
    }
}

fn span_from_row(row: sqlx::sqlite::SqliteRow) -> Result<SpanRecord> {
    let attributes_json: String = row.try_get("attributes_json")?;
    let observed_at: String = row.try_get("observed_at")?;
    Ok(SpanRecord {
        trace_id: row.try_get("trace_id")?,
        span_id: row.try_get("span_id")?,
        parent_span_id: row.try_get("parent_span_id")?,
        name: row.try_get("name")?,
        start_time_unix_nano: row.try_get("start_time_unix_nano")?,
        end_time_unix_nano: row.try_get("end_time_unix_nano")?,
        duration_ms: row.try_get("duration_ms")?,
        status_code: row.try_get("status_code")?,
        status_message: row.try_get("status_message")?,
        session_id: row.try_get("session_id")?,
        backend: row.try_get("backend")?,
        error_message: row.try_get("error_message")?,
        attributes: serde_json::from_str(&attributes_json)?,
        observed_at: parse_rfc3339_utc(&observed_at),
    })
}

fn error_from_row(row: sqlx::sqlite::SqliteRow) -> Result<ErrorRecord> {
    let observed_at: String = row.try_get("observed_at")?;
    Ok(ErrorRecord {
        source: row.try_get("source")?,
        trace_id: row.try_get("trace_id")?,
        span_id: row.try_get("span_id")?,
        name: row.try_get("name")?,
        message: row.try_get("message")?,
        session_id: row.try_get("session_id")?,
        backend: row.try_get("backend")?,
        observed_at: parse_rfc3339_utc(&observed_at),
    })
}

fn parse_rfc3339_utc(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

async fn count_table(pool: &SqlitePool, table: &str) -> Result<i64> {
    let row = sqlx::query(&format!("SELECT COUNT(*) AS count FROM {table}"))
        .fetch_one(pool)
        .await?;
    Ok(row.try_get("count")?)
}

fn raw_dir_for_database_url(database_url: &str) -> Option<PathBuf> {
    if database_url == "sqlite::memory:" {
        return None;
    }
    let without_query = database_url.split('?').next().unwrap_or(database_url);
    let encoded_path = without_query
        .strip_prefix("sqlite://")
        .or_else(|| without_query.strip_prefix("sqlite:"))?;
    if encoded_path == ":memory:" || encoded_path.is_empty() {
        return None;
    }
    let path = percent_decode_path(encoded_path);
    let path = PathBuf::from(path);
    path.parent().map(|parent| parent.join("observability"))
}

fn percent_decode_path(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut changed = false;
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_nibble(bytes[index + 1]), hex_nibble(bytes[index + 2]))
            {
                decoded.push((high << 4) | low);
                changed = true;
                index += 3;
                continue;
            }
        }

        decoded.push(bytes[index]);
        index += 1;
    }

    if changed {
        String::from_utf8(decoded).unwrap_or_else(|_| path.to_string())
    } else {
        path.to_string()
    }
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn new_span_id() -> String {
    uuid::Uuid::new_v4()
        .as_simple()
        .to_string()
        .chars()
        .take(16)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn ingests_otlp_json_trace_into_query_index() {
        let dir = tempdir().expect("tempdir");
        let db = format!(
            "sqlite://{}?mode=rwc",
            dir.path().join("vela.sqlite").display()
        );
        let raw = dir.path().join("observability");
        let store = ObservabilityStore::connect(&db, Some(&raw))
            .await
            .expect("store");

        let summary = store
            .ingest_traces(sample_trace_payload())
            .await
            .expect("ingest");
        assert_eq!(summary.spans, 1);

        let trace = store
            .trace_detail("4bf92f3577b34da6a3ce929d0e0e4736")
            .await
            .expect("trace")
            .expect("trace exists");
        assert_eq!(trace.spans[0].name, "codex.thread_start");
        assert_eq!(trace.spans[0].backend.as_deref(), Some("codex"));
        assert_eq!(trace.spans[0].session_id.as_deref(), Some("ses_1"));
        assert_eq!(
            trace.spans[0].error_message.as_deref(),
            Some("failed to fetch")
        );

        let errors = store.recent_errors(10).await.expect("errors");
        assert_eq!(errors[0].message, "failed to fetch");
        assert!(raw.join("traces.jsonl").exists());
    }

    #[tokio::test]
    async fn ingests_otlp_json_error_log() {
        let store = ObservabilityStore::connect("sqlite::memory:", None)
            .await
            .expect("store");
        let summary = store
            .ingest_logs(sample_log_payload())
            .await
            .expect("ingest");
        assert_eq!(summary.logs, 1);

        let errors = store.recent_errors(10).await.expect("errors");
        assert_eq!(errors[0].source, "log");
        assert_eq!(errors[0].message, "Codex app-server thread/start failed");
    }

    #[tokio::test]
    async fn tracing_layer_records_error_event_as_local_log() {
        use tracing_subscriber::prelude::*;

        let store = ObservabilityStore::connect("sqlite::memory:", None)
            .await
            .expect("store");
        let subscriber = tracing_subscriber::registry().with(tracing_log_layer(store.clone()));

        tracing::subscriber::with_default(subscriber, || {
            tracing::error!(
                backend = "codex",
                session_id = "ses_1",
                "Codex app-server thread/start failed"
            );
        });

        let errors = wait_for_recent_errors(&store).await;
        assert_eq!(errors[0].source, "log");
        assert_eq!(errors[0].backend.as_deref(), Some("codex"));
        assert_eq!(errors[0].session_id.as_deref(), Some("ses_1"));
        assert_eq!(errors[0].message, "Codex app-server thread/start failed");
    }

    #[tokio::test]
    async fn rotates_raw_jsonl_when_next_append_exceeds_limit() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("traces.jsonl");
        fs::write(&path, "1234567890").await.expect("seed");

        rotate_jsonl_if_needed(&path, 1, 10).await.expect("rotate");

        assert!(!path.exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("traces.jsonl.1"))
                .await
                .expect("rotated"),
            "1234567890"
        );
    }

    #[tokio::test]
    async fn connect_for_database_url_decodes_file_url_path_for_raw_jsonl() {
        let dir = tempdir().expect("tempdir");
        let data_dir = dir
            .path()
            .join("Application Support")
            .join("@vela")
            .join("desktop-electron")
            .join("runtime")
            .join("velad");
        fs::create_dir_all(&data_dir).await.expect("data dir");
        let db_path = data_dir.join("vela.sqlite");
        let encoded_db_path = db_path.display().to_string().replace(' ', "%20");
        let db_url = format!("sqlite://{encoded_db_path}?mode=rwc");

        let store = ObservabilityStore::connect_for_database_url(&db_url)
            .await
            .expect("store");
        store
            .ingest_traces(sample_trace_payload())
            .await
            .expect("ingest");

        assert!(data_dir.join("observability").join("traces.jsonl").exists());
        let expected_raw_dir = data_dir.join("observability").display().to_string();
        assert_eq!(
            store.status().await.expect("status").raw_dir.as_deref(),
            Some(expected_raw_dir.as_str())
        );
        assert!(!dir.path().join("Application%20Support").exists());
    }

    #[test]
    fn raw_dir_for_database_url_decodes_percent_encoded_path_segments() {
        assert_eq!(
            raw_dir_for_database_url(
                "sqlite:///Users/skipzhang/Library/Application%20Support/%E4%B8%AD/vela.sqlite?mode=rwc"
            )
            .expect("raw dir"),
            PathBuf::from("/Users/skipzhang/Library/Application Support/中/observability")
        );
    }

    #[test]
    fn parses_w3c_traceparent() {
        let trace = parse_traceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
            .expect("traceparent");

        assert_eq!(trace.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
        assert_eq!(trace.span_id, "00f067aa0ba902b7");
        assert_eq!(trace.trace_flags, "01");
        assert!(
            parse_traceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01").is_none()
        );
    }

    fn sample_trace_payload() -> Value {
        json!({
            "resourceSpans": [{
                "resource": {
                    "attributes": [
                        {"key": "service.name", "value": {"stringValue": "vela-desktop"}},
                        {"key": "backend", "value": {"stringValue": "codex"}}
                    ]
                },
                "scopeSpans": [{
                    "spans": [{
                        "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                        "spanId": "00f067aa0ba902b7",
                        "name": "codex.thread_start",
                        "startTimeUnixNano": "1544712660000000000",
                        "endTimeUnixNano": "1544712661000000000",
                        "status": {
                            "code": "STATUS_CODE_ERROR",
                            "message": "failed to fetch"
                        },
                        "attributes": [
                            {"key": "session.id", "value": {"stringValue": "ses_1"}}
                        ]
                    }]
                }]
            }]
        })
    }

    fn sample_log_payload() -> Value {
        json!({
            "resourceLogs": [{
                "scopeLogs": [{
                    "logRecords": [{
                        "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                        "spanId": "00f067aa0ba902b7",
                        "severityText": "ERROR",
                        "body": {"stringValue": "Codex app-server thread/start failed"},
                        "attributes": [
                            {"key": "backend", "value": {"stringValue": "codex"}}
                        ]
                    }]
                }]
            }]
        })
    }

    async fn wait_for_recent_errors(store: &ObservabilityStore) -> Vec<ErrorRecord> {
        for _ in 0..50 {
            let errors = store.recent_errors(10).await.expect("errors");
            if !errors.is_empty() {
                return errors;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        store.recent_errors(10).await.expect("errors")
    }
}
