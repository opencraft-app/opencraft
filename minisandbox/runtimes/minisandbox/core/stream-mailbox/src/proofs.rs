//! Kani proof harnesses over the production transition functions.

use crate::{Capability, Limits, MailboxState};

type TinyMailbox = MailboxState<2, 2, 2>;

#[kani::proof]
fn arbitrary_tx_submission_preserves_invariants_and_rejection_atomicity() {
    let mut mailbox = TinyMailbox::new(Limits {
        slot_size: 4,
        max_stream_tx_bytes: 8,
        max_stream_rx_bytes: 8,
    })
    .unwrap();
    let live = mailbox.open_capability(0).unwrap();
    let capability = if kani::any::<bool>() {
        live
    } else {
        Capability {
            index: kani::any(),
            generation: kani::any(),
            session: kani::any(),
        }
    };
    let before = mailbox.clone();
    let result = mailbox.submit_tx(capability, kani::any(), kani::any(), kani::any());
    assert!(mailbox.check_invariants().is_ok());
    if result.is_err() {
        assert_eq!(mailbox, before);
    }
}

#[kani::proof]
fn reset_cannot_finish_while_host_owns_tx() {
    let mut mailbox = TinyMailbox::new(Limits {
        slot_size: 4,
        max_stream_tx_bytes: 8,
        max_stream_rx_bytes: 8,
    })
    .unwrap();
    let capability = mailbox.open_capability(0).unwrap();
    mailbox.submit_tx(capability, 0, 0, 1).unwrap();
    mailbox.begin_reset().unwrap();
    assert!(mailbox.finish_reset().is_err());
    mailbox.cancel_tx(capability, 0).unwrap();
    assert!(mailbox.finish_reset().is_ok());
    assert!(mailbox.check_invariants().is_ok());
}
