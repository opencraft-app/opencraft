use serde_json::Value;
use sqlx::{Row, SqlitePool, sqlite::SqlitePoolOptions};
use thiserror::Error;
use vela_core::{
    AcceptedCommandAck, BackendKind, CanonicalEvent, CommandAck, CommandId, EventCursor,
    EventSource, EventType, SessionId,
};

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sql error: {0}")]
    Sql(#[from] sqlx::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("session not found: {0}")]
    SessionNotFound(String),
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
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
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
            "#,
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn create_session(
        &self,
        session_id: &SessionId,
        backend: BackendKind,
        working_directory: &str,
    ) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO sessions (session_id, backend, status, working_directory)
            VALUES (?1, ?2, 'idle', ?3)
            "#,
        )
        .bind(session_id.as_str())
        .bind(backend.as_str())
        .bind(working_directory)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn session_exists(&self, session_id: &SessionId) -> Result<bool> {
        let row = sqlx::query("SELECT 1 FROM sessions WHERE session_id = ?1")
            .bind(session_id.as_str())
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.is_some())
    }

    pub async fn append_event(
        &self,
        session_id: &SessionId,
        event_type: EventType,
        source: EventSource,
        payload: Value,
        raw: Option<Value>,
    ) -> Result<AppendResult> {
        let mut tx = self.pool.begin().await?;
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
        let mut tx = self.pool.begin().await?;

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
        let ack = CommandAck::Accepted(AcceptedCommandAck {
            command_id: command_id.unwrap_or_default(),
            session_id: session_id.clone(),
            cursor: event.cursor(),
            turn_id: None,
        });
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
