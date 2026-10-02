//! Durable-core and consistency-behavior tests for the COS emulator.

use std::{fs::OpenOptions, io::Write};

use minisandbox_cos_emulator::{
    ByteRange, CosEmulator, DataOperation, DataRequest, EmulatorError, FaultAction, ScriptRequest,
    Visibility, VisibilityRequest, verify_history,
};
use tempfile::TempDir;

const BUCKET: &str = "test-1250000000";
const KEY: &str = "extent/sha256/abc";

fn request(
    operation: DataOperation,
    access_path: &str,
    body: &[u8],
    range: Option<ByteRange>,
) -> DataRequest {
    keyed_request(operation, KEY, access_path, body, range)
}

fn keyed_request(
    operation: DataOperation,
    key: &str,
    access_path: &str,
    body: &[u8],
    range: Option<ByteRange>,
) -> DataRequest {
    DataRequest {
        operation,
        bucket: BUCKET.to_owned(),
        key: key.to_owned(),
        access_path: access_path.to_owned(),
        body: body.to_vec(),
        range,
    }
}

#[test]
fn observation_cross_product_matches_the_weak_consistency_oracle() {
    let directory = TempDir::new().expect("temporary directory");
    let mut emulator = CosEmulator::open(directory.path()).expect("open emulator");
    let visibilities = [Visibility::Visible, Visibility::Hidden, Visibility::Stale];
    let actions = [
        FaultAction::Normal,
        FaultAction::NotFound,
        FaultAction::Stale,
        FaultAction::Corrupt,
        FaultAction::Timeout { delay_ms: 0 },
    ];
    for live in [false, true] {
        for visibility in visibilities {
            for (action_index, action) in actions.iter().enumerate() {
                let key = format!("matrix/{live}/{visibility:?}/{action_index}");
                emulator
                    .execute(keyed_request(
                        DataOperation::Put,
                        &key,
                        "writer",
                        b"canonical",
                        None,
                    ))
                    .expect("matrix put");
                emulator
                    .set_visibility(VisibilityRequest {
                        access_path: "reader".to_owned(),
                        bucket: BUCKET.to_owned(),
                        key: key.clone(),
                        visibility,
                    })
                    .expect("matrix visibility");
                if !live {
                    emulator
                        .execute(keyed_request(
                            DataOperation::Delete,
                            &key,
                            "writer",
                            b"",
                            None,
                        ))
                        .expect("matrix delete");
                }
                emulator
                    .enqueue_script(ScriptRequest {
                        access_path: "reader".to_owned(),
                        operation: DataOperation::Get,
                        bucket: BUCKET.to_owned(),
                        key: key.clone(),
                        actions: vec![action.clone()],
                    })
                    .expect("matrix script");
                let response = emulator
                    .execute(keyed_request(DataOperation::Get, &key, "reader", b"", None))
                    .expect("matrix observation");
                let expected = match action {
                    FaultAction::Timeout { .. } => 504,
                    FaultAction::Stale | FaultAction::Corrupt => 200,
                    FaultAction::Normal
                        if visibility == Visibility::Stale
                            || (live && visibility == Visibility::Visible) =>
                    {
                        200
                    }
                    FaultAction::NotFound | FaultAction::Normal => 404,
                    FaultAction::TimeoutBeforeApply { .. }
                    | FaultAction::TimeoutAfterApply { .. } => unreachable!("matrix actions"),
                };
                assert_eq!(
                    response.status, expected,
                    "{live} {visibility:?} {action:?}"
                );
            }
        }
    }
    verify_history(emulator.history()).expect("matrix history invariants");
}

#[test]
fn immutable_truth_visibility_range_and_restart() {
    let directory = TempDir::new().expect("temporary directory");
    let mut emulator = CosEmulator::open(directory.path()).expect("open emulator");
    assert!(matches!(
        CosEmulator::open(directory.path()),
        Err(EmulatorError::AlreadyOpen)
    ));

    let put = emulator
        .execute(request(DataOperation::Put, "access-a", b"abcdef", None))
        .expect("put");
    assert_eq!(put.status, 200);
    assert_eq!(
        emulator
            .execute(request(DataOperation::Get, "access-a", b"", None))
            .expect("visible get")
            .body,
        b"abcdef"
    );
    assert_eq!(
        emulator
            .execute(request(DataOperation::Head, "access-b", b"", None))
            .expect("hidden head")
            .status,
        404
    );

    emulator
        .set_visibility(VisibilityRequest {
            access_path: "access-b".to_owned(),
            bucket: BUCKET.to_owned(),
            key: KEY.to_owned(),
            visibility: Visibility::Visible,
        })
        .expect("propagate visibility");
    let range = emulator
        .execute(request(
            DataOperation::Get,
            "access-b",
            b"",
            Some(ByteRange::Inclusive { start: 1, end: 3 }),
        ))
        .expect("range get");
    assert_eq!(range.status, 206);
    assert_eq!(range.body, b"bcd");
    assert_eq!(range.headers["content-range"], "bytes 1-3/6");
    assert_eq!(
        emulator
            .execute(request(
                DataOperation::Get,
                "access-b",
                b"",
                Some(ByteRange::Suffix { length: 2 }),
            ))
            .expect("suffix range")
            .body,
        b"ef"
    );
    assert_eq!(
        emulator
            .execute(request(
                DataOperation::Get,
                "access-b",
                b"",
                Some(ByteRange::From { start: 99 }),
            ))
            .expect("unsatisfiable range")
            .status,
        416
    );

    let conflict = emulator
        .execute(request(DataOperation::Put, "access-a", b"different", None))
        .expect("conflict is a response");
    assert_eq!(conflict.status, 409);
    assert!(!emulator.history().last().expect("conflict history").applied);
    verify_history(emulator.history()).expect("history invariants");
    let history_len = emulator.history().len();
    drop(emulator);

    let mut recovered = CosEmulator::open(directory.path()).expect("recover emulator");
    assert_eq!(recovered.history().len(), history_len);
    assert_eq!(
        recovered
            .execute(request(DataOperation::Get, "access-b", b"", None))
            .expect("visibility survived")
            .body,
        b"abcdef"
    );
    verify_history(recovered.history()).expect("recovered history invariants");
}

#[test]
fn delete_can_remain_stale_on_an_independent_path() {
    let directory = TempDir::new().expect("temporary directory");
    let mut emulator = CosEmulator::open(directory.path()).expect("open emulator");
    emulator
        .execute(request(DataOperation::Put, "access-a", b"payload", None))
        .expect("put");
    emulator
        .set_visibility(VisibilityRequest {
            access_path: "access-b".to_owned(),
            bucket: BUCKET.to_owned(),
            key: KEY.to_owned(),
            visibility: Visibility::Stale,
        })
        .expect("stale access");
    assert_eq!(
        emulator
            .execute(request(DataOperation::Delete, "access-a", b"", None))
            .expect("delete")
            .status,
        204
    );
    assert_eq!(
        emulator
            .execute(request(DataOperation::Get, "access-a", b"", None))
            .expect("deleting access")
            .status,
        404
    );
    let stale = emulator
        .execute(request(DataOperation::Get, "access-b", b"", None))
        .expect("stale read");
    assert_eq!(stale.status, 200);
    assert_eq!(stale.body, b"payload");
    emulator
        .enqueue_script(ScriptRequest {
            access_path: "access-c".to_owned(),
            operation: DataOperation::Get,
            bucket: BUCKET.to_owned(),
            key: KEY.to_owned(),
            actions: vec![FaultAction::Stale],
        })
        .expect("forced stale script");
    assert_eq!(
        emulator
            .execute(request(DataOperation::Get, "access-c", b"", None))
            .expect("forced stale read")
            .body,
        b"payload"
    );
    verify_history(emulator.history()).expect("history invariants");
}

#[test]
fn scripted_observations_and_unknown_put_outcomes_are_deterministic() {
    let directory = TempDir::new().expect("temporary directory");
    let mut emulator = CosEmulator::open(directory.path()).expect("open emulator");
    emulator
        .enqueue_script(ScriptRequest {
            access_path: "access-a".to_owned(),
            operation: DataOperation::Put,
            bucket: BUCKET.to_owned(),
            key: KEY.to_owned(),
            actions: vec![FaultAction::TimeoutAfterApply { delay_ms: 7 }],
        })
        .expect("put script");
    let unknown = emulator
        .execute(request(DataOperation::Put, "access-a", b"payload", None))
        .expect("unknown put");
    assert_eq!(unknown.status, 504);
    assert_eq!(unknown.delay_ms, 7);
    assert!(emulator.history().last().expect("put history").applied);

    emulator
        .enqueue_script(ScriptRequest {
            access_path: "access-a".to_owned(),
            operation: DataOperation::Get,
            bucket: BUCKET.to_owned(),
            key: KEY.to_owned(),
            actions: vec![
                FaultAction::NotFound,
                FaultAction::Corrupt,
                FaultAction::Timeout { delay_ms: 3 },
                FaultAction::Normal,
            ],
        })
        .expect("get script");
    assert_eq!(
        emulator
            .execute(request(DataOperation::Get, "access-a", b"", None))
            .expect("not found")
            .status,
        404
    );
    let corrupt = emulator
        .execute(request(DataOperation::Get, "access-a", b"", None))
        .expect("corrupt");
    assert_eq!(corrupt.status, 200);
    assert_ne!(corrupt.body, b"payload");
    let timeout = emulator
        .execute(request(DataOperation::Get, "access-a", b"", None))
        .expect("timeout");
    assert_eq!(timeout.status, 504);
    assert_eq!(timeout.delay_ms, 3);
    assert_eq!(
        emulator
            .execute(request(DataOperation::Get, "access-a", b"", None))
            .expect("normal")
            .body,
        b"payload"
    );
    verify_history(emulator.history()).expect("history invariants");
    let mut forged = emulator.history().to_vec();
    let corrupt = forged
        .iter_mut()
        .find(|event| event.action == FaultAction::Corrupt)
        .expect("corrupt event");
    corrupt.response_sha256.clone_from(&corrupt.source_sha256);
    assert!(verify_history(&forged).is_err());
}

#[test]
fn scripts_are_consumed_once_and_persist_across_restart() {
    let directory = TempDir::new().expect("temporary directory");
    let mut emulator = CosEmulator::open(directory.path()).expect("open emulator");
    emulator
        .execute(request(DataOperation::Put, "access-a", b"payload", None))
        .expect("put");
    emulator
        .enqueue_script(ScriptRequest {
            access_path: "access-a".to_owned(),
            operation: DataOperation::Get,
            bucket: BUCKET.to_owned(),
            key: KEY.to_owned(),
            actions: vec![FaultAction::NotFound, FaultAction::Corrupt],
        })
        .expect("script");
    drop(emulator);

    let mut emulator = CosEmulator::open(directory.path()).expect("first restart");
    assert_eq!(
        emulator
            .execute(request(DataOperation::Get, "access-a", b"", None))
            .expect("first scripted observation")
            .status,
        404
    );
    drop(emulator);

    let mut emulator = CosEmulator::open(directory.path()).expect("second restart");
    let corrupt = emulator
        .execute(request(DataOperation::Get, "access-a", b"", None))
        .expect("second scripted observation");
    assert_eq!(corrupt.status, 200);
    assert_ne!(corrupt.body, b"payload");
    assert_eq!(
        emulator
            .execute(request(DataOperation::Get, "access-a", b"", None))
            .expect("script exhausted")
            .body,
        b"payload"
    );
    verify_history(emulator.history()).expect("history invariants");
}

#[test]
fn timeout_after_delete_applies_before_the_failed_reply() {
    let directory = TempDir::new().expect("temporary directory");
    let mut emulator = CosEmulator::open(directory.path()).expect("open emulator");
    emulator
        .execute(request(DataOperation::Put, "access-a", b"payload", None))
        .expect("put");
    emulator
        .enqueue_script(ScriptRequest {
            access_path: "access-a".to_owned(),
            operation: DataOperation::Delete,
            bucket: BUCKET.to_owned(),
            key: KEY.to_owned(),
            actions: vec![FaultAction::TimeoutAfterApply { delay_ms: 2 }],
        })
        .expect("delete script");
    let delete = emulator
        .execute(request(DataOperation::Delete, "access-a", b"", None))
        .expect("unknown delete");
    assert_eq!(delete.status, 504);
    assert_eq!(delete.delay_ms, 2);
    assert!(emulator.history().last().expect("delete event").applied);
    assert_eq!(
        emulator
            .execute(request(DataOperation::Get, "access-a", b"", None))
            .expect("deleted object")
            .status,
        404
    );
    verify_history(emulator.history()).expect("history invariants");
}

#[test]
fn timeout_before_apply_does_not_create_an_object() {
    let directory = TempDir::new().expect("temporary directory");
    let mut emulator = CosEmulator::open(directory.path()).expect("open emulator");
    emulator
        .enqueue_script(ScriptRequest {
            access_path: "access-a".to_owned(),
            operation: DataOperation::Put,
            bucket: BUCKET.to_owned(),
            key: KEY.to_owned(),
            actions: vec![FaultAction::TimeoutBeforeApply { delay_ms: 1 }],
        })
        .expect("put script");
    let timeout = emulator
        .execute(request(DataOperation::Put, "access-a", b"payload", None))
        .expect("timeout");
    assert_eq!(timeout.status, 504);
    assert!(!emulator.history().last().expect("history").applied);
    assert_eq!(
        emulator
            .execute(request(DataOperation::Get, "access-a", b"", None))
            .expect("absent")
            .status,
        404
    );
    verify_history(emulator.history()).expect("history invariants");
}

#[test]
fn payload_corruption_fails_closed_on_restart() {
    let directory = TempDir::new().expect("temporary directory");
    let mut emulator = CosEmulator::open(directory.path()).expect("open emulator");
    emulator
        .execute(request(DataOperation::Put, "access-a", b"payload", None))
        .expect("put");
    drop(emulator);

    let payload_path = std::fs::read_dir(directory.path().join("objects"))
        .expect("read objects")
        .map(|entry| entry.expect("object entry").path())
        .find(|path| path.extension().is_some_and(|extension| extension == "bin"))
        .expect("payload path");
    let mut payload = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(payload_path)
        .expect("open payload");
    payload.write_all(b"corrupt").expect("corrupt payload");
    payload.sync_all().expect("sync corruption");
    assert!(CosEmulator::open(directory.path()).is_err());
}

#[test]
fn pending_history_is_recovered_and_deduplicated() {
    for history_already_appended in [false, true] {
        let directory = TempDir::new().expect("temporary directory");
        let mut emulator = CosEmulator::open(directory.path()).expect("open emulator");
        emulator
            .execute(request(DataOperation::Put, "access-a", b"payload", None))
            .expect("put");
        drop(emulator);

        let history_path = directory.path().join("history.jsonl");
        let history_line = std::fs::read_to_string(&history_path).expect("read history");
        let pending: serde_json::Value =
            serde_json::from_str(history_line.trim()).expect("history event");
        let state_path = directory.path().join("state.json");
        let mut state: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&state_path).expect("read state"))
                .expect("state JSON");
        state["pending_history"] = pending;
        std::fs::write(
            &state_path,
            serde_json::to_vec(&state).expect("serialize pending state"),
        )
        .expect("write pending state");
        if !history_already_appended {
            OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&history_path)
                .expect("truncate history");
        }

        let recovered = CosEmulator::open(directory.path()).expect("recover pending history");
        assert_eq!(recovered.history().len(), 1);
        verify_history(recovered.history()).expect("recovered history invariants");
        drop(recovered);
        let state: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(state_path).expect("read recovered state"),
        )
        .expect("recovered state JSON");
        assert!(state["pending_history"].is_null());
    }
}
