use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use rivet_envoy_client::config::{
	BoxFuture, EnvoyCallbacks, HttpRequest, HttpResponse, WebSocketHandler,
};
use rivet_envoy_client::handle::EnvoyHandle;
use rivet_envoy_protocol as protocol;

const COUNTER_ACTOR_NAME: &str = "counter";
const COUNTER_CREATE_SQL: &str =
	"CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)";
const COUNTER_READ_SQL: &str = "SELECT value FROM counter WHERE id = 1";
const COUNTER_INCREMENT_SQL: &str = "INSERT INTO counter (id, value) VALUES (1, 1) \
	ON CONFLICT(id) DO UPDATE SET value = counter.value + 1 RETURNING value";

/// Default test callbacks that handle HTTP ping and WebSocket echo.
#[derive(Default)]
pub struct DefaultTestCallbacks {
	pub is_shutdown: Arc<AtomicBool>,
}

impl EnvoyCallbacks for DefaultTestCallbacks {
	fn on_actor_start(
		&self,
		handle: EnvoyHandle,
		actor_id: String,
		generation: u32,
		config: protocol::ActorConfig,
		_preloaded_kv: Option<protocol::PreloadedKv>,
	) -> BoxFuture<anyhow::Result<()>> {
		Box::pin(async move {
			if config.name == COUNTER_ACTOR_NAME {
				execute_counter_sql(&handle, &actor_id, generation, COUNTER_CREATE_SQL).await?;
			}
			tracing::info!(%actor_id, generation, "actor started");
			Ok(())
		})
	}

	fn on_actor_stop(
		&self,
		_handle: EnvoyHandle,
		actor_id: String,
		generation: u32,
		reason: protocol::StopActorReason,
	) -> BoxFuture<anyhow::Result<()>> {
		Box::pin(async move {
			tracing::info!(%actor_id, generation, ?reason, "actor stopped");
			Ok(())
		})
	}

	fn on_shutdown(&self) {
		tracing::info!("envoy shutdown");

		self.is_shutdown.store(true, Ordering::SeqCst);
	}

	fn fetch(
		&self,
		handle: EnvoyHandle,
		actor_id: String,
		_gateway_id: protocol::GatewayId,
		_request_id: protocol::RequestId,
		request: HttpRequest,
	) -> BoxFuture<anyhow::Result<HttpResponse>> {
		Box::pin(async move {
			tracing::debug!(%actor_id, method = %request.method, path = %request.path, "handling fetch");

			match request.path.as_str() {
				"/ping" => {
					let body = serde_json::to_vec(&serde_json::json!({
						"actorId": actor_id,
						"status": "ok",
						"timestamp": std::time::SystemTime::now()
							.duration_since(std::time::UNIX_EPOCH)
							.unwrap_or_default()
							.as_millis() as i64,
					}))?;

					let mut headers = HashMap::new();
					headers.insert("content-type".to_string(), "application/json".to_string());
					headers.insert("content-length".to_string(), body.len().to_string());

					Ok(HttpResponse {
						status: 200,
						headers,
						body: Some(body),
						body_stream: None,
					})
				}
				"/counter" | "/increment" => {
					let Some(actor) = handle.get_actor(&actor_id, None).await else {
						return Ok(text_response(409, "actor generation is not active"));
					};
					if actor.name != COUNTER_ACTOR_NAME {
						return Ok(text_response(
							404,
							"counter endpoint requires a counter actor",
						));
					}

					let sql = match (request.method.as_str(), request.path.as_str()) {
						("GET", "/counter") => COUNTER_READ_SQL,
						("POST", "/increment") => COUNTER_INCREMENT_SQL,
						_ => return Ok(text_response(405, "method not allowed")),
					};
					let result =
						execute_counter_sql(&handle, &actor_id, actor.generation, sql).await?;
					let value = match counter_value(&result)? {
						Some(value) => value,
						None if request.path == "/counter" => 0,
						None => anyhow::bail!("counter update did not return a value"),
					};
					json_response(
						200,
						serde_json::json!({
							"actorId": actor_id,
							"generation": actor.generation,
							"value": value,
						}),
					)
				}
				_ => Ok(text_response(404, "not found")),
			}
		})
	}

	fn websocket(
		&self,
		_handle: EnvoyHandle,
		actor_id: String,
		_gateway_id: protocol::GatewayId,
		_request_id: protocol::RequestId,
		_request: HttpRequest,
		_path: String,
		_headers: HashMap<String, String>,
		_is_hibernatable: bool,
		_is_restoring_hibernatable: bool,
		_sender: rivet_envoy_client::config::WebSocketSender,
	) -> BoxFuture<anyhow::Result<WebSocketHandler>> {
		Box::pin(async move {
			tracing::debug!(%actor_id, "handling websocket");
			Ok(WebSocketHandler {
				on_message: Box::new(move |msg| {
					let text = format!("Echo: {}", String::from_utf8_lossy(&msg.data));
					tracing::debug!(echo = %text, "echoing websocket message");
					msg.sender.send_text(&text);
					Box::pin(async {})
				}),
				on_close: Box::new(|code, reason| {
					Box::pin(async move {
						tracing::debug!(code, %reason, "websocket closed");
					})
				}),
				on_open: None,
			})
		})
	}

	fn can_hibernate(
		&self,
		_actor_id: &str,
		_gateway_id: &protocol::GatewayId,
		_request_id: &protocol::RequestId,
		_request: &HttpRequest,
	) -> rivet_envoy_client::config::BoxFuture<anyhow::Result<bool>> {
		Box::pin(async { Ok(false) })
	}
}

async fn execute_counter_sql(
	handle: &EnvoyHandle,
	actor_id: &str,
	generation: u32,
	sql: &str,
) -> anyhow::Result<protocol::SqliteExecuteResult> {
	let response = handle
		.remote_sqlite_execute(protocol::SqliteExecuteRequest {
			namespace_id: handle.namespace().to_string(),
			actor_id: actor_id.to_string(),
			generation: generation.into(),
			sql: sql.to_string(),
			params: None,
		})
		.await?;

	match response {
		protocol::SqliteExecuteResponse::SqliteExecuteOk(response) => Ok(response.result),
		protocol::SqliteExecuteResponse::SqliteErrorResponse(error) => anyhow::bail!(
			"remote SQLite error {}.{}: {}",
			error.group,
			error.code,
			error.message
		),
	}
}

fn counter_value(result: &protocol::SqliteExecuteResult) -> anyhow::Result<Option<i64>> {
	match result.rows.first().and_then(|row| row.first()) {
		Some(protocol::SqliteColumnValue::SqliteValueInteger(value)) => Ok(Some(value.value)),
		None => Ok(None),
		_ => anyhow::bail!("counter query did not return an integer value"),
	}
}

fn json_response(status: u16, value: serde_json::Value) -> anyhow::Result<HttpResponse> {
	let body = serde_json::to_vec(&value)?;
	let mut headers = HashMap::new();
	headers.insert("content-type".to_string(), "application/json".to_string());
	headers.insert("content-length".to_string(), body.len().to_string());
	Ok(HttpResponse {
		status,
		headers,
		body: Some(body),
		body_stream: None,
	})
}

fn text_response(status: u16, text: &str) -> HttpResponse {
	let body = text.as_bytes().to_vec();
	let mut headers = HashMap::new();
	headers.insert("content-type".to_string(), "text/plain".to_string());
	headers.insert("content-length".to_string(), body.len().to_string());
	HttpResponse {
		status,
		headers,
		body: Some(body),
		body_stream: None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn counter_value_requires_one_integer_cell() {
		let result = protocol::SqliteExecuteResult {
			columns: vec!["value".to_string()],
			rows: vec![vec![protocol::SqliteColumnValue::SqliteValueInteger(
				protocol::SqliteValueInteger { value: 42 },
			)]],
			changes: 1,
			last_insert_row_id: None,
		};
		assert_eq!(counter_value(&result).unwrap(), Some(42));
	}

	#[test]
	fn counter_value_distinguishes_empty_and_fails_closed_for_wrong_type() {
		let empty = protocol::SqliteExecuteResult {
			columns: Vec::new(),
			rows: Vec::new(),
			changes: 0,
			last_insert_row_id: None,
		};
		assert_eq!(counter_value(&empty).unwrap(), None);

		let text = protocol::SqliteExecuteResult {
			columns: vec!["value".to_string()],
			rows: vec![vec![protocol::SqliteColumnValue::SqliteValueText(
				protocol::SqliteValueText {
					value: "42".to_string(),
				},
			)]],
			changes: 0,
			last_insert_row_id: None,
		};
		assert!(counter_value(&text).is_err());
	}
}
