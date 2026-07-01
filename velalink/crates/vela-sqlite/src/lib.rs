use std::{str::FromStr, time::Duration};

use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};

const LOCAL_BUSY_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn connect_local_sqlite_pool(database_url: &str) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(LOCAL_BUSY_TIMEOUT);

    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
}
