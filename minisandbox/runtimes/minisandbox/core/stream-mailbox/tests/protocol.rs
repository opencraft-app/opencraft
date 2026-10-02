use std::collections::HashSet;

use pvm_stream_mailbox::{
    Capability, CloseResult, Limits, MailboxError, MailboxPhase, MailboxState, RxCompletion,
    TxProgress,
};

type TinyMailbox = MailboxState<1, 1, 1>;

fn tiny_mailbox() -> TinyMailbox {
    TinyMailbox::new(Limits {
        slot_size: 2,
        max_stream_tx_bytes: 2,
        max_stream_rx_bytes: 2,
    })
    .unwrap()
}

#[test]
fn tx_rx_close_and_generation_lifecycle() {
    let mut mailbox = tiny_mailbox();
    let first = mailbox.open_capability(0).unwrap();

    let work = mailbox.submit_tx(first, 0, 0, 2).unwrap();
    assert_eq!(work.length, 2);
    assert!(matches!(
        mailbox.complete_tx_progress(first, 0, 1).unwrap(),
        TxProgress::Pending(_)
    ));
    assert_eq!(
        mailbox.complete_tx_progress(first, 0, 1),
        Ok(TxProgress::Complete)
    );

    mailbox.reserve_rx(first, 0, 2).unwrap();
    assert_eq!(
        mailbox.complete_rx(first, 0, 1),
        Ok(RxCompletion::Published { length: 1 })
    );
    assert_eq!(mailbox.close_capability(first), Ok(CloseResult::Draining));
    mailbox.release_rx(first, 0).unwrap();

    let second = mailbox.open_capability(0).unwrap();
    assert_ne!(first.generation, second.generation);
    let before = mailbox.clone();
    assert_eq!(
        mailbox.submit_tx(first, 0, 0, 1),
        Err(MailboxError::StaleCapability)
    );
    assert_eq!(mailbox, before);
}

#[test]
fn reset_waits_for_host_owned_slots_and_invalidates_session() {
    let mut mailbox = tiny_mailbox();
    let capability = mailbox.open_capability(0).unwrap();
    mailbox.submit_tx(capability, 0, 0, 1).unwrap();
    mailbox.begin_reset().unwrap();
    assert_eq!(mailbox.phase(), MailboxPhase::Resetting);
    assert_eq!(mailbox.finish_reset(), Err(MailboxError::NotQuiescent));
    mailbox.cancel_tx(capability, 0).unwrap();
    let session = mailbox.finish_reset().unwrap();
    assert_ne!(session, capability.session);
    assert_eq!(mailbox.phase(), MailboxPhase::Running);

    let before = mailbox.clone();
    assert_eq!(
        mailbox.submit_tx(capability, 0, 0, 1),
        Err(MailboxError::StaleCapability)
    );
    assert_eq!(mailbox, before);
}

#[test]
fn close_or_reset_drops_late_rx_completion() {
    let mut mailbox = tiny_mailbox();
    let capability = mailbox.open_capability(0).unwrap();
    mailbox.reserve_rx(capability, 0, 2).unwrap();
    assert_eq!(
        mailbox.close_capability(capability),
        Ok(CloseResult::Draining)
    );
    assert_eq!(
        mailbox.complete_rx(capability, 0, 1),
        Ok(RxCompletion::Dropped)
    );
    assert!(mailbox.capability(0).is_none());
}

#[test]
fn invalid_transition_is_atomic() {
    let mut mailbox = tiny_mailbox();
    let capability = mailbox.open_capability(0).unwrap();
    mailbox.submit_tx(capability, 0, 0, 2).unwrap();
    let before = mailbox.clone();
    assert_eq!(
        mailbox.complete_tx_progress(capability, 0, 3),
        Err(MailboxError::InvalidProgress)
    );
    assert_eq!(mailbox, before);
    mailbox.check_invariants().unwrap();
}

#[test]
fn exhausted_session_fails_closed_without_wrapping() {
    let mut mailbox = TinyMailbox::new_in_session(
        Limits {
            slot_size: 2,
            max_stream_tx_bytes: 2,
            max_stream_rx_bytes: 2,
        },
        u64::MAX,
    )
    .unwrap();
    mailbox.begin_reset().unwrap();
    let before = mailbox.clone();
    assert_eq!(mailbox.finish_reset(), Err(MailboxError::SessionExhausted));
    assert_eq!(mailbox, before);
    mailbox.check_invariants().unwrap();
}

#[test]
fn bounded_state_space_preserves_invariants() {
    let mut frontier = HashSet::from([tiny_mailbox()]);
    let mut visited = frontier.clone();

    for _depth in 0..10 {
        let mut next = HashSet::new();
        for state in frontier {
            for successor in successors(&state) {
                successor.check_invariants().unwrap();
                if visited.insert(successor.clone()) {
                    next.insert(successor);
                }
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }

    assert!(
        visited.len() > 20,
        "model exploration was unexpectedly shallow"
    );
}

fn successors(state: &TinyMailbox) -> Vec<TinyMailbox> {
    let mut states = Vec::new();
    attempt(state, &mut states, |mailbox| {
        mailbox.open_capability(0).map(|_| ())
    });
    if let Some(capability) = state.capability(0) {
        for length in [1, 2] {
            attempt(state, &mut states, |mailbox| {
                mailbox.submit_tx(capability, 0, 0, length).map(|_| ())
            });
            attempt(state, &mut states, |mailbox| {
                mailbox.reserve_rx(capability, 0, length).map(|_| ())
            });
            attempt(state, &mut states, |mailbox| {
                mailbox
                    .complete_tx_progress(capability, 0, length)
                    .map(|_| ())
            });
            attempt(state, &mut states, |mailbox| {
                mailbox.complete_rx(capability, 0, length).map(|_| ())
            });
        }
        attempt(state, &mut states, |mailbox| {
            mailbox.complete_rx(capability, 0, 0).map(|_| ())
        });
        attempt(state, &mut states, |mailbox| {
            mailbox.release_rx(capability, 0)
        });
        attempt(state, &mut states, |mailbox| {
            mailbox.cancel_tx(capability, 0)
        });
        attempt(state, &mut states, |mailbox| {
            mailbox.cancel_rx(capability, 0)
        });
        attempt(state, &mut states, |mailbox| {
            mailbox.close_capability(capability).map(|_| ())
        });
    }
    attempt(state, &mut states, MailboxState::begin_reset);
    attempt(state, &mut states, |mailbox| {
        mailbox.finish_reset().map(|_| ())
    });

    let forged_capability = Capability {
        index: 0,
        generation: u64::MAX,
        session: state.session(),
    };
    let mut rejected = state.clone();
    if rejected.submit_tx(forged_capability, 0, 0, 1).is_err() {
        assert_eq!(&rejected, state);
    }
    states
}

fn attempt(
    original: &TinyMailbox,
    output: &mut Vec<TinyMailbox>,
    transition: impl FnOnce(&mut TinyMailbox) -> Result<(), MailboxError>,
) {
    let mut candidate = original.clone();
    match transition(&mut candidate) {
        Ok(()) => output.push(candidate),
        Err(_) => assert_eq!(&candidate, original, "rejected transition mutated state"),
    }
}
