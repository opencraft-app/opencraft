use crate::support;
use serde_json::json;
use std::sync::Arc;
use vela_backends::{
    BackendAdapter, BackendCancel, BackendRouter, BackendSend, MockBackendAdapter,
};
use vela_core::{BackendKind, EventType, ResolvedAgentConfig};

#[tokio::test]
async fn backend_router_dispatches_by_resolved_backend_kind() {
    let pi = Arc::new(MockBackendAdapter::new(vec![
        vela_backends::BackendOutput::event(EventType::TURN_COMPLETED, json!({ "backend": "pi" })),
    ]));
    let codex = Arc::new(MockBackendAdapter::new(vec![
        vela_backends::BackendOutput::event(
            EventType::TURN_COMPLETED,
            json!({ "backend": "codex" }),
        ),
    ]));
    let router = BackendRouter::new()
        .with_backend(BackendKind::Pi, pi.clone())
        .with_backend(BackendKind::Codex, codex.clone());

    let mut input = BackendSend::new("hello pi");
    input.resolved_agent_config = Some(ResolvedAgentConfig {
        backend: BackendKind::Pi,
        config: Default::default(),
    });
    let outputs = support::collect_backend_outputs(&router, input)
        .await
        .unwrap();
    assert_eq!(outputs[0].payload["backend"], "pi");

    let mut input = BackendSend::new("hello codex");
    input.resolved_agent_config = Some(ResolvedAgentConfig {
        backend: BackendKind::Codex,
        config: Default::default(),
    });
    let outputs = support::collect_backend_outputs(&router, input)
        .await
        .unwrap();
    assert_eq!(outputs[0].payload["backend"], "codex");

    assert_eq!(pi.prompt_count().await, 1);
    assert_eq!(codex.prompt_count().await, 1);
}

#[tokio::test]
async fn backend_router_dispatches_probe_and_cancel_by_backend_kind() {
    let pi = Arc::new(MockBackendAdapter::new(vec![]));
    let codex = Arc::new(MockBackendAdapter::new(vec![]));
    let router = BackendRouter::new()
        .with_backend(BackendKind::Pi, pi.clone())
        .with_backend(BackendKind::Codex, codex.clone());

    router
        .probe_backend(Some(BackendKind::Codex))
        .await
        .expect("probe codex");
    router
        .cancel(BackendCancel {
            session_id: "ses_codex".to_string(),
            backend: Some(BackendKind::Codex),
        })
        .await
        .expect("cancel codex");

    assert_eq!(pi.probe_count().await, 0);
    assert_eq!(pi.cancel_count().await, 0);
    assert_eq!(codex.probe_count().await, 1);
    assert_eq!(codex.cancel_count().await, 1);
}
