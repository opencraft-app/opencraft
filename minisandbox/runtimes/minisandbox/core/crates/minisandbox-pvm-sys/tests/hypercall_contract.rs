//! Minisandbox guest-capability word contract tests.

use minisandbox_pvm_sys::{
    PVM_HYPERCALL_ABI_VERSION, PVM_SERVICE_QUEUE_ALLOWED_MASK, PVM_SERVICE_QUEUE_COMMAND,
    PvmHypercall, PvmServiceQueueSet,
};

#[test]
fn hypercall_words_are_self_identifying_and_versioned() {
    assert_eq!(PVM_HYPERCALL_ABI_VERSION, 1);
    assert_eq!(PvmHypercall::ConsoleWrite.encode(), 0x4d53_0101);
    assert_eq!(PvmHypercall::Exit.encode(), 0x4d53_0102);
    assert_eq!(PvmHypercall::CheckpointReady.encode(), 0x4d53_0103);
    assert_eq!(PvmHypercall::BenchmarkPoint.encode(), 0x4d53_0104);
    assert_eq!(PvmHypercall::PageReport.encode(), 0x4d53_0105);
    assert_eq!(PvmHypercall::ServiceNotify.encode(), 0x4d53_0106);
    assert_eq!(PvmHypercall::WaitUntil.encode(), 0x4d53_0107);
    assert_eq!(
        PvmHypercall::decode(0x4d53_0101),
        Some(PvmHypercall::ConsoleWrite)
    );
    assert_eq!(PvmHypercall::decode(0x4d53_0102), Some(PvmHypercall::Exit));
    assert_eq!(
        PvmHypercall::decode(0x4d53_0103),
        Some(PvmHypercall::CheckpointReady)
    );
    assert_eq!(
        PvmHypercall::decode(0x4d53_0104),
        Some(PvmHypercall::BenchmarkPoint)
    );
    assert_eq!(
        PvmHypercall::decode(0x4d53_0105),
        Some(PvmHypercall::PageReport)
    );
    assert_eq!(
        PvmHypercall::decode(0x4d53_0106),
        Some(PvmHypercall::ServiceNotify)
    );
    assert_eq!(
        PvmHypercall::decode(0x4d53_0107),
        Some(PvmHypercall::WaitUntil)
    );
}

#[test]
fn service_queue_set_rejects_empty_and_unknown_bits() {
    assert_eq!(PVM_SERVICE_QUEUE_ALLOWED_MASK, PVM_SERVICE_QUEUE_COMMAND);
    assert_eq!(PvmServiceQueueSet::from_bits(0), None);
    assert_eq!(PvmServiceQueueSet::from_bits(1 << 63), None);
    let queues = PvmServiceQueueSet::from_bits(PVM_SERVICE_QUEUE_COMMAND).unwrap();
    assert_eq!(queues.bits(), PVM_SERVICE_QUEUE_COMMAND);
}

#[test]
fn malformed_unknown_and_future_hypercalls_are_rejected() {
    for word in [
        0,
        0x4d52_0101,
        0x4d53_0001,
        0x4d53_0201,
        0x4d53_0100,
        0x4d53_01ff,
    ] {
        assert_eq!(PvmHypercall::decode(word), None, "accepted {word:#010x}");
    }
}
