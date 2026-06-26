use chrono::{DateTime, NaiveDateTime, Utc};
use serde_json::Value;
use sqlx::{Row, SqlitePool};
use thiserror::Error;
use vela_core::{
    AcceptedCommandAck, AgentConfig, BackendKind, CanonicalEvent, CommandAck, CommandId,
    EventCursor, EventSource, EventType, QueuedCommandAck, SessionId,
};
use vela_sqlite::connect_local_sqlite_pool;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sql error: {0}")]
    Sql(#[from] sqlx::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("session not found: {0}")]
    SessionNotFound(String),
    #[error("backend settings not found: {0}")]
    BackendSettingsNotFound(String),
    #[error("node not found: {0}")]
    NodeNotFound(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

#[derive(Clone)]
pub struct SqliteEventStore {
    pool: SqlitePool,
}

#[derive(Clone, Debug)]
pub struct AppendResult {
    pub event: CanonicalEvent,
    pub cursor: EventCursor,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StoredSession {
    pub session_id: SessionId,
    pub backend: BackendKind,
    pub status: String,
    pub working_directory: String,
    pub title: String,
    pub model: Option<String>,
    pub agent_config: AgentConfig,
    pub metadata: Value,
    pub epoch: i64,
    pub next_seq: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StoredBackendSettings {
    pub backend: String,
    pub settings: Value,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StoredNode {
    pub node_id: String,
    pub provider: String,
    pub display_name: String,
    pub config: Value,
    pub secret_ref: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub enum IdempotencyAcceptance {
    Fresh(CommandAck),
    Replay(CommandAck),
    HashMismatch,
}

impl IdempotencyAcceptance {
    pub fn is_fresh(&self) -> bool {
        matches!(self, Self::Fresh(_))
    }

    pub fn is_replay(&self) -> bool {
        matches!(self, Self::Replay(_))
    }

    pub fn is_hash_mismatch(&self) -> bool {
        matches!(self, Self::HashMismatch)
    }

    pub fn ack(&self) -> CommandAck {
        match self {
            Self::Fresh(ack) | Self::Replay(ack) => ack.clone(),
            Self::HashMismatch => CommandAck::rejected(
                "duplicate_command",
                "idempotency key was already used for a different command",
            ),
        }
    }
}

impl SqliteEventStore {
    pub async fn in_memory() -> Result<Self> {
        Self::connect("sqlite::memory:").await
    }

    pub async fn connect(database_url: &str) -> Result<Self> {
        let pool = connect_local_sqlite_pool(database_url).await?;
        let store = Self { pool };
        store.migrate().await?;
        Ok(store)
    }

    pub async fn migrate(&self) -> Result<()> {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                backend TEXT NOT NULL,
                status TEXT NOT NULL,
                working_directory TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                model TEXT,
                agent_config_json TEXT NOT NULL DEFAULT '{}',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                epoch INTEGER NOT NULL DEFAULT 1,
                next_seq INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS events (
                event_id TEXT PRIMARY KEY,
                epoch INTEGER NOT NULL,
                seq INTEGER NOT NULL,
                session_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                created_at TEXT NOT NULL,
                affected_views_json TEXT NOT NULL,
                source_json TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                raw_json TEXT,
                UNIQUE(session_id, epoch, seq)
            );

            CREATE TABLE IF NOT EXISTS idempotency_keys (
                session_id TEXT NOT NULL,
                key TEXT NOT NULL,
                command_hash TEXT NOT NULL,
                command_ack_json TEXT NOT NULL,
                first_event_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(session_id, key)
            );

            CREATE TABLE IF NOT EXISTS backend_settings (
                backend TEXT PRIMARY KEY,
                settings_json TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS nodes (
                node_id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                display_name TEXT NOT NULL,
                config_json TEXT NOT NULL DEFAULT '{}',
                secret_ref TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            "#,
        )
        .execute(&self.pool)
        .await?;
        self.ensure_column(
            "sessions",
            "agent_config_json",
            "TEXT NOT NULL DEFAULT '{}'",
        )
        .await?;
        Ok(())
    }

    pub async fn get_backend_settings(
        &self,
        backend: &str,
    ) -> Result<Option<StoredBackendSettings>> {
        let row = sqlx::query(
            r#"
            SELECT backend, settings_json, updated_at
            FROM backend_settings
            WHERE backend = ?1
            "#,
        )
        .bind(backend)
        .fetch_optional(&self.pool)
        .await?;

        row.map(row_to_backend_settings).transpose()
    }

    pub async fn upsert_backend_settings(
        &self,
        backend: &str,
        settings: Value,
    ) -> Result<StoredBackendSettings> {
        sqlx::query(
            r#"
            INSERT INTO backend_settings (backend, settings_json, updated_at)
            VALUES (?1, ?2, CURRENT_TIMESTAMP)
            ON CONFLICT(backend) DO UPDATE SET
                settings_json = excluded.settings_json,
                updated_at = CURRENT_TIMESTAMP
            "#,
        )
        .bind(backend)
        .bind(serde_json::to_string(&settings)?)
        .execute(&self.pool)
        .await?;

        self.get_backend_settings(backend)
            .await?
            .ok_or_else(|| StoreError::BackendSettingsNotFound(backend.to_string()))
    }

    pub async fn create_node(
        &self,
        node_id: &str,
        provider: &str,
        display_name: &str,
        config: Value,
        secret_ref: Option<&str>,
    ) -> Result<StoredNode> {
        sqlx::query(
            r#"
            INSERT INTO nodes (node_id, provider, display_name, config_json, secret_ref)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
        )
        .bind(node_id)
        .bind(provider)
        .bind(display_name)
        .bind(serde_json::to_string(&config)?)
        .bind(secret_ref)
        .execute(&self.pool)
        .await?;

        self.get_node(node_id)
            .await?
            .ok_or_else(|| StoreError::NodeNotFound(node_id.to_string()))
    }

    pub async fn get_node(&self, node_id: &str) -> Result<Option<StoredNode>> {
        let row = sqlx::query(
            r#"
            SELECT node_id, provider, display_name, config_json, secret_ref, created_at, updated_at
            FROM nodes
            WHERE node_id = ?1
            "#,
        )
        .bind(node_id)
        .fetch_optional(&self.pool)
        .await?;

        row.map(row_to_node).transpose()
    }

    pub async fn list_nodes(&self) -> Result<Vec<StoredNode>> {
        let rows = sqlx::query(
            r#"
            SELECT node_id, provider, display_name, config_json, secret_ref, created_at, updated_at
            FROM nodes
            ORDER BY updated_at DESC, node_id ASC
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter().map(row_to_node).collect()
    }

    async fn ensure_column(&self, table: &str, column: &str, definition: &str) -> Result<()> {
        let rows = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(&self.pool)
            .await?;
        let exists = rows.iter().any(|row| {
            row.try_get::<String, _>("name")
                .map(|name| name == column)
                .unwrap_or(false)
        });
        if !exists {
            sqlx::query(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition}"
            ))
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    pub async fn create_session(
        &self,
        session_id: &SessionId,
        backend: BackendKind,
        working_directory: &str,
    ) -> Result<()> {
        self.create_session_with_details(session_id, backend, working_directory, None, None, None)
            .await
    }

    pub async fn create_session_with_details(
        &self,
        session_id: &SessionId,
        backend: BackendKind,
        working_directory: &str,
        title: Option<&str>,
        model: Option<&str>,
        metadata: Option<Value>,
    ) -> Result<()> {
        self.create_session_with_agent_config(
            session_id,
            backend,
            working_directory,
            title,
            AgentConfig::with_model(model),
            metadata,
        )
        .await
    }

    pub async fn create_session_with_agent_config(
        &self,
        session_id: &SessionId,
        backend: BackendKind,
        working_directory: &str,
        title: Option<&str>,
        agent_config: AgentConfig,
        metadata: Option<Value>,
    ) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO sessions (session_id, backend, status, working_directory, title, model, agent_config_json, metadata_json)
            VALUES (?1, ?2, 'idle', ?3, ?4, ?5, ?6, ?7)
            "#,
        )
        .bind(session_id.as_str())
        .bind(backend.as_str())
        .bind(working_directory)
        .bind(title.unwrap_or(session_id.as_str()))
        .bind(agent_config.model.as_deref())
        .bind(serde_json::to_string(&agent_config)?)
        .bind(serde_json::to_string(
            &metadata.unwrap_or_else(|| serde_json::json!({})),
        )?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_session(&self, session_id: &SessionId) -> Result<Option<StoredSession>> {
        let row = sqlx::query(
            r#"
            SELECT session_id, backend, status, working_directory, title, model, agent_config_json, metadata_json, epoch, next_seq, created_at, updated_at
            FROM sessions
            WHERE session_id = ?1
            "#,
        )
        .bind(session_id.as_str())
        .fetch_optional(&self.pool)
        .await?;

        row.map(row_to_session).transpose()
    }

    pub async fn list_sessions(&self) -> Result<Vec<StoredSession>> {
        let rows = sqlx::query(
            r#"
            SELECT session_id, backend, status, working_directory, title, model, agent_config_json, metadata_json, epoch, next_seq, created_at, updated_at
            FROM sessions
            WHERE status != 'archived'
            ORDER BY updated_at DESC, session_id ASC
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter().map(row_to_session).collect()
    }

    pub async fn archive_session(&self, session_id: &SessionId) -> Result<()> {
        let result = sqlx::query(
            "UPDATE sessions SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE session_id = ?1",
        )
        .bind(session_id.as_str())
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StoreError::SessionNotFound(session_id.to_string()));
        }
        Ok(())
    }

    pub async fn session_exists(&self, session_id: &SessionId) -> Result<bool> {
        let row = sqlx::query("SELECT 1 FROM sessions WHERE session_id = ?1")
            .bind(session_id.as_str())
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.is_some())
    }

    pub async fn update_session_status(&self, session_id: &SessionId, status: &str) -> Result<()> {
        sqlx::query(
            "UPDATE sessions SET status = ?2, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?1",
        )
        .bind(session_id.as_str())
        .bind(status)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn update_session_agent_config(
        &self,
        session_id: &SessionId,
        agent_config: &AgentConfig,
    ) -> Result<()> {
        let result = sqlx::query(
            r#"
            UPDATE sessions
            SET model = ?2, agent_config_json = ?3, updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ?1
            "#,
        )
        .bind(session_id.as_str())
        .bind(agent_config.model.as_deref())
        .bind(serde_json::to_string(agent_config)?)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StoreError::SessionNotFound(session_id.to_string()));
        }
        Ok(())
    }

    pub async fn append_event(
        &self,
        session_id: &SessionId,
        event_type: EventType,
        source: EventSource,
        payload: Value,
        raw: Option<Value>,
    ) -> Result<AppendResult> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let event = self
            .append_event_tx(&mut tx, session_id, event_type, source, payload, raw)
            .await?;
        tx.commit().await?;
        Ok(AppendResult {
            cursor: event.cursor(),
            event,
        })
    }

    pub async fn record_idempotency_acceptance(
        &self,
        session_id: &SessionId,
        key: &str,
        command_hash: &str,
        command_id: Option<CommandId>,
        event_type: EventType,
        source: EventSource,
        payload: Value,
    ) -> Result<IdempotencyAcceptance> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;

        if let Some(row) =
            sqlx::query("SELECT command_hash, command_ack_json FROM idempotency_keys WHERE session_id = ?1 AND key = ?2")
                .bind(session_id.as_str())
                .bind(key)
                .fetch_optional(&mut *tx)
                .await?
        {
            let existing_hash: String = row.try_get("command_hash")?;
            if existing_hash != command_hash {
                tx.commit().await?;
                return Ok(IdempotencyAcceptance::HashMismatch);
            }
            let ack_json: String = row.try_get("command_ack_json")?;
            let ack = serde_json::from_str(&ack_json)?;
            tx.commit().await?;
            return Ok(IdempotencyAcceptance::Replay(ack));
        }

        let event = self
            .append_event_tx(&mut tx, session_id, event_type, source, payload, None)
            .await?;
        let ack = if event_type == EventType::INPUT_QUEUED {
            CommandAck::Queued(QueuedCommandAck {
                command_id: command_id.unwrap_or_default(),
                session_id: session_id.clone(),
                queued_message_id: event
                    .payload
                    .get("queued_message_id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| event.event_id.to_string()),
                cursor: event.cursor(),
            })
        } else {
            CommandAck::Accepted(AcceptedCommandAck {
                command_id: command_id.unwrap_or_default(),
                session_id: session_id.clone(),
                cursor: event.cursor(),
                turn_id: None,
            })
        };
        let ack_json = serde_json::to_string(&ack)?;
        sqlx::query(
            r#"
            INSERT INTO idempotency_keys (session_id, key, command_hash, command_ack_json, first_event_id)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
        )
        .bind(session_id.as_str())
        .bind(key)
        .bind(command_hash)
        .bind(ack_json)
        .bind(event.event_id.as_str())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(IdempotencyAcceptance::Fresh(ack))
    }

    pub async fn resolve_idempotency(
        &self,
        session_id: &SessionId,
        key: &str,
        command_hash: &str,
    ) -> Result<Option<IdempotencyAcceptance>> {
        let Some(row) =
            sqlx::query("SELECT command_hash, command_ack_json FROM idempotency_keys WHERE session_id = ?1 AND key = ?2")
                .bind(session_id.as_str())
                .bind(key)
                .fetch_optional(&self.pool)
                .await?
        else {
            return Ok(None);
        };

        let existing_hash: String = row.try_get("command_hash")?;
        if existing_hash != command_hash {
            return Ok(Some(IdempotencyAcceptance::HashMismatch));
        }
        let ack_json: String = row.try_get("command_ack_json")?;
        let ack = serde_json::from_str(&ack_json)?;
        Ok(Some(IdempotencyAcceptance::Replay(ack)))
    }

    pub async fn list_events(&self, session_id: &SessionId) -> Result<Vec<CanonicalEvent>> {
        let rows = sqlx::query(
            r#"
            SELECT event_id, epoch, seq, session_id, thread_id, event_type, created_at,
                   affected_views_json, source_json, payload_json, raw_json
            FROM events
            WHERE session_id = ?1
            ORDER BY epoch, seq
            "#,
        )
        .bind(session_id.as_str())
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter().map(row_to_event).collect()
    }

    async fn append_event_tx(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        session_id: &SessionId,
        event_type: EventType,
        source: EventSource,
        payload: Value,
        raw: Option<Value>,
    ) -> Result<CanonicalEvent> {
        let row = sqlx::query("SELECT epoch, next_seq FROM sessions WHERE session_id = ?1")
            .bind(session_id.as_str())
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| StoreError::SessionNotFound(session_id.to_string()))?;
        let epoch: i64 = row.try_get("epoch")?;
        let seq: i64 = row.try_get("next_seq")?;

        sqlx::query(
            "UPDATE sessions SET next_seq = next_seq + 1, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?1",
        )
        .bind(session_id.as_str())
        .execute(&mut **tx)
        .await?;

        let event = CanonicalEvent::new(session_id.clone(), event_type, source, payload)
            .with_cursor(epoch, seq);
        sqlx::query(
            r#"
            INSERT INTO events (
                event_id, epoch, seq, session_id, thread_id, event_type, created_at,
                affected_views_json, source_json, payload_json, raw_json
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            "#,
        )
        .bind(event.event_id.as_str())
        .bind(event.epoch)
        .bind(event.seq)
        .bind(event.session_id.as_str())
        .bind(event.thread_id.as_str())
        .bind(event.event_type.0)
        .bind(event.created_at.to_rfc3339())
        .bind(serde_json::to_string(&event.affected_views)?)
        .bind(serde_json::to_string(&event.source)?)
        .bind(serde_json::to_string(&event.payload)?)
        .bind(match &raw {
            Some(value) => Some(serde_json::to_string(value)?),
            None => None,
        })
        .execute(&mut **tx)
        .await?;

        Ok(match raw {
            Some(raw) => event.with_raw(raw),
            None => event,
        })
    }
}

fn row_to_event(row: sqlx::sqlite::SqliteRow) -> Result<CanonicalEvent> {
    let created_at: String = row.try_get("created_at")?;
    let raw_json: Option<String> = row.try_get("raw_json")?;
    Ok(CanonicalEvent {
        event_id: row.try_get::<String, _>("event_id")?.into(),
        epoch: row.try_get("epoch")?,
        seq: row.try_get("seq")?,
        session_id: row.try_get::<String, _>("session_id")?.into(),
        thread_id: row.try_get::<String, _>("thread_id")?.into(),
        event_type: EventType(Box::leak(
            row.try_get::<String, _>("event_type")?.into_boxed_str(),
        )),
        created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now()),
        affected_views: serde_json::from_str(&row.try_get::<String, _>("affected_views_json")?)?,
        source: serde_json::from_str(&row.try_get::<String, _>("source_json")?)?,
        payload: serde_json::from_str(&row.try_get::<String, _>("payload_json")?)?,
        raw: raw_json
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
    })
}

fn row_to_session(row: sqlx::sqlite::SqliteRow) -> Result<StoredSession> {
    let backend = match row.try_get::<String, _>("backend")?.as_str() {
        "pi" => BackendKind::Pi,
        "vela_engine" => BackendKind::VelaEngine,
        "codex" => BackendKind::Codex,
        "claude" => BackendKind::Claude,
        "acp" => BackendKind::Acp,
        _ => BackendKind::Pi,
    };
    let created_at = parse_sqlite_datetime(row.try_get("created_at")?);
    let updated_at = parse_sqlite_datetime(row.try_get("updated_at")?);

    Ok(StoredSession {
        session_id: row.try_get::<String, _>("session_id")?.into(),
        backend,
        status: row.try_get("status")?,
        working_directory: row.try_get("working_directory")?,
        title: row.try_get("title")?,
        model: row.try_get("model")?,
        agent_config: row_to_agent_config(&row)?,
        metadata: serde_json::from_str(&row.try_get::<String, _>("metadata_json")?)?,
        epoch: row.try_get("epoch")?,
        next_seq: row.try_get("next_seq")?,
        created_at,
        updated_at,
    })
}

fn row_to_backend_settings(row: sqlx::sqlite::SqliteRow) -> Result<StoredBackendSettings> {
    Ok(StoredBackendSettings {
        backend: row.try_get("backend")?,
        settings: serde_json::from_str(&row.try_get::<String, _>("settings_json")?)?,
        updated_at: parse_sqlite_datetime(row.try_get("updated_at")?),
    })
}

fn row_to_node(row: sqlx::sqlite::SqliteRow) -> Result<StoredNode> {
    Ok(StoredNode {
        node_id: row.try_get("node_id")?,
        provider: row.try_get("provider")?,
        display_name: row.try_get("display_name")?,
        config: serde_json::from_str(&row.try_get::<String, _>("config_json")?)?,
        secret_ref: row.try_get("secret_ref")?,
        created_at: parse_sqlite_datetime(row.try_get("created_at")?),
        updated_at: parse_sqlite_datetime(row.try_get("updated_at")?),
    })
}

fn row_to_agent_config(row: &sqlx::sqlite::SqliteRow) -> Result<AgentConfig> {
    let model: Option<String> = row.try_get("model")?;
    let mut agent_config: AgentConfig =
        serde_json::from_str(&row.try_get::<String, _>("agent_config_json")?)?;
    if agent_config.model.is_none() {
        agent_config.model = model;
    }
    Ok(agent_config)
}

fn parse_sqlite_datetime(value: String) -> DateTime<Utc> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(&value) {
        return dt.with_timezone(&Utc);
    }
    if let Ok(dt) = NaiveDateTime::parse_from_str(&value, "%Y-%m-%d %H:%M:%S") {
        return DateTime::from_naive_utc_and_offset(dt, Utc);
    }
    Utc::now()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::{
        env,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };

    static TEST_DB_COUNTER: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn parses_sqlite_current_timestamp_as_utc() {
        let parsed = parse_sqlite_datetime("2026-06-18 10:00:06".to_string());

        assert_eq!(parsed, Utc.with_ymd_and_hms(2026, 6, 18, 10, 0, 6).unwrap());
    }

    #[test]
    fn parses_rfc3339_timestamp_as_utc() {
        let parsed = parse_sqlite_datetime("2026-06-18T10:00:06.123456+00:00".to_string());
        let expected = DateTime::parse_from_rfc3339("2026-06-18T10:00:06.123456+00:00")
            .unwrap()
            .with_timezone(&Utc);

        assert_eq!(parsed, expected);
    }

    #[tokio::test]
    async fn file_store_waits_for_transient_sqlite_writer_lock() {
        let (db_url, db_path) = temp_sqlite_url("vela-store-lock");
        let store = SqliteEventStore::connect(&db_url).await.expect("store");
        let session_id = SessionId::from("ses_store_lock");
        store
            .create_session(&session_id, BackendKind::Pi, "/tmp/vela")
            .await
            .expect("create session");

        let lock_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&db_url)
            .await
            .expect("lock pool");
        let mut lock = lock_pool.acquire().await.expect("lock connection");
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *lock)
            .await
            .expect("hold sqlite writer lock");

        let append = {
            let store = store.clone();
            let session_id = session_id.clone();
            tokio::spawn(async move {
                store
                    .append_event(
                        &session_id,
                        EventType::USER_MESSAGE_ACCEPTED,
                        EventSource::runtime("test"),
                        json!({ "content": "hello" }),
                        None,
                    )
                    .await
            })
        };

        tokio::time::sleep(Duration::from_millis(100)).await;
        sqlx::query("COMMIT")
            .execute(&mut *lock)
            .await
            .expect("release sqlite writer lock");

        let result = tokio::time::timeout(Duration::from_secs(2), append)
            .await
            .expect("append did not wait forever")
            .expect("append task");
        result.expect("append should wait for sqlite writer lock");

        let _ = std::fs::remove_file(db_path);
    }

    fn temp_sqlite_url(prefix: &str) -> (String, PathBuf) {
        let path = env::temp_dir().join(format!(
            "{prefix}-{}-{}.sqlite",
            std::process::id(),
            TEST_DB_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_file(&path);
        (format!("sqlite://{}?mode=rwc", path.display()), path)
    }
}
