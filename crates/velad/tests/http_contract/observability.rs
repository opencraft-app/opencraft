use super::*;

#[tokio::test]
async fn openapi_documents_local_observability_contract() {
    let openapi = include_str!("../../../../public/openapi/velachat.v1.yaml");

    assert!(openapi.contains("  /v1/traces:"));
    assert!(openapi.contains("  /v1/logs:"));
    assert!(openapi.contains("  /observability/status:"));
    assert!(openapi.contains("  /observability/recent-errors:"));
    assert!(openapi.contains("  /observability/traces/{trace_id}:"));
    assert!(openapi.contains("operationId: ingestOtlpJsonTraces"));
    assert!(openapi.contains("operationId: getObservabilityTrace"));
    assert!(openapi.contains("enum: [otlp.http.json]"));
}

#[tokio::test]
async fn otlp_trace_ingest_is_queryable_locally() {
    let app = test_app_with_observability().await;

    let (status, summary) = json_request(
        app.clone(),
        Method::POST,
        "/v1/traces",
        sample_trace_payload(),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(summary["accepted"], true);
    assert_eq!(summary["spans"], 1);

    let (status, trace) = get_json(
        app.clone(),
        "/api/v1/observability/traces/4bf92f3577b34da6a3ce929d0e0e4736",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(trace["trace_id"], "4bf92f3577b34da6a3ce929d0e0e4736");
    assert_eq!(trace["spans"][0]["name"], "codex.thread_start");
    assert_eq!(trace["spans"][0]["backend"], "codex");
    assert_eq!(trace["spans"][0]["session_id"], "ses_1");
    assert_eq!(trace["spans"][0]["error_message"], "failed to fetch");

    let (status, errors) = get_json(app, "/api/v1/observability/recent-errors?limit=5").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(errors["errors"][0]["source"], "span");
    assert_eq!(errors["errors"][0]["message"], "failed to fetch");
}

#[tokio::test]
async fn otlp_log_ingest_is_queryable_as_recent_error() {
    let app = test_app_with_observability().await;

    let (status, summary) = json_request(
        app.clone(),
        Method::POST,
        "/v1/logs",
        sample_log_payload(),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(summary["accepted"], true);
    assert_eq!(summary["logs"], 1);

    let (status, errors) = get_json(app, "/api/v1/observability/recent-errors").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(errors["errors"][0]["source"], "log");
    assert_eq!(
        errors["errors"][0]["message"],
        "Codex app-server thread/start failed"
    );
}

#[tokio::test]
async fn observability_routes_are_explicit_when_store_is_not_configured() {
    let app = test_app().await;

    let (status, body) = get_json(app, "/api/v1/observability/status").await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["code"], "observability_unavailable");
}

#[tokio::test]
async fn traceparent_links_create_send_and_backend_boundary_spans() {
    let app = test_app_with_observability().await;
    let traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    let (status, created) = json_request_with_headers(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({
            "backend": "pi",
            "working_directory": "/tmp/project"
        }),
        Some("trace-session"),
        &[("traceparent", traceparent)],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let session_id = created["session"]["id"].as_str().unwrap();

    let (status, _) = json_request_with_headers(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({
            "events": [{
                "type": "user.message",
                "content": [{ "type": "text", "text": "ping" }]
            }]
        }),
        Some("trace-message"),
        &[("traceparent", traceparent)],
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    wait_for_session_event(app.clone(), session_id, "turn.completed").await;

    let (status, trace) = get_json(
        app,
        "/api/v1/observability/traces/4bf92f3577b34da6a3ce929d0e0e4736",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let span_names = trace["spans"]
        .as_array()
        .unwrap()
        .iter()
        .map(|span| span["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(span_names.contains(&"velad.session.create"));
    assert!(span_names.contains(&"velad.session.send_events"));
    assert!(span_names.contains(&"velad.backend.send"));
}

#[tokio::test]
async fn backend_diagnostics_are_recorded_as_trace_spans_without_persisting_chat_events() {
    let app = test_app_with_observability_outputs(vec![
        BackendOutput::event(
            EventType::WARNING_RAISED,
            json!({
                "code": "codex_app_server_trace",
                "name": "codex.app_server.thread_start",
                "method": "thread/start",
                "duration_ms": 2.5,
                "status_code": "OK",
                "error_message": null,
                "attributes": {
                    "codex.thread_id": "thr_1"
                }
            }),
        ),
        BackendOutput::event(EventType::TURN_COMPLETED, json!({ "ok": true })),
    ])
    .await;
    let traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    let (status, created) = json_request_with_headers(
        app.clone(),
        Method::POST,
        "/api/v1/sessions",
        json!({
            "backend": "pi",
            "working_directory": "/tmp/project"
        }),
        Some("diagnostic-session"),
        &[("traceparent", traceparent)],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let session_id = created["session"]["id"].as_str().unwrap();

    let (status, _) = json_request_with_headers(
        app.clone(),
        Method::POST,
        &format!("/api/v1/sessions/{session_id}/events"),
        json!({
            "events": [{
                "type": "user.message",
                "content": [{ "type": "text", "text": "ping" }]
            }]
        }),
        Some("diagnostic-message"),
        &[("traceparent", traceparent)],
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    wait_for_session_event(app.clone(), session_id, "turn.completed").await;

    let (status, trace) = get_json(
        app.clone(),
        "/api/v1/observability/traces/4bf92f3577b34da6a3ce929d0e0e4736",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        trace["spans"]
            .as_array()
            .unwrap()
            .iter()
            .any(|span| span["name"] == "codex.app_server.thread_start"
                && span["attributes"]["codex.method"] == "thread/start")
    );

    let (status, events) = get_json(app, &format!("/api/v1/sessions/{session_id}/events")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        events["events"]
            .as_array()
            .unwrap()
            .iter()
            .all(|event| event["payload"]["code"] != "codex_app_server_trace")
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
