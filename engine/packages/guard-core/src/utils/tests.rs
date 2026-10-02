use hyper::header::HeaderValue;

use crate::errors::{ActorStoppedWhileWaitingForWebSocketOpen, ActorWakeRetriesExceeded};

use super::*;

#[test]
fn retries_guard_actor_ready_timeout_response() {
	let mut headers = hyper::HeaderMap::new();
	headers.insert(
		X_RIVET_ERROR,
		HeaderValue::from_static("guard.actor_ready_timeout"),
	);

	assert!(should_retry_request_inner(
		StatusCode::SERVICE_UNAVAILABLE,
		&headers,
	));
}

#[test]
fn wake_retry_exhaustion_is_retryable_overload() {
	let response = err_into_response(
		ActorWakeRetriesExceeded {
			actor_id: "actor-capacity".to_owned(),
			wake_retries: 8,
			reason: "actor_stopped_before_ready".to_owned(),
		}
		.build(),
	)
	.expect("build response");

	assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
	assert_eq!(
		response.headers().get(X_RIVET_ERROR),
		Some(&HeaderValue::from_static(
			"guard.actor_wake_retries_exceeded"
		))
	);
	assert_eq!(
		response.headers().get(hyper::header::RETRY_AFTER),
		Some(&HeaderValue::from_static("1"))
	);
	assert!(should_retry_request_inner(
		response.status(),
		response.headers()
	));
}

#[test]
fn skips_service_unavailable_without_rivet_error_header() {
	let headers = hyper::HeaderMap::new();

	assert!(!should_retry_request_inner(
		StatusCode::SERVICE_UNAVAILABLE,
		&headers,
	));
}

#[test]
fn skips_non_service_unavailable_with_rivet_error_header() {
	let mut headers = hyper::HeaderMap::new();
	headers.insert(X_RIVET_ERROR, HeaderValue::from_static("guard.no_route"));

	assert!(!should_retry_request_inner(StatusCode::NOT_FOUND, &headers));
}

#[test]
fn retries_websocket_route_when_actor_stops_before_open() {
	let err = ActorStoppedWhileWaitingForWebSocketOpen {
		actor_id: "actor-reallocated".to_owned(),
		phase: "pre_websocket_open".to_owned(),
	}
	.build();

	assert!(is_retryable_ws_error(&err));
}
