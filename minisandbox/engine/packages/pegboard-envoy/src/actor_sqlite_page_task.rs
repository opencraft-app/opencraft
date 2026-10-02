use anyhow::Result;
use gas::prelude::*;
use rivet_envoy_protocol as protocol;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::Instrument;
use xxhash_rust::xxh3::xxh3_128;

use crate::{
	conn::Conn,
	ws_to_tunnel_task::{self, TASK_IDLE_TIMEOUT, TaskExit},
};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct Key {
	actor_id: String,
	generation: u64,
}

impl Key {
	pub(super) fn new(actor_id: String, generation: u64) -> Self {
		Self {
			actor_id,
			generation,
		}
	}
}

fn sqlite_commit_attempt_id(
	session_id: [u8; 16],
	request_id: u32,
	generation: u64,
	actor_id: &str,
) -> [u8; 16] {
	let mut material = Vec::with_capacity(16 + 4 + 8 + actor_id.len());
	material.extend_from_slice(&session_id);
	material.extend_from_slice(&request_id.to_be_bytes());
	material.extend_from_slice(&generation.to_be_bytes());
	material.extend_from_slice(actor_id.as_bytes());
	xxh3_128(&material).to_be_bytes()
}

#[derive(Debug)]
pub(super) enum Message {
	GetPages(protocol::ToRivetSqliteGetPagesRequest),
	Commit(protocol::ToRivetSqliteCommitRequest),
}

pub(super) async fn task(
	ctx: StandaloneCtx,
	conn: Arc<Conn>,
	key: Key,
	mut rx: mpsc::UnboundedReceiver<Message>,
) -> Result<TaskExit> {
	loop {
		match tokio::time::timeout(TASK_IDLE_TIMEOUT, rx.recv()).await {
			Ok(Some(Message::GetPages(req))) => {
				let response =
					ws_to_tunnel_task::handle_sqlite_get_pages_response(&ctx, &conn, req.data)
						.await;
				ws_to_tunnel_task::send_sqlite_get_pages_response(&conn, req.request_id, response)
					.await?;
			}
			Ok(Some(Message::Commit(req))) => {
				let actor_id = req.data.actor_id.clone();
				let request_id = req.request_id;
				let commit_attempt_id = sqlite_commit_attempt_id(
					conn.sqlite_commit_session_id,
					request_id,
					key.generation,
					&actor_id,
				);
				let timed_response = async {
					ws_to_tunnel_task::handle_sqlite_commit_response(
						&ctx,
						&conn,
						req.data,
						commit_attempt_id,
					)
					.await
				}
				.instrument(tracing::debug_span!(
					"handle_sqlite_commit",
					actor_id = %actor_id,
					request_id = ?request_id
				))
				.await;
				ws_to_tunnel_task::send_sqlite_commit_response(
					&conn,
					request_id,
					timed_response.response,
				)
				.await?;
				crate::metrics::SQLITE_COMMIT_ENVOY_RESPONSE_DURATION
					.with_label_values(&[
						conn.namespace_id.to_string().as_str(),
						conn.pool_name.as_str(),
					])
					.observe(timed_response.commit_completed_at.elapsed().as_secs_f64());
			}
			Ok(None) | Err(_) => return Ok(TaskExit::SqlitePage(key)),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::sqlite_commit_attempt_id;

	#[test]
	fn commit_attempt_id_is_stable_and_scoped_to_delivery_identity() {
		let session = [0xa5; 16];
		let baseline = sqlite_commit_attempt_id(session, 7, 11, "actor-a");

		assert_eq!(
			baseline,
			sqlite_commit_attempt_id(session, 7, 11, "actor-a")
		);
		assert_ne!(
			baseline,
			sqlite_commit_attempt_id([0x5a; 16], 7, 11, "actor-a")
		);
		assert_ne!(
			baseline,
			sqlite_commit_attempt_id(session, 8, 11, "actor-a")
		);
		assert_ne!(
			baseline,
			sqlite_commit_attempt_id(session, 7, 12, "actor-a")
		);
		assert_ne!(
			baseline,
			sqlite_commit_attempt_id(session, 7, 11, "actor-b")
		);
	}
}
