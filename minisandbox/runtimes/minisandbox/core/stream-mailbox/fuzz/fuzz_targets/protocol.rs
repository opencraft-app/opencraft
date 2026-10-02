#![no_main]

use libfuzzer_sys::fuzz_target;
use pvm_socket_service::{Endpoint, Event};
use pvm_stream_mailbox::{
    Capability, Limits, MailboxState,
    cursor::{ConsumerCursor, ProducerCursor},
    wire::{Command, DESCRIPTOR_SIZE},
};

type FuzzMailbox = MailboxState<4, 4, 4>;

fuzz_target!(|data: &[u8]| {
    let seed = u32::from_le_bytes([
        data.first().copied().unwrap_or(0),
        data.get(1).copied().unwrap_or(0),
        data.get(2).copied().unwrap_or(0),
        data.get(3).copied().unwrap_or(0),
    ]);
    let mut mailbox = FuzzMailbox::new(Limits {
        slot_size: 64,
        max_stream_tx_bytes: 128,
        max_stream_rx_bytes: 128,
    })
    .unwrap();

    if data.len() >= DESCRIPTOR_SIZE {
        let mut descriptor = [0_u8; DESCRIPTOR_SIZE];
        descriptor.copy_from_slice(&data[..DESCRIPTOR_SIZE]);
        if let Ok(command) = Command::decode(&descriptor, mailbox.session()) {
            assert_eq!(
                Command::decode(&command.encode(), mailbox.session()),
                Ok(command)
            );
        }
        if let Ok(event) = Event::decode(&descriptor, mailbox.session()) {
            assert_eq!(Event::decode(&event.encode(), mailbox.session()), Ok(event));
        }
    }

    let _ = Endpoint::decode(data);
    let mut consumer = ConsumerCursor::<4>::from_consumed(seed).unwrap();
    let mut producer = ProducerCursor::<4>::from_counters(seed, seed).unwrap();

    for chunk in data.chunks(16) {
        let byte = |index: usize| chunk.get(index).copied().unwrap_or(0);
        let index = u32::from(byte(1) % 4);
        let raw_capability = Capability {
            index,
            generation: u64::from_le_bytes([
                byte(2),
                byte(3),
                byte(4),
                byte(5),
                byte(6),
                byte(7),
                byte(8),
                byte(9),
            ]),
            session: mailbox.session(),
        };
        let capability = if byte(10) & 1 == 0 {
            mailbox.capability(index).unwrap_or(raw_capability)
        } else {
            raw_capability
        };
        let slot = u16::from(byte(11) % 6);
        let first = u32::from(byte(12));
        let second = u32::from(byte(13));
        let before = mailbox.clone();
        let accepted = match byte(0) % 11 {
            0 => mailbox.open_capability(index).is_ok(),
            1 => mailbox.submit_tx(capability, slot, first, second).is_ok(),
            2 => mailbox
                .complete_tx_progress(capability, slot, first)
                .is_ok(),
            3 => mailbox.cancel_tx(capability, slot).is_ok(),
            4 => mailbox.reserve_rx(capability, slot, first).is_ok(),
            5 => mailbox.complete_rx(capability, slot, first).is_ok(),
            6 => mailbox.cancel_rx(capability, slot).is_ok(),
            7 => mailbox.release_rx(capability, slot).is_ok(),
            8 => mailbox.close_capability(capability).is_ok(),
            9 => mailbox.begin_reset().is_ok(),
            _ => mailbox.finish_reset().is_ok(),
        };
        assert!(mailbox.check_invariants().is_ok());
        if !accepted {
            assert_eq!(mailbox, before, "rejected transition mutated state");
        }

        let peer_cursor =
            u32::from_le_bytes([byte(4), byte(5), byte(6), byte(7)]).wrapping_add(seed);
        if byte(14) & 1 == 0 {
            let before = consumer;
            if let Ok(index) = consumer.consume_one(peer_cursor) {
                assert!(index < 4);
            } else {
                assert_eq!(consumer, before, "rejected consume mutated cursor");
            }
        } else if byte(14) & 2 == 0 {
            let before = producer;
            if producer.observe_consumer(peer_cursor).is_err() {
                assert_eq!(producer, before, "rejected observation mutated cursor");
            }
        } else {
            let before = producer;
            if let Ok(index) = producer.reserve_one() {
                assert!(index < 4);
            } else {
                assert_eq!(producer, before, "rejected reservation mutated cursor");
            }
        }
        assert!(producer.free() <= 4);
    }
});
